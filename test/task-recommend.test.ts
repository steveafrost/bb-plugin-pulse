import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendTasks, selectCandidates, type Candidate } from "../lib/task-recommend.ts";
import type { JudgeOk } from "../lib/jev-contract.ts";

const task = (id: string, title: string): Candidate => ({ id, key: `X-${id}`, title, description: "", projectId: "p1", labelIds: [], updatedAt: "2026-01-01", status: "todo" });
const candidates = [task("1", "Review bins PR"), task("2", "Ship bins cleanup")];
const item = { title: "Review the bins cleanup", detail: "See https://example.com/?token=secret and password=supersecret" };
const result = (answers: JudgeOk["answers"]): JudgeOk => ({ ok: true, callId: "call1", tag: "pulse.task-recommend", requestedModel: "jev-1.14.0", model: "jev-1.14.0", latencyMs: 1, attempts: 1, retries: [], questionSet: null, inputHash: null, shadowModel: null, usage: { inputTokens: 1, outputTokens: 1 }, answers });

test("Jev RPC ranks link suitability and project defaults with bounded redacted input", async () => {
  let payload: any;
  const jev = { judgeOrThrow: async (input: any, signal?: AbortSignal) => {
    payload = input; assert.ok(signal);
    return result({ link_0: { type: "noul", noul: .95 }, link_1: { type: "noul", noul: .3 }, related_0: { type: "noul", noul: .7 }, related_1: { type: "noul", noul: .9 } });
  } };
  const answer = await recommendTasks(item, candidates, { jev });
  assert.equal(answer.match?.id, "1"); assert.equal(answer.related?.id, "2");
  assert.equal(payload.tag, "pulse.task-recommend");
  assert.equal(payload.maxRetries, 0); assert.equal(payload.shadow, false); assert.equal(payload.timeoutMs, 8000);
  assert.doesNotMatch(JSON.stringify(payload), /supersecret|example\.com/);
  assert.equal(payload.state.tasks.length, 2);
  assert.equal(JSON.stringify(payload).includes("X-1"), false);
});

test("OAuth assignment variants are redacted in items and candidate text", async () => {
  const credentials = ['client_secret=opaqueCredential123', 'refresh_token="opaqueRefreshToken123"', 'client-secret: opaqueDashedSecret123', "refreshToken='opaqueCamelToken123'"];
  const text = credentials.join(" ");
  const jev = { judgeOrThrow: async (input: any) => {
    assert.doesNotMatch(JSON.stringify(input.state), /opaque/);
    assert.match(input.state.item.detail, /\[redacted\]/);
    assert.match(input.state.tasks[0].description, /\[redacted\]/);
    return result({ link_0: { type: "noul", noul: .9 }, related_0: { type: "noul", noul: .9 } });
  } };
  await recommendTasks({ title: text, detail: text }, [{ ...task("1", text), description: text }], { jev });
});

test("candidate fitting respects state and question bytes and preserves indexes", async () => {
  const tasks = Array.from({ length: 25 }, (_, i) => task(String(i), "Short"));
  let calls = 0;
  const jev = { judgeOrThrow: async (input: any) => {
    calls++;
    assert.ok(Buffer.byteLength(JSON.stringify(input.state)) <= 32768);
    assert.ok(Buffer.byteLength(JSON.stringify(input.questions)) <= 4096);
    assert.ok(input.state.tasks.length > 0 && input.state.tasks.length < tasks.length);
    assert.equal(Object.keys(input.questions).length, input.state.tasks.length * 2);
    return result(Object.fromEntries(Object.keys(input.questions).map(key => [key, { type: "noul", noul: .95 }])));
  } };
  const options = { jev, maxStateBytes: 32768, maxQuestionBytes: 4096 };
  assert.equal((await recommendTasks(item, tasks, options)).match?.id, "0");
  assert.equal(calls, 1);
  const tiny = { jev: { judgeOrThrow: async () => { throw new Error("must not call"); } }, maxQuestionBytes: 1 };
  assert.deepEqual(await recommendTasks(item, tasks, tiny), { match: null, related: null, suggestions: [] });
});

test("low scores abstain and incomplete answers fail closed", async () => {
  const low = { judgeOrThrow: async () => result({ link_0: { type: "noul", noul: .2 }, related_0: { type: "noul", noul: .4 } }) };
  assert.deepEqual(await recommendTasks(item, candidates.slice(0, 1), { jev: low }), { match: null, related: null, suggestions: [] });
  await assert.rejects(recommendTasks(item, candidates, { jev: { judgeOrThrow: async () => result({}) } }), /incomplete/);
});

