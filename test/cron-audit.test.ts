// server.md #3 and #7: the panel's cron reading must match bb's scheduler (cron-parser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronError, nextCronRun, prevCronRun } from "../lib/cron.ts";

const from = new Date(2026, 9, 26, 10, 30); // Mon Oct 26 2026 10:30 local

test("server#7 names, macros, L, # and 6-field crons get a next run", () => {
  const cases: [string, Date][] = [
    ["0 15 * * FRI", new Date(2026, 9, 30, 15, 0)],
    ["0 9 * * MON-FRI", new Date(2026, 9, 27, 9, 0)],
    ["@daily", new Date(2026, 9, 27, 0, 0)],
    ["@hourly", new Date(2026, 9, 26, 11, 0)],
    ["@weekly", new Date(2026, 10, 1, 0, 0)],
    ["0 9 * * 5L", new Date(2026, 9, 30, 9, 0)],
    ["0 9 * * 5#2", new Date(2026, 10, 13, 9, 0)],
    ["0 9 L * *", new Date(2026, 9, 31, 9, 0)],
    ["0 0 9 * * 1", new Date(2026, 10, 2, 9, 0)],
    ["0 9 * jan-mar mon", new Date(2027, 0, 4, 9, 0)],
  ];
  for (const [expr, want] of cases) assert.deepEqual(nextCronRun(expr, from), want, expr);
});

test("server#7 a monthly schedule more than 8 days out still has a next run", () => {
  assert.deepEqual(nextCronRun("0 9 1 * *", from), new Date(2026, 10, 1, 9, 0));
  assert.deepEqual(nextCronRun("0 0 1 1 *", from), new Date(2027, 0, 1, 0, 0));
});

test("server#3 crons bb rejects are errors, not a clamped next run", () => {
  for (const expr of ["0 9-30 * * *", "0 9 1-40 * *", "5-70 9 * * *", "0 9 * * 1-9", "0 9 * * 1-3,9", "0 */2 * * *  extra", "0 9 * * 0-6/0", "0 9 * * L", "@midnight", "0 9 5-3 * *"]) {
    assert.ok(cronError(expr), expr);
    assert.equal(nextCronRun(expr, from), null, expr);
  }
  for (const expr of ["0 8-18/2 * * 1-5", "30 16 * * 1-5", "0 15 * * 5", "*/90 * * * *", "0 9 */40 * *", "0 9 * * 7"]) assert.equal(cronError(expr), null, expr);
});

test("server#4 prevCronRun finds the tick a restart skipped", () => {
  assert.deepEqual(prevCronRun("0 15 * * 5", new Date(2026, 9, 30, 15, 10)), new Date(2026, 9, 30, 15, 0));
  assert.deepEqual(prevCronRun("0 16 * * *", new Date(2026, 9, 26, 16, 3)), new Date(2026, 9, 26, 16, 0));
  assert.deepEqual(prevCronRun("0 8-18/2 * * 1-5", new Date(2026, 9, 26, 7, 0)), new Date(2026, 9, 23, 18, 0));
});

// server.md improvement 7: snapshots no longer stat every skill root for every item.
test("server improvement 7: skill lookups are memoized across snapshots", async () => {
  const fs = (await import("node:fs")).default;
  const { parseSkillRules, skillsFor } = await import("../lib/skills.ts");
  const rules = parseSkillRules("memo-probe-skill-xyz | x | *");
  const item = { kind: "reply", title: "t", detail: "", url: null, id: "slack:x", people: [] } as never;
  const real = fs.existsSync;
  let stats = 0;
  fs.existsSync = ((p: string) => { stats++; return real(p); }) as typeof fs.existsSync;
  try {
    for (let i = 0; i < 20; i++) skillsFor(item, rules);
  } finally { fs.existsSync = real; }
  assert.ok(stats <= 4, `${stats} stats for 20 lookups`);
});
