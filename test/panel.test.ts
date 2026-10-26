// Panel logic from the UI audit (audit/ui.md). Each test names the finding it covers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardSummary, effectiveItem, fixedLater, isNewer, logRows, runProblem, snoozeOptions, withOverlay } from "../lib/panel.ts";
import { horizonOf, horizonReason } from "../lib/horizon.ts";

const item = (over: Record<string, unknown> = {}) => ({
  id: "slack:x", source: "slack", kind: "followup", title: "t", detail: "", url: null, due: null, priority: "normal", people: [],
  status: "open", snoozedUntil: null, resolution: null, firstSeenAt: "2026-10-20T00:00:00Z", lastSeenAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z", resolvedAt: null, lastChangedBy: "hourly", ...over,
}) as never;
const run = (over: Record<string, unknown> = {}) => ({ run: "hourly", startedAt: null, finishedAt: "2026-10-26T10:00:00Z", summary: "s", thread: null, sources: ["slack"], errors: [], ...over }) as never;
const auto = (over: Record<string, unknown> = {}) => ({ run: "hourly", label: "Hourly", threadId: null, schedule: "0 * * * *", nextRunAt: null, enabled: true, ...over }) as never;

test("ui#1 an expired snooze reads as open and leaves Later without a store write", () => {
  const now = Date.parse("2026-10-26T15:00:00Z");
  const snoozed = item({ status: "snoozed", snoozedUntil: "2026-10-26T14:59:00Z" });
  const eff = effectiveItem(snoozed, now) as { status: string };
  assert.equal(eff.status, "open");
  assert.equal(horizonOf(eff as never, new Date(now)), "next");
  assert.equal((effectiveItem(item({ status: "snoozed", snoozedUntil: "2026-10-26T16:00:00Z" }), now) as { status: string }).status, "snoozed");
});

test("ui#4 an older snapshot never replaces a newer one", () => {
  const a = { generatedAt: "2026-10-26T10:00:00.100Z" };
  const b = { generatedAt: "2026-10-26T10:00:00.200Z" };
  assert.equal(isNewer(b, a), false);
  assert.equal(isNewer(a, b), true);
  assert.equal(isNewer(null, a), true);
  assert.equal(isNewer(a, a), true);
});

test("ui#8 filter counts include snoozed items the board shows", () => {
  const items = [item({ id: "slack:1" }), item({ id: "gmail:1", source: "gmail" }), item({ id: "github:1", source: "github", status: "snoozed", snoozedUntil: "2099-01-01T00:00:00Z" }), item({ id: "slack:2", status: "done" })];
  const { counts } = boardSummary(items, null);
  assert.equal(counts.all, 3);
  assert.equal(counts.github, 1);
});

test("ui#6 the run warning names the run and clears once a later run reads cleanly", () => {
  const daily = run({ run: "daily", finishedAt: "2026-10-25T21:30:00Z", errors: ["tgw: Token expired", "gws: 401"] });
  const autos = [auto(), auto({ run: "daily", label: "Daily" })];
  const p = runProblem({ recentRuns: [daily], automations: autos });
  assert.deepEqual(p && { kind: p.kind, label: p.label, count: (p as { count: number }).count }, { kind: "errors", label: "Daily", count: 2 });
  const clean = run({ finishedAt: "2026-10-26T14:22:00Z" });
  assert.equal(runProblem({ recentRuns: [clean, daily], automations: autos }), null);
  assert.equal(fixedLater(daily, [clean, daily]), clean);
  // A later run that read nothing doesn't count as fixing it.
  assert.ok(runProblem({ recentRuns: [run({ finishedAt: "2026-10-26T14:22:00Z", sources: [] }), daily], automations: autos }));
});

test("binks: a clean run clears a source's error only if it read that source", () => {
  // An earlier Hourly read Slack, so "slack" in the Daily's error names a source.
  const earlier = run({ finishedAt: "2026-10-25T20:00:00Z", sources: ["slack", "gmail"] });
  const daily = run({ run: "daily", finishedAt: "2026-10-25T21:30:00Z", sources: ["gmail"], errors: ["slack: token expired"] });
  const gmailOnly = run({ finishedAt: "2026-10-26T09:00:00Z", sources: ["gmail"] });
  const withSlack = run({ finishedAt: "2026-10-26T10:00:00Z", sources: ["Slack", "gmail"] });
  const autos = [auto(), auto({ run: "daily", label: "Daily" })];
  assert.equal(fixedLater(daily, [gmailOnly, daily, earlier]), undefined);
  assert.equal(runProblem({ recentRuns: [gmailOnly, daily, earlier], automations: autos })?.kind, "errors");
  assert.equal(fixedLater(daily, [withSlack, gmailOnly, daily, earlier]), withSlack);
  assert.equal(runProblem({ recentRuns: [withSlack, gmailOnly, daily, earlier], automations: autos }), null);
});

test("binks: an error that names no source needs a later run that read everything the failed run read", () => {
  const daily = run({ run: "daily", finishedAt: "2026-10-25T21:30:00Z", sources: ["slack", "calendar"], errors: ["CLI missing"] });
  assert.equal(fixedLater(daily, [run({ finishedAt: "2026-10-26T09:00:00Z", sources: ["slack"] }), daily]), undefined);
  const both = run({ finishedAt: "2026-10-26T10:00:00Z", sources: ["calendar", "slack", "gmail"] });
  assert.equal(fixedLater(daily, [both, daily]), both);
  // "tgw" (Tool Gateway) is not a source any run reads, so it doesn't pin the warning forever.
  const tgw = run({ run: "daily", finishedAt: "2026-10-25T21:30:00Z", sources: ["slack"], errors: ["tgw: Token expired"] });
  const slack = run({ finishedAt: "2026-10-26T09:00:00Z", sources: ["slack"] });
  assert.equal(fixedLater(tgw, [slack, tgw]), slack);
});

