import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ICLOUD_DIR, SUPPORTED_SCHEMA_VERSION, createMirrorPoller, readSnapshot, resolveMirrorDir, snapshotPath,
} from "../lib/snapshot.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pulse-mirror-"));
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"));

const write = (dir, value) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(snapshotPath(dir), typeof value === "string" ? value : JSON.stringify(value));
};

// ---- Directory resolution -------------------------------------------------

test("resolution order is PULSE_SNAPSHOT_DIR, then PULSE_HOME, then iCloud", () => {
  assert.equal(resolveMirrorDir({ PULSE_SNAPSHOT_DIR: "/explicit", PULSE_HOME: "/home" }), "/explicit");
  assert.equal(resolveMirrorDir({ PULSE_HOME: "/home" }), "/home");
  assert.equal(resolveMirrorDir({}), DEFAULT_ICLOUD_DIR);
  assert.match(DEFAULT_ICLOUD_DIR, /iCloud~com~steveafrost~pulse\/Documents\/Pulse$/);
  // An empty or whitespace value must not win over the next candidate.
  assert.equal(resolveMirrorDir({ PULSE_SNAPSHOT_DIR: "  ", PULSE_HOME: "/home" }), "/home");
});

// ---- The three degraded states -------------------------------------------

test("a missing snapshot is a not-connected state, not a throw", () => {
  const dir = tmp();
  const read = readSnapshot({ dir });
  assert.equal(read.state, "not-connected");
  assert.deepEqual(read.items, []);
  assert.equal(read.generatedAt, null);
  assert.match(read.message, /iPhone/);
  // Reading must not create anything in the directory.
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("malformed JSON is an error state and the file is left byte-identical", () => {
  const dir = tmp();
  const broken = '{"schemaVersion": 1, "items": [';
  write(dir, broken);
  const read = readSnapshot({ dir });
  assert.equal(read.state, "error");
  assert.match(read.message, /not valid JSON/);
  assert.deepEqual(read.items, []);
  assert.equal(fs.readFileSync(snapshotPath(dir), "utf8"), broken);
  assert.equal(fs.readdirSync(dir).length, 1, "no temp or rewritten file");
});

test("a non-object snapshot is an error state", () => {
  const dir = tmp();
  write(dir, "[1,2,3]");
  const read = readSnapshot({ dir });
  assert.equal(read.state, "error");
  assert.match(read.message, /not a snapshot object/);
});

test("a higher schemaVersion is an update state and renders nothing", () => {
  const dir = tmp();
  write(dir, { ...fixture, schemaVersion: 2 });
  const read = readSnapshot({ dir });
  assert.equal(read.state, "update");
  assert.equal(read.schemaVersion, 2);
  assert.deepEqual(read.items, [], "a newer snapshot must not be partially rendered");
  assert.match(read.message, /Update the Pulse iOS app/);
  // And it must not have been rewritten.
  assert.equal(JSON.parse(fs.readFileSync(snapshotPath(dir), "utf8")).schemaVersion, 2);
});

test("the supported version is 1", () => {
  assert.equal(SUPPORTED_SCHEMA_VERSION, 1);
  const dir = tmp();
  write(dir, { ...fixture, schemaVersion: SUPPORTED_SCHEMA_VERSION });
  assert.equal(readSnapshot({ dir }).state, "connected");
});

// ---- The connected read ---------------------------------------------------

test("a connected snapshot exposes items in the panel's shape", () => {
  const dir = tmp();
  write(dir, fixture);
  const read = readSnapshot({ dir });
  assert.equal(read.state, "connected");
  assert.equal(read.generatedAt, fixture.generatedAt);
  assert.equal(read.deviceName, "Steve's iPhone");
  assert.equal(read.lastViewedAt, fixture.lastViewedAt);
  assert.equal(read.items.length, fixture.items.length);
  assert.equal(read.runs.length, 1);
  const first = read.items[0];
  for (const key of ["id", "source", "kind", "title", "detail", "url", "due", "priority", "people", "status", "snoozedUntil", "resolution", "firstSeenAt", "lastSeenAt", "updatedAt", "resolvedAt", "lastChangedBy"]) {
    assert.ok(key in first, `missing ${key}`);
  }
});

test("a round trip preserves every field, including quickActions, action and history", () => {
  const dir = tmp();
  write(dir, fixture);
  const read = readSnapshot({ dir });
  const original = fixture.items[0];
  const parsed = read.items[0];
  // Field-for-field, not a subset: the contract keeps the names identical.
  assert.deepEqual(parsed, original);
  assert.deepEqual(parsed.quickActions, original.quickActions);
  assert.deepEqual(parsed.action, original.action);
  assert.deepEqual(parsed.history, original.history);
});

test("unknown fields survive the read rather than being dropped", () => {
  const dir = tmp();
  const withExtra = { ...fixture, items: [{ ...fixture.items[0], futureField: { a: 1 } }], futureEnvelope: true };
  write(dir, withExtra);
  const read = readSnapshot({ dir });
  assert.deepEqual(read.items[0].futureField, { a: 1 });
});

test("an item without an id is skipped instead of crashing the board", () => {
  const dir = tmp();
  write(dir, { ...fixture, items: [{ title: "no id" }, fixture.items[1]] });
  const read = readSnapshot({ dir });
  assert.equal(read.state, "connected");
  assert.equal(read.items.length, 1);
});

// ---- Reload on generatedAt advance ---------------------------------------

test("a generatedAt advance triggers exactly one reload", () => {
  const dir = tmp();
  write(dir, fixture);
  const seen = [];
  const poller = createMirrorPoller({ dir, onChange: (r) => seen.push(r.generatedAt) });

  assert.equal(poller.poll(), true, "first read is a change");
  assert.equal(poller.poll(), false, "unchanged generatedAt does not reload");
  assert.deepEqual(seen, [fixture.generatedAt]);

  const next = { ...fixture, generatedAt: "2026-10-23T18:10:00.000Z" };
  write(dir, next);
  assert.equal(poller.poll(), true, "advanced generatedAt reloads");
  assert.equal(poller.poll(), false);
  assert.deepEqual(seen, [fixture.generatedAt, next.generatedAt]);
});

test("a state transition (connected -> not-connected) counts as a change", () => {
  const dir = tmp();
  write(dir, fixture);
  const states = [];
  const poller = createMirrorPoller({ dir, onChange: (r) => states.push(r.state) });
  poller.poll();
  fs.rmSync(snapshotPath(dir));
  assert.equal(poller.poll(), true);
  assert.deepEqual(states, ["connected", "not-connected"]);
});
