import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../lib/store.mjs";

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "pulse-val-"));

test("rejects non-string descriptive fields so one bad item can't break the panel", () => {
  const h = home();
  for (const bad of [{ title: 1 }, { title: "  " }, { title: "t", detail: 5 }, { title: "t", url: 7 }, { title: "t", people: [1] }]) {
    assert.throws(() => store.upsert([{ id: "slack:x", ...bad }], "hourly", h), /must be/, JSON.stringify(bad));
  }
  store.upsert([{ id: "slack:x", title: "ok" }], "hourly", h);
  assert.throws(() => store.upsert([{ id: "slack:x", detail: { a: 1 } }], "hourly", h), /detail must be a string/);
  assert.equal(store.listItems({ statuses: ["open"] }, h)[0].detail, "");
});

test("still accepts null detail and url", () => {
  const h = home();
  store.upsert([{ id: "gmail:y", title: "ok", detail: null, url: null, people: ["Ana"] }], "hourly", h);
  assert.equal(store.listItems({ statuses: ["open"] }, h).length, 1);
});
