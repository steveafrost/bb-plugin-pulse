import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../lib/store.mjs";

// Run threads live outside plugin kv so a `bb plugin remove` cannot orphan them:
// removal deletes kv, and a missing id spawns a fresh thread on the next run.
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "pulse-rt-"));

test("run threads start empty and survive a reinstall-shaped kv wipe", () => {
  const h = home();
  assert.deepEqual(store.getRunThreads(h), {});
  store.setRunThread("hourly", "thr_hourly", h);
  // A reinstall wipes kv but not the store directory; the id must still resolve.
  assert.equal(store.getRunThreads(h).hourly, "thr_hourly");
});

test("sets, replaces and clears one run without touching the others", () => {
  const h = home();
  store.setRunThread("hourly", "thr_a", h);
  store.setRunThread("daily", "thr_b", h);
  assert.deepEqual(store.getRunThreads(h), { hourly: "thr_a", daily: "thr_b" });

  store.setRunThread("hourly", "thr_a2", h);
  assert.deepEqual(store.getRunThreads(h), { hourly: "thr_a2", daily: "thr_b" });

  store.setRunThread("daily", null, h);
  assert.deepEqual(store.getRunThreads(h), { hourly: "thr_a2" });
});

test("run threads coexist with the rest of state.json", () => {
  const h = home();
  store.setRunThread("weekly", "thr_w", h);
  store.markSeen(null, h);
  assert.equal(store.getRunThreads(h).weekly, "thr_w");
  assert.ok(store.getState(h).lastViewedAt, "markSeen must still record lastViewedAt");

  // markSeen first, then a thread write: neither may clobber the other.
  const h2 = home();
  store.markSeen(null, h2);
  store.setRunThread("hourly", "thr_h", h2);
  assert.equal(store.getRunThreads(h2).hourly, "thr_h");
  assert.ok(store.getState(h2).lastViewedAt);
});

test("a corrupt state.json throws from the store, so the server's guard can fall back", () => {
  const h = home();
  fs.writeFileSync(path.join(h, "state.json"), "{not json");
  // The server guards this read; the store itself still surfaces the parse error,
  // so assert the contract the guard relies on: it throws rather than returning junk.
  assert.throws(() => store.getRunThreads(h), /cannot parse/);
});