test("binks: a fixed newer failure doesn't hide an older one that is still broken", () => {
  const seen = run({ finishedAt: "2026-10-25T08:00:00Z", sources: ["slack", "calendar"] });
  const calendar = run({ run: "daily", finishedAt: "2026-10-25T21:30:00Z", sources: ["slack"], errors: ["calendar: 401"] });
  const slack = run({ finishedAt: "2026-10-26T09:00:00Z", sources: ["calendar"], errors: ["slack: token expired"] });
  const slackFixed = run({ finishedAt: "2026-10-26T10:00:00Z", sources: ["slack"] });
  const autos = [auto(), auto({ run: "daily", label: "Daily" })];
  const p = runProblem({ recentRuns: [slackFixed, slack, calendar, seen], automations: autos });
  assert.equal(p?.kind, "errors");
  assert.equal((p as { run: { finishedAt: string } }).run.finishedAt, calendar.finishedAt);
  // Once a run reads Calendar cleanly too, nothing is left to warn about.
  const calendarFixed = run({ finishedAt: "2026-10-26T11:00:00Z", sources: ["calendar"] });
  assert.equal(runProblem({ recentRuns: [calendarFixed, slackFixed, slack, calendar, seen], automations: autos }), null);
});

test("server improvement 1: run failures, refused schedules and overdue runs surface in the panel", () => {
  assert.equal(runProblem({ recentRuns: [], automations: [auto({ scheduleError: "Constraint error" })] })?.kind, "schedule");
  const failed = runProblem({ recentRuns: [], automations: [auto({ failure: { at: "2026-10-26T10:00:00Z", error: "thread/resume timed out", threadId: "t" } })] });
  assert.equal(failed?.kind, "failed");
  assert.equal(runProblem({ recentRuns: [], automations: [auto({ overdue: true, lastDispatchAt: "2026-10-26T09:00:00Z" })] })?.kind, "overdue");
});

test("ui improvement 3: an optimistic overlay moves the card before the server answers", () => {
  const items = [item({ id: "slack:1" }), item({ id: "slack:2" })];
  const shown = withOverlay(items, { "slack:1": { status: "done" } }) as { id: string; status: string }[];
  assert.deepEqual(shown.map((i) => i.status), ["done", "open"]);
  assert.equal((items[0] as { status: string }).status, "open", "the snapshot itself is untouched");
});

test("ui improvement 5: the detail view says why an item sits where it does", () => {
  const now = new Date(2026, 9, 26, 10, 0);
  assert.equal(horizonReason(item({ priority: "low", firstSeenAt: new Date(2026, 9, 16).toISOString() }), now), "Low priority, open 10 days → Next");
  assert.equal(horizonReason(item({ priority: "high" }), now), "High priority → Now");
  assert.equal(horizonReason(item({ due: new Date(2026, 9, 26, 17).toISOString() }), now), "Due today → Now");
  assert.equal(horizonReason(item({ status: "waiting" }), now), "Waiting on others → Later");
  assert.equal(horizonReason(item({ kind: "fyi" }), now), "FYI, no action needed → Nice to Know");
});

test("ui improvement 6: snooze offers the rest of today, a morning that isn't 32 hours away, and next week", () => {
  const labels = (d: Date) => snoozeOptions(d).map((o) => o.label);
  assert.deepEqual(labels(new Date(2026, 9, 26, 9, 0)), ["1 hour", "3 hours", "This afternoon (2 PM)", "This evening (6 PM)", "Tomorrow 9 AM", "Next week (Mon 9 AM)"]);
  const late = snoozeOptions(new Date(2026, 9, 27, 1, 0));
  assert.ok(late.some((o) => o.label === "This morning (9 AM)" && new Date(o.until).getDate() === 27));
  assert.ok(!late.some((o) => o.label === "Tomorrow 9 AM"));
  // 11:00: "3 hours" is 2 PM, so "This afternoon" would repeat it.
  assert.ok(!labels(new Date(2026, 9, 26, 11, 0)).includes("This afternoon (2 PM)"));
  const monday = new Date(snoozeOptions(new Date(2026, 9, 26, 9, 0)).at(-1)!.until);
  assert.deepEqual([monday.getDay(), monday.getDate()], [1, 2]);
});

test("ui improvement 8 / capture B4: the Run Log lists runs that didn't finish and can show errors only", () => {
  const ok = run({ finishedAt: "2026-10-26T12:00:00Z" });
  const bad = run({ finishedAt: "2026-10-26T10:00:00Z", errors: ["x"] });
  const missed = { run: "hourly", label: "Hourly", at: "2026-10-26T11:00:00Z", threadId: "t", trigger: "schedule" } as never;
  assert.deepEqual(logRows([ok, bad], [missed]).map((r) => r.kind), ["run", "missed", "run"]);
  assert.deepEqual(logRows([ok, bad], [missed], { errorsOnly: true }).map((r) => r.at), ["2026-10-26T11:00:00Z", "2026-10-26T10:00:00Z"]);
});
