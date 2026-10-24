import { test } from "node:test";
import assert from "node:assert/strict";
import { runPrompt, DEFAULT_SOURCES, ERRORS_RULE } from "../lib/prompts.ts";

// The sources setting is the definition of "set up": a run reads what it names
// and must not report an unmentioned source as an error. Without that, every run
// logged errors for Teams and Slack and a clean run was indistinguishable from a
// broken one.
const ctx = {
  cli: "thirdhand",
  user: "Steve",
  timeZone: "America/New_York",
  memoryDir: "/memory",
  sources: "GitHub: use the gh CLI.",
  instructions: "",
};

test("a run is told to report only sources the setting describes", () => {
  const p = runPrompt("hourly", ctx);
  assert.match(p, /Only report a source with `--errors` when the sources text above describes it/);
  assert.match(p, /Never report a source the sources text does not describe/);
  assert.match(p, /No errors is the normal case/);
});

test("unconfigured sources are skipped, not checked and reported", () => {
  const p = runPrompt("hourly", ctx);
  // A source absent from the setting is "not set up" — the exact case that
  // produced the Teams/Slack noise.
  assert.match(p, /that source is not set up/);
  assert.doesNotMatch(p, /If a source is unavailable, skip it and report it with --errors/);
});

test("the sources rule reaches every run, not just hourly", () => {
  for (const name of ["hourly", "daily", "weekly"]) {
    assert.match(runPrompt(name, ctx), /No errors is the normal case/, `${name} must carry the rule`);
  }
});

test("finish line omits --errors by default and asks for the sources actually read", () => {
  const p = runPrompt("hourly", ctx);
  assert.match(p, /Omit `--errors` unless a described source failed/);
  assert.match(p, /--sources <the sources you actually read>/);
});

test("the setting's own text still lands in the prompt verbatim", () => {
  const p = runPrompt("daily", { ...ctx, sources: "iCloud Mail: use himalaya." });
  assert.ok(p.includes("iCloud Mail: use himalaya."));
});

test("DEFAULT_SOURCES treats unmentioned sources as not set up", () => {
  assert.match(DEFAULT_SOURCES, /a source this setting does not describe is not set up/);
  assert.match(ERRORS_RULE, /No errors is the normal case/);
});
