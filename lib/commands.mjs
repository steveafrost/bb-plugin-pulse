// Third Hand mirror command writer.
//
// The plugin never authors items and never writes snapshot.json. A user action
// in the panel becomes one line in `commands.jsonl`; the iOS app reads it,
// applies the transition to its own store, and republishes the snapshot.
//
// Contract (docs/DATA-CONTRACT.md, step 3):
//   {"id":"<uuid>","at":"<ISO>","op":"done|dismiss|snooze|reopen",
//    "itemId":"...","until":"<ISO|null>","reason":"<string|null>"}
//
// Files, all under the mirror directory:
//   commands.jsonl       plugin -> iOS. Append-only.
//   commands.ack.jsonl   iOS -> plugin. Ids the app consumed: `{"id": "..."}`.
//   commands.pending.json  local bookkeeping, so the plugin can drop acked ids
//                          without re-reading the whole log. Not part of the
//                          contract; losing it is harmless (the ack file wins).
//
// Pending set semantics:
//   - An id enters the set when it is appended.
//   - An action already pending for the same item + op + until is not queued
//     twice (a double-click must not produce two commands).
//   - `dropAcked()` removes ids present in commands.ack.jsonl.
//   - commands.jsonl is compacted when it exceeds COMPACT_BYTES or when every
//     line in it is acked; compaction rewrites tmp + rename so iOS never reads a
//     half-written log.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMirrorDir } from "./snapshot.mjs";

export const OPS = ["done", "dismiss", "snooze", "reopen"];
/** 5 MB, from the issue's compaction rule. */
export const COMPACT_BYTES = 5 * 1024 * 1024;

export function mirrorPaths(dir = resolveMirrorDir()) {
  return {
    dir,
    snapshot: path.join(dir, "snapshot.json"),
    commands: path.join(dir, "commands.jsonl"),
    ack: path.join(dir, "commands.ack.jsonl"),
    pending: path.join(dir, "commands.pending.json"),
  };
}

const readLines = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.trim());
};

const parseLines = (lines) =>
  lines.flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });

/** Ids the iOS app has consumed. A malformed ack line is skipped, never fatal. */
export function ackedIds(dir = resolveMirrorDir()) {
  const { ack } = mirrorPaths(dir);
  return new Set(parseLines(readLines(ack)).map((row) => row.id).filter((id) => typeof id === "string"));
}

/** The local pending queue, as written by this module. */
export function readPending(dir = resolveMirrorDir()) {
  const { pending } = mirrorPaths(dir);
  try {
    const parsed = JSON.parse(fs.readFileSync(pending, "utf8"));
    return Array.isArray(parsed?.pending) ? parsed.pending : [];
  } catch {
    return [];
  }
}

function writePending(dir, list) {
  const { pending } = mirrorPaths(dir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${pending}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pending: list }, null, 2) + "\n");
  fs.renameSync(tmp, pending);
}

/** Rewrite a file atomically (tmp + rename), so a reader never sees a partial one. */
function rewriteAtomically(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Append one command. Returns `{ command, queued }`; `queued: false` means an
 * equivalent action is already pending and nothing was written.
 */
export function enqueue({ op, itemId, until = null, reason = null } = {}, { dir = resolveMirrorDir(), at = new Date().toISOString() } = {}) {
  if (!OPS.includes(op)) throw new Error(`unknown op ${JSON.stringify(op)}; expected one of ${OPS.join("|")}`);
  if (typeof itemId !== "string" || !itemId.trim()) throw new Error("itemId is required");
  if (op === "snooze" && !until) throw new Error("snooze requires an until time");

  const normalized = op === "snooze" ? new Date(until).toISOString() : null;
  const command = {
    id: crypto.randomUUID(),
    at,
    op,
    itemId,
    until: normalized,
    reason: reason == null || reason === "" ? null : String(reason),
  };

  const { dir: base, commands, ack } = mirrorPaths(dir);
  const acked = ackedIds(base);
  const pending = readPending(base).filter((row) => !acked.has(row.id));

  // Same action already in flight: do not queue it twice. A pending snooze for
  // the same item counts as the same action only when the `until` matches, so
  // "snooze 1h" then "snooze tomorrow" both go through.
  const duplicate = pending.some((row) => row.itemId === itemId && row.op === op && (op !== "snooze" || row.until === command.until));
  if (duplicate) return { command: null, queued: false, pending };

  fs.mkdirSync(base, { recursive: true });
  // Append-only, one JSON object per line, flush before returning so a
  // subsequent read (or iOS poll) sees it.
  const fd = fs.openSync(commands, "a");
  try {
    fs.writeSync(fd, JSON.stringify(command) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const next = [...pending, command];
  writePending(base, next);
  // Touch the ack file so a user without the app yet still has the transport
  // shape present for the companion side to append to.
  if (!fs.existsSync(ack)) rewriteAtomically(ack, "");
  return { command, queued: true, pending: next };
}

/**
 * Drop acked commands from the local pending set and compact `commands.jsonl`
 * when it is large or fully acked. Returns what changed.
 */
export function dropAcked({ dir = resolveMirrorDir() } = {}) {
  const { dir: base, commands } = mirrorPaths(dir);
  const acked = ackedIds(base);
  const pending = readPending(base);
  const kept = pending.filter((row) => !acked.has(row.id));
  const removed = pending.length - kept.length;
  if (removed) writePending(base, kept);

  let size = 0;
  try {
    size = fs.statSync(commands).size;
  } catch (error) {
    if (error?.code === "ENOENT") return { removed, compacted: false, pending: kept };
    throw error;
  }
  const lines = readLines(commands);
  const rows = parseLines(lines);
  const allAcked = rows.length > 0 && rows.every((row) => acked.has(row.id));
  if (size > COMPACT_BYTES || allAcked) {
    // Keep any unacked line verbatim; drop acked and unparseable ones.
    const keep = lines.filter((line) => {
      try {
        const row = JSON.parse(line);
        return row && typeof row.id === "string" && !acked.has(row.id);
      } catch {
        return false;
      }
    });
    rewriteAtomically(commands, keep.length ? keep.join("\n") + "\n" : "");
    return { removed, compacted: true, pending: kept };
  }
  return { removed, compacted: false, pending: kept };
}

/** Pending commands that the snapshot has not caught up with yet, newest last. */
export function pendingFor(itemId, { dir = resolveMirrorDir() } = {}) {
  const acked = ackedIds(dir);
  return readPending(dir).filter((row) => row.itemId === itemId && !acked.has(row.id));
}

/**
 * The optimistic view of an item: apply the pending transitions on top of the
 * snapshot. Pending beats stale snapshot content; a fresh snapshot that already
 * reflects the action wins because `dropAcked` removes the command first.
 */
export function applyPending(item, pending = []) {
  let next = item;
  for (const row of pending) {
    if (row.op === "done") next = { ...next, status: "done", pending: true };
    else if (row.op === "dismiss") next = { ...next, status: "dismissed", pending: true };
    else if (row.op === "reopen") next = { ...next, status: "open", snoozedUntil: null, pending: true };
    else if (row.op === "snooze") next = { ...next, status: "snoozed", snoozedUntil: row.until, pending: true };
  }
  return next;
}
