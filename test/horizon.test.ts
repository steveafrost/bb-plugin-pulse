import { test } from "node:test";
import assert from "node:assert/strict";
import { horizonOf } from "../lib/horizon.ts";

const now = new Date(2026, 9, 23, 10, 0); // Fri Oct 23 2026 10:00 local
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const base = { kind: "followup", status: "open", priority: "normal", due: null, firstSeenAt: daysAgo(0) } as const;

test("dated items move toward Now as the due date approaches", () => {
  const friday = new Date(2026, 9, 23, 17, 0).toISOString();
  assert.equal(horizonOf({ ...base, priority: "low", due: friday }, now), "now");
  assert.equal(horizonOf({ ...base, due: friday }, new Date(2026, 9, 22, 9, 0)), "next");
  assert.equal(horizonOf({ ...base, due: friday }, new Date(2026, 9, 19, 9, 0)), "later");
});

test("undated low-priority items age from Later into Next", () => {
  assert.equal(horizonOf({ ...base, priority: "low", firstSeenAt: daysAgo(1) }, now), "later");
  assert.equal(horizonOf({ ...base, priority: "low", firstSeenAt: daysAgo(3) }, now), "next");
});

test("waiting, snoozed and fyi items never age", () => {
  assert.equal(horizonOf({ ...base, priority: "low", status: "waiting", firstSeenAt: daysAgo(10) }, now), "later");
  assert.equal(horizonOf({ ...base, status: "snoozed", firstSeenAt: daysAgo(10) }, now), "later");
  assert.equal(horizonOf({ ...base, kind: "fyi", firstSeenAt: daysAgo(10) }, now), "info");
});
