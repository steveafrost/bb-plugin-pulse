import { test } from "node:test";
import assert from "node:assert/strict";
import { runEffects } from "../lib/run-effects.ts";

const run = (name: string, finishedAt: string) =>
  ({ run: name, startedAt: null, finishedAt, previousFinishedAt: null, summary: "s", thread: null, sources: [], errors: [] });
const item = (status: string, history: { at: string; by: string; change: string }[]) =>
  ({ id: "slack:x", kind: "followup", title: "x", status, priority: "normal", due: null, firstSeenAt: "2026-10-20T00:00:00Z", history }) as never;

const daily = run("daily", "2026-10-21T10:00:00Z");
const hourly = run("hourly", "2026-10-22T10:00:00Z");

test("a run that moved an item to waiting isn't credited with a later run's resolve", () => {
  const i = item("resolved", [
    { at: "2026-10-21T09:00:00Z", by: "daily", change: "status" },
    { at: "2026-10-22T09:00:00Z", by: "hourly", change: "resolved" },
  ]);
  assert.deepEqual(runEffects(daily, [hourly, daily], [i]).resolved, []);
  assert.deepEqual(runEffects(hourly, [hourly, daily], [i]).resolved, [i]);
});

test("a legacy status resolve still counts when it is the last status change", () => {
  const i = item("resolved", [
    { at: "2026-10-21T08:00:00Z", by: "daily", change: "created" },
    { at: "2026-10-21T09:00:00Z", by: "daily", change: "status" },
    { at: "2026-10-22T09:00:00Z", by: "hourly", change: "title" },
  ]);
  const { added, resolved } = runEffects(daily, [hourly, daily], [i]);
  assert.deepEqual(added, [i]);
  assert.deepEqual(resolved, [i]);
});

test("a legacy status change followed by a legacy resolve credits only the resolving run", () => {
  const i = item("resolved", [
    { at: "2026-10-21T09:00:00Z", by: "daily", change: "status" },
    { at: "2026-10-22T09:00:00Z", by: "hourly", change: "status" },
  ]);
  assert.deepEqual(runEffects(daily, [hourly, daily], [i]).resolved, []);
  assert.deepEqual(runEffects(hourly, [hourly, daily], [i]).resolved, [i]);
});
