// store.md #4: Now/Next/Later were an hour off on DST days. Runs in its own process, so the
// time zone set here applies to every Date below.
process.env.TZ = "America/Toronto";
import { test } from "node:test";
import assert from "node:assert/strict";
const { horizonOf } = await import("../lib/horizon.ts");

const base = { kind: "followup", status: "open", priority: "normal", firstSeenAt: "2026-10-20T00:00:00Z" } as const;
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

test("store#4 a 25-hour fall-back day still ends at local midnight", () => {
  assert.equal(new Date(2026, 10, 1, 12).getTimezoneOffset() !== new Date(2026, 9, 31, 12).getTimezoneOffset(), true, "Nov 1 2026 is a DST day here");
  assert.equal(horizonOf({ ...base, due: local(2026, 11, 1, 23, 30) }, new Date(2026, 10, 1, 12)), "now");
});

test("store#4 a 23-hour spring-forward day doesn't pull tomorrow into Now", () => {
  const now = new Date(2027, 2, 14, 12);
  assert.equal(horizonOf({ ...base, due: local(2027, 3, 15, 0, 30) }, now), "next");
  assert.equal(horizonOf({ ...base, due: local(2027, 3, 16, 0, 30) }, now), "later");
});
