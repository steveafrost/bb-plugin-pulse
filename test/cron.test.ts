import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCronRun } from "../lib/cron.ts";
import { parseSkillRules, skillsFor } from "../lib/skills.ts";

test("next run for step, daily and weekly crons", () => {
  const from = new Date(2026, 9, 16, 17, 10); // Fri Oct 16 2026 17:10 local
  assert.deepEqual(nextCronRun("0 */2 * * *", from), new Date(2026, 9, 16, 18, 0));
  assert.deepEqual(nextCronRun("0 16 * * *", from), new Date(2026, 9, 17, 16, 0));
  assert.deepEqual(nextCronRun("0 15 * * 5", from), new Date(2026, 9, 23, 15, 0));
  assert.equal(nextCronRun("bad", from), null);
});

test("skill rules parse, skip bad lines and only suggest installed skills", () => {
  const warnings: string[] = [];
  const rules = parseSkillRules("# comment\nnot-installed-xyz | x | *\nbad line\nbroken | x | (\n", (m) => warnings.push(m));
  assert.equal(rules.length, 1);
  assert.equal(warnings.length, 2);
  const item = { kind: "reply", title: "t", detail: "", url: null, id: "slack:x", people: [] } as never;
  assert.deepEqual(skillsFor(item, rules), []);
});

test("zero, negative and junk steps return no run instead of hanging", () => {
  const from = new Date(2026, 9, 16, 17, 10);
  for (const expr of ["*/0 * * * *", "*/-5 * * * *", "*/x * * * *", "0 */0 * * *", "0-99999999 * * * *"]) {
    const started = Date.now();
    const next = nextCronRun(expr, from);
    assert.ok(Date.now() - started < 1000, expr);
    if (expr.startsWith("0-")) assert.deepEqual(next, new Date(2026, 9, 16, 17, 11));
    else assert.equal(next, null, expr);
  }
});
