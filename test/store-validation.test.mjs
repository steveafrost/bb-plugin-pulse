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

test("run logs need a string summary, and malformed records already on disk are skipped", () => {
  const h = home();
  assert.throws(() => store.logRun({ run: "hourly", summary: true }, h), /summary is required/);
  assert.throws(() => store.logRun({ run: "hourly", summary: "  " }, h), /summary is required/);
  assert.throws(() => store.logRun({ run: true, summary: "ok" }, h), /run name is required/);
  store.logRun({ run: "hourly", summary: "good" }, h);
  fs.appendFileSync(path.join(h, "runs.jsonl"), JSON.stringify({ run: "hourly", summary: true, finishedAt: new Date().toISOString() }) + "\nnot json\n");
  assert.deepEqual(store.readRuns(h).map((r) => r.summary), ["good"]);
});

test("reopening clears the old resolution so a later close doesn't reuse it", () => {
  const h = home();
  const item = { id: "slack:1", source: "slack", kind: "reply", title: "Question" };
  store.upsert([item], "hourly", h);
  store.upsert([{ id: item.id, status: "resolved", reason: "answered" }], "hourly", h);
  store.upsert([{ id: item.id, reopen: true, reason: "new reply" }], "hourly", h);
  assert.equal(store.listItems({ statuses: ["open"] }, h)[0].resolution, null);
  store.userAction(item.id, "done", {}, h);
  store.userAction(item.id, "open", {}, h);
  store.userAction(item.id, "dismissed", {}, h);
  const [closed] = store.listItems({ statuses: ["dismissed"] }, h);
  assert.equal(closed.resolution, null);
});

test("recent runs know when the previous same-name run finished, even outside the recent slice", () => {
  const h = home();
  store.logRun({ run: "weekly", summary: "w1" }, h);
  for (let i = 0; i < 12; i++) store.logRun({ run: "hourly", summary: `h${i}` }, h);
  store.logRun({ run: "weekly", summary: "w2" }, h);
  const runs = store.snapshot(h).recentRuns;
  const w2 = runs.find((r) => r.summary === "w2");
  assert.ok(!runs.some((r) => r.summary === "w1"));
  assert.equal(w2.previousFinishedAt, store.readRuns(h)[0].finishedAt);
  assert.equal(runs.find((r) => r.summary === "h0"), undefined);
});

test("item urls must be web links, since the panel renders them as links", () => {
  const h = home();
  for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "slack.com/x"]) {
    assert.throws(() => store.upsert([{ id: "slack:u", source: "slack", kind: "reply", title: "T", url }], "hourly", h), /url must be an http\(s\) URL/);
  }
  store.upsert([{ id: "slack:u", source: "slack", kind: "reply", title: "T", url: "https://x.slack.com/archives/C1/p1" }], "hourly", h);
  store.upsert([{ id: "slack:v", source: "slack", kind: "reply", title: "T", url: "http://example.com" }], "hourly", h);
});
