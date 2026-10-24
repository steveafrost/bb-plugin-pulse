import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../lib/store.mjs";

// The mirror is the panel's data source; the legacy store must refuse agent
// writes while one is configured, or the two would silently diverge.
test("upsert refuses when a mirror directory is configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thirdhand-mirror-guard-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "thirdhand-store-"));
  const prev = process.env.THIRDHAND_SNAPSHOT_DIR;
  process.env.THIRDHAND_SNAPSHOT_DIR = dir;
  try {
    assert.throws(
      () => store.upsert([{ id: "calendar:x", title: "t" }], "hourly", home),
      /owns items|read-only/,
    );
    // Nothing was written.
    assert.equal(fs.existsSync(path.join(home, "items.json")), false);
  } finally {
    if (prev === undefined) delete process.env.THIRDHAND_SNAPSHOT_DIR;
    else process.env.THIRDHAND_SNAPSHOT_DIR = prev;
  }
});

test("a blank THIRDHAND_SNAPSHOT_DIR does not lock the legacy store", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "thirdhand-store-"));
  const prev = process.env.THIRDHAND_SNAPSHOT_DIR;
  process.env.THIRDHAND_SNAPSHOT_DIR = "   ";
  try {
    const out = store.upsert([{ id: "calendar:x", title: "t" }], "hourly", home);
    assert.deepEqual(out.created, ["calendar:x"]);
  } finally {
    if (prev === undefined) delete process.env.THIRDHAND_SNAPSHOT_DIR;
    else process.env.THIRDHAND_SNAPSHOT_DIR = prev;
  }
});
