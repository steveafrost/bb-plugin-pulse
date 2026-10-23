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

test("an agent resolve is recorded as a resolved change for the Run Log", () => {
  const h = home();
  store.upsert([{ id: "slack:z", title: "ok" }], "hourly", h);
  const out = store.upsert([{ id: "slack:z", status: "resolved", reason: "answered" }], "daily", h);
  assert.deepEqual(out.resolved, ["slack:z"]);
  const it = store.getItem("slack:z", h);
  assert.equal(it.history.at(-1).change, "resolved");
  assert.equal(it.history.at(-1).by, "daily");
});

test("reopen must be a real boolean and reason a string, so a handled item stays handled", () => {
  const h = home();
  store.upsert([{ id: "slack:r", title: "ok" }], "hourly", h);
  store.userAction("slack:r", "done", {}, h);
  for (const bad of [{ reopen: "false", reason: "x" }, { reopen: 1, reason: "x" }, { reopen: true, reason: 5 }, { reopen: true, reason: " " }, { status: "resolved", reason: { a: 1 } }, { due: 1730000000000 }]) {
    assert.throws(() => store.upsert([{ id: "slack:r", ...bad }], "hourly", h), /must be|requires a reason/, JSON.stringify(bad));
  }
  assert.equal(store.getItem("slack:r", h).status, "done");
  store.upsert([{ id: "slack:r", reopen: true, reason: "new reply" }], "hourly", h);
  assert.equal(store.getItem("slack:r", h).status, "open");
});