test("absent or unconfigured Jev fails without a direct HTTP fallback; empty candidates skip RPC", async () => {
  let calls = 0;
  const jev = { judgeOrThrow: async (): Promise<JudgeOk> => { calls++; throw new Error("Jev plugin unavailable"); } };
  assert.deepEqual(await recommendTasks(item, [], { jev }), { match: null, related: null, suggestions: [] });
  assert.equal(calls, 0);
  await assert.rejects(recommendTasks(item, candidates, { jev }), /unavailable/);
  assert.equal(calls, 1);
});

test("serialized Unicode and escaped input fit the configured byte budget", async () => {
  const tasks = Array.from({ length: 25 }, (_, i) => ({ ...task(String(i), "漢".repeat(500)), description: "\\n".repeat(500) }));
  let count = 0;
  const jev = { judgeOrThrow: async (input: any) => {
    assert.ok(Buffer.byteLength(JSON.stringify(input.state), "utf8") <= 8000);
    assert.equal(Object.keys(input.questions).length, input.state.tasks.length * 2);
    count = input.state.tasks.length;
    return result(Object.fromEntries(Object.keys(input.questions).map((key) => [key, { type: "noul", noul: .95 }])));
  } };
  const answer = await recommendTasks({ title: "😀".repeat(500), detail: "\\n".repeat(1200) }, tasks, { jev, maxStateBytes: 8000 });
  assert.ok(count > 0 && count < tasks.length);
  assert.equal(answer.match?.id, "0");
});

test("dropping an oversized candidate keeps question indexes aligned", async () => {
  const tasks = [{ ...task("large", "漢".repeat(500)), description: "漢".repeat(500) }, task("small", "Fits")];
  const jev = { judgeOrThrow: async (input: any) => {
    assert.equal(input.state.tasks.length, 1); assert.equal(input.state.tasks[0].title, "Fits");
    return result({ link_0: { type: "noul", noul: .95 }, related_0: { type: "noul", noul: .9 } });
  } };
  assert.equal((await recommendTasks({ title: "", detail: "" }, tasks, { jev, maxStateBytes: 150 })).match?.id, "small");
  assert.deepEqual(await recommendTasks(item, tasks, { jev: { judgeOrThrow: async () => { throw new Error("must not call"); } }, maxStateBytes: 10 }), { match: null, related: null, suggestions: [] });
});

test("link suitability accepts broader tracking work and returns the top three possible matches", async () => {
  const tasks = [task("1", "Track MobilePlatformApplication ownership"), task("2", "Second"), task("3", "Third"), task("4", "Fourth"), task("5", "Unrelated")];
  const scores = [.94, .7, .85, .78, .1];
  const jev = { judgeOrThrow: async (input: any) => {
    assert.match(input.questions.link_0.instructions, /appropriate place to track/);
    assert.match(input.questions.link_0.instructions, /broader/);
    assert.doesNotMatch(input.questions.link_0.instructions, /represent the same specific work/);
    return result(Object.fromEntries(tasks.flatMap((_task, i) => [
      [`link_${i}`, { type: "noul", noul: scores[i] }],
      [`related_${i}`, { type: "noul", noul: .9 }],
    ])));
  } };
  const answer = await recommendTasks({ title: "Update slices.yml ownership for the mobile platform application model", detail: "Wait for the ownership discussion and follow up." }, tasks, { jev });
  assert.equal(answer.match?.id, "1");
  assert.deepEqual(answer.suggestions.map((t) => t.id), ["1", "3", "4"]);
});

test("possible links remain visible below the primary gate and exclude low scores", async () => {
  const jev = { judgeOrThrow: async () => result({ link_0: { type: "noul", noul: .73 }, related_0: { type: "noul", noul: .96 } }) };
  const answer = await recommendTasks(item, candidates.slice(0, 1), { jev });
  assert.equal(answer.match, null);
  assert.deepEqual(answer.suggestions.map((t) => t.id), ["1"]);
});

test("candidate selection is bounded and retains recent semantic matches", () => {
  const all = Array.from({ length: 100 }, (_, i) => ({ ...task(String(i), i < 20 ? "bins" : "different"), updatedAt: String(i).padStart(3, "0") }));
  const selected = selectCandidates(item, all);
  assert.ok(selected.length <= 25);
  assert.ok(selected.some((t) => t.id === "99"));
  assert.ok(selected.some((t) => t.title === "bins"));
});
