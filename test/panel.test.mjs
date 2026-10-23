import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { actionsByItem, pendingByItem, projectItems } from "../lib/panel.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"));
const items = fixture.items;

test("the iPhone's items pass through untouched when nothing is local", () => {
  const out = projectItems(items);
  assert.deepEqual(out, items, "no Mac-local state must mean no change at all");
});

test("pending transitions add a marker and leave the status alone", () => {
  const pending = pendingByItem([{ itemId: "calendar:event:next", op: "done" }]);
  const out = projectItems(items, { pending });
  const row = out.find((i) => i.id === "calendar:event:next");
  assert.deepEqual(row.pending, ["done"]);
  assert.equal(row.status, "open", "the iPhone owns status; the panel only marks it sent");
  // Nothing else changed.
  assert.deepEqual(out.filter((i) => i.id !== "calendar:event:next"), items.filter((i) => i.id !== "calendar:event:next"));
});

test("several pending ops on one item collapse to a unique list", () => {
  const pending = pendingByItem([
    { itemId: "calendar:event:next", op: "snooze" },
    { itemId: "calendar:event:next", op: "snooze" },
    { itemId: "calendar:event:next", op: "done" },
  ]);
  const row = projectItems(items, { pending }).find((i) => i.id === "calendar:event:next");
  assert.deepEqual(row.pending, ["snooze", "done"]);
});

test("Mac-local agent actions are merged in, and the snapshot's copy wins nothing", () => {
  const action = { threadId: "thr_new", status: "running", startedAt: "2026-10-23T19:00:00.000Z", finishedAt: null, summary: null, seenAt: null };
  const actions = actionsByItem([["calendar:event:now-high", action]]);
  const row = projectItems(items, { actions }).find((i) => i.id === "calendar:event:now-high");
  assert.deepEqual(row.action, action);

  // An item with no local action keeps the app's round-tripped one.
  const withAction = projectItems(items, { actions: {} }).find((i) => i.id === "calendar:event:ABC-123");
  assert.deepEqual(withAction.action, fixture.items[0].action);
});

test("agentSkills is computed for open items only", () => {
  const skillsFor = (item) => [{ name: `skill-${item.kind}` }];
  const out = projectItems(items, { skillsFor });
  for (const row of out) {
    if (row.status === "open" || row.status === "waiting") assert.deepEqual(row.agentSkills, [`skill-${row.kind}`]);
    else assert.deepEqual(row.agentSkills, fixture.items.find((i) => i.id === row.id).agentSkills);
  }
});

test("the item shapes are not mutated in place", () => {
  const before = JSON.stringify(items);
  projectItems(items, { pending: pendingByItem([{ itemId: "calendar:event:next", op: "done" }]), skillsFor: () => [] });
  assert.equal(JSON.stringify(items), before);
});
