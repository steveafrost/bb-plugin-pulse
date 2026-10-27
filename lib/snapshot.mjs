// Pulse mirror reader.
//
// The iPhone app owns the data. It publishes a snapshot envelope
// (docs/DATA-CONTRACT.md in steveafrost/pulse-ios) into its iCloud container;
// this module reads that file and never writes it. Everything the panel renders
// comes through `readSnapshot()`.
//
// Directory resolution order:
//   1. PULSE_SNAPSHOT_DIR          explicit, wins everywhere (tests use this)
//   2. PULSE_HOME                  the contract's Mac-side override
//   3. ~/Library/Mobile Documents/iCloud~com~steveafrost~pulse/Documents/Pulse
//      (macOS iCloud ubiquity container)
//
// `readSnapshot()` is total: a missing file, malformed JSON, or a snapshot from
// a newer app all come back as a typed state, never an exception. A reader must
// never write the file, so a parse failure cannot corrupt it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Highest `schemaVersion` this build understands (contract v1). */
export const SUPPORTED_SCHEMA_VERSION = 1;

export const DEFAULT_ICLOUD_DIR = path.join(
  os.homedir(),
  "Library/Mobile Documents/iCloud~com~steveafrost~pulse/Documents/Pulse",
);

/** The first non-empty string among the candidates, else null. */
const firstSet = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

/** Where the iOS app writes its transport files. See the resolution order above. */
export function resolveMirrorDir(env = process.env) {
  const explicit = firstSet(env.PULSE_SNAPSHOT_DIR);
  if (explicit) return explicit;
  const home = firstSet(env.PULSE_HOME);
  if (home) return home;
  return DEFAULT_ICLOUD_DIR;
}

export function snapshotPath(dir = resolveMirrorDir()) {
  return path.join(dir, "snapshot.json");
}

/**
 * The panel's item shape (types.ts). The contract keeps the field names
 * identical on purpose, so this only fills defaults for absent optional fields
 * and preserves every other key verbatim — unknown keys survive the read rather
 * than being dropped.
 */
function asItem(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  return {
    source: "other",
    kind: "followup",
    title: "",
    detail: "",
    url: null,
    due: null,
    priority: "normal",
    people: [],
    status: "open",
    snoozedUntil: null,
    resolution: null,
    firstSeenAt: null,
    lastSeenAt: null,
    updatedAt: null,
    resolvedAt: null,
    lastChangedBy: "capture",
    history: [],
    quickActions: [],
    action: null,
    ...raw,
  };
}

/**
 * Effective status, per the contract's state machine: an expired snooze reads
 * back as open. `at` is an ISO instant (defaults to now).
 */
export function effectiveStatus(item, at = new Date().toISOString()) {
  if (item.status === "snoozed" && item.snoozedUntil && item.snoozedUntil <= at) return "open";
  return item.status;
}

/** The blank result used whenever there is nothing readable to render. */
function empty(state, dir, extra = {}) {
  return {
    state,
    dir,
    file: snapshotPath(dir),
    schemaVersion: null,
    generatedAt: null,
    deviceName: null,
    lastViewedAt: null,
    items: [],
    runs: [],
    draft: null,
    message: null,
    ...extra,
  };
}

/**
 * Read and validate the snapshot.
 *
 * - missing file           -> { state: "not-connected" }
 * - malformed JSON         -> { state: "error", message }   (file untouched)
 * - schemaVersion > build  -> { state: "update", schemaVersion }
 * - otherwise              -> { state: "connected", items, runs, ... }
 *
 * Passing `dir` keeps every test off iCloud.
 */
export function readSnapshot({ dir = resolveMirrorDir() } = {}) {
  const file = snapshotPath(dir);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return empty("not-connected", dir, { message: "Open Pulse on your iPhone to connect." });
    }
    return empty("error", dir, { message: `Cannot read ${file}: ${error?.message ?? String(error)}` });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Never rewrite the file: surface the parse message and leave it alone.
    return empty("error", dir, { message: `${file} is not valid JSON: ${error?.message ?? String(error)}` });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return empty("error", dir, { message: `${file} is not a snapshot object` });
  }

  const rawVersion = parsed.schemaVersion;
  const schemaVersion = Number.isInteger(rawVersion) ? rawVersion : SUPPORTED_SCHEMA_VERSION;
  if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    // Refuse, do not partially render: a newer app may have removed or retyped
    // fields this build would misread.
    return empty("update", dir, {
      schemaVersion,
      message: `This snapshot is schemaVersion ${schemaVersion}; this plugin supports ${SUPPORTED_SCHEMA_VERSION}. Update the Pulse iOS app or the Pulse plugin.`,
    });
  }

  const items = Array.isArray(parsed.items) ? parsed.items.map(asItem).filter(Boolean) : [];
  return {
    state: "connected",
    dir,
    file,
    schemaVersion,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
    deviceName: typeof parsed.deviceName === "string" ? parsed.deviceName : null,
    lastViewedAt: typeof parsed.lastViewedAt === "string" ? parsed.lastViewedAt : null,
    items,
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    draft: parsed.draft ?? null,
    message: null,
  };
}

/** The identity of a read, for "did anything actually change?" comparisons. */
export function snapshotKey(result) {
  const detail = result.generatedAt ?? result.schemaVersion ?? result.message ?? "";
  return `${result.state}|${detail}`;
}

/**
 * Poll a directory and call `onChange` only when the read's identity moves.
 * The server drives this on a 5 s interval (the contract's default) and also
 * checks it on an FSEvents change; an unchanged `generatedAt` reloads nothing.
 */
export function createMirrorPoller({ dir = resolveMirrorDir(), read = readSnapshot, onChange } = {}) {
  let lastKey = null;
  return {
    /** Returns true when the snapshot changed and `onChange` was called. */
    poll() {
      const result = read({ dir });
      const key = snapshotKey(result);
      if (key === lastKey) return false;
      lastKey = key;
      onChange?.(result);
      return true;
    },
    /** Drop the remembered identity so the next poll counts as a change. */
    reset() {
      lastKey = null;
    },
    get key() {
      return lastKey;
    },
  };
}

/** Test/support helper: write a snapshot in the envelope the iOS app writes. */
export function writeSnapshotFixture(dir, snapshot) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.snapshot.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
  fs.renameSync(tmp, snapshotPath(dir));
}
