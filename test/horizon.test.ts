import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { NEXT_WINDOW_DAYS, bucketOf, horizonOf, isOnBoard, sortItems } from "../lib/horizon.ts";
import type { ThirdHandItem } from "../types.ts";

// The iPhone is the source of truth for content, so it is the source of truth for
// placement: test/fixtures/horizon-cases.json is the fixture ThirdHandCore's
// HorizonTests assert against, so both boards agree item for item.
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/horizon-cases.json", import.meta.url), "utf8"));
const at = new Date(fixture.at);

const base = {
  kind: "deadline", priority: "normal", due: null as string | null, status: "open",
  snoozedUntil: null as string | null, firstSeenAt: "2026-10-23T08:00:00.000Z",
};
const item = (over: Partial<typeof base> = {}) => ({ ...base, ...over });

test("the contract's next window is three days", () => {
  assert.equal(NEXT_WINDOW_DAYS, 3);
});

test("every shared fixture case lands in the bucket the iPhone puts it in", () => {
  for (const c of fixture.cases) {
    assert.equal(horizonOf(item(c), at), c.expect, `${c.id}: expected ${c.expect}`);
  }
});

test("dated items move toward Now as the due date approaches", () => {
  const due = "2026-10-26T09:00:00.000Z";
  assert.equal(horizonOf(item({ due }), new Date("2026-10-26T08:00:00.000Z")), "now");
  assert.equal(horizonOf(item({ due }), new Date("2026-10-24T08:00:00.000Z")), "next");
  assert.equal(horizonOf(item({ due }), new Date("2026-10-20T08:00:00.000Z")), "later");
});

test("an undated normal-priority item is Later, not Next", () => {
  // Changed from the panel's old rule: it used to sit in Next until it was
  // handled. ThirdHandCore puts it in Later, so the panel does too.
  assert.equal(horizonOf(item({ priority: "normal" }), at), "later");
  assert.equal(horizonOf(item({ priority: "low" }), at), "later");
  assert.equal(horizonOf(item({ priority: "high" }), at), "now");
});

test("low-priority items no longer age out of Later", () => {
  // The panel used to climb an undated low-priority item into Next after three
  // days. That rule has no counterpart in the app, so it is gone: aging belongs
  // to whoever owns the item.
  const stale = item({ priority: "low", firstSeenAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(horizonOf(stale, at), "later");
});

test("waiting, snoozed and fyi items never age", () => {
  assert.equal(horizonOf(item({ status: "waiting", firstSeenAt: "2026-01-01T00:00:00.000Z" }), at), "later");
  assert.equal(horizonOf(item({ status: "snoozed", snoozedUntil: "2026-12-01T00:00:00.000Z" }), at), "later");
  assert.equal(horizonOf(item({ kind: "fyi", priority: "high", due: "2026-01-01T00:00:00.000Z" }), at), "info");
});

test("closed items are off the board; snoozed stays on it", () => {
  for (const status of ["done", "dismissed", "resolved"]) {
    assert.equal(isOnBoard(item({ status }), at), false);
    assert.equal(horizonOf(item({ status }), at), null);
  }
  for (const status of ["open", "waiting", "snoozed"]) {
    assert.equal(isOnBoard(item({ status }), at), true);
  }
  // bucketOf ignores closed state, which is how the panel places a row that is
  // animating out.
  assert.equal(bucketOf(item({ status: "done", priority: "high" }), at), "now");
});

test("an expired snooze reads as open again", () => {
  assert.equal(horizonOf(item({ status: "snoozed", snoozedUntil: "2026-10-23T09:00:00.000Z", priority: "high" }), at), "now");
});

test("sortItems is a total order: priority, due (undated last), firstSeenAt, id", () => {
  const rows = [
    { id: "d", priority: "low", due: null, firstSeenAt: base.firstSeenAt },
    { id: "c", priority: "normal", due: "2026-10-25T09:00:00.000Z", firstSeenAt: base.firstSeenAt },
    { id: "a", priority: "high", due: "2026-10-26T09:00:00.000Z", firstSeenAt: base.firstSeenAt },
    { id: "b", priority: "high", due: "2026-10-24T09:00:00.000Z", firstSeenAt: base.firstSeenAt },
    { id: "e", priority: "normal", due: null, firstSeenAt: base.firstSeenAt },
  ] as unknown as ThirdHandItem[];
  assert.deepEqual(sortItems(rows).map((r) => r.id), ["b", "a", "c", "e", "d"]);
  // Ties fall through to id rather than to an inconsistent comparator.
  const twins = [{ id: "z" }, { id: "a" }].map((x) => ({ ...x, priority: "normal", due: null, firstSeenAt: base.firstSeenAt })) as unknown as ThirdHandItem[];
  assert.deepEqual(sortItems(twins).map((r) => r.id), ["a", "z"]);
});
