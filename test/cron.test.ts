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
