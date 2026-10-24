import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../lib/store.mjs";

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "thirdhand-qa-"));
const base = { id: "calendar:evt1", title: "Decline sync", kind: "conflict" };

test("stores quick actions on create and update", () => {
  const h = home();
  store.upsert([{ ...base, quickActions: [{ label: "Decline meeting", text: "Can't make it", url: "https://calendar.google.com/x" }] }], "hourly", h);
  let it = store.listItems({ statuses: ["open"] }, h)[0];
  assert.equal(it.quickActions[0].label, "Decline meeting");
  store.upsert([{ id: base.id, quickActions: [{ label: "Open event", url: "https://calendar.google.com/y" }] }], "hourly", h);
  it = store.listItems({ statuses: ["open"] }, h)[0];
  assert.deepEqual(it.quickActions, [{ label: "Open event", url: "https://calendar.google.com/y" }]);
});

test("updates quick actions even when the user snoozed the item", () => {
  const h = home();
  store.upsert([base], "hourly", h);
  store.userAction(base.id, "snoozed", { until: new Date(Date.now() + 864e5).toISOString() }, h);
  store.upsert([{ id: base.id, quickActions: [{ label: "Copy note", text: "hi" }] }], "hourly", h);
  const it = store.listItems({ statuses: ["snoozed"] }, h)[0];
  assert.equal(it.status, "snoozed");
  assert.equal(it.quickActions[0].label, "Copy note");
});

test("rejects malformed quick actions", () => {
  const h = home();
  const bad = [
    [{ label: "x" }],
    [{ label: "", text: "a" }],
    [{ label: "x", url: "javascript:alert(1)" }],
    [{ label: "x", url: "http://insecure" }],
    [{ label: "x", text: "a", send: true }],
    Array(4).fill({ label: "x", text: "a" }),
    "nope",
  ];
  for (const qa of bad) assert.throws(() => store.upsert([{ ...base, quickActions: qa }], "hourly", h), store.ThirdHandError);
});
