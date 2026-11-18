import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../server.ts";
import * as store from "../lib/store.mjs";
import { fakeBb as baseFakeBb } from "./fake-bb.ts";
import { TASK_SETTINGS_KEY } from "../lib/task-settings.ts";

// Existing Task scenarios explicitly opt in; fresh installations remain off.
function fakeBb(options: Parameters<typeof baseFakeBb>[0] = {}) {
  const { taskAiRecommendations = false, closeOnTasksDone = false, ...capture } = options.settings ?? {};
  const list: (...args: any[]) => any = options.overrides?.["plugins.list"] ?? (() => ({ plugins: [{ id: "jev", enabled: true, status: "running" }] }));
  const f = baseFakeBb({ ...options, settings: capture, overrides: { ...options.overrides, "plugins.list": async (...args: any[]) => {
    const result: any = await list(...args);
    return { ...result, plugins: result.plugins.some((p: any) => p.id === "tasks") ? result.plugins : [{ id: "tasks", enabled: true, status: "running" }, ...result.plugins] };
  } } });
  void f.bb.storage.kv.set(TASK_SETTINGS_KEY, { enabled: true, taskAiRecommendations, closeOnTasksDone });
  return { ...f, changeSettings: async (next: Record<string, unknown>) => {
    const { taskAiRecommendations, closeOnTasksDone, ...capture } = next;
    f.changeSettings(capture);
    const patch = { ...(taskAiRecommendations === undefined ? {} : { taskAiRecommendations }), ...(closeOnTasksDone === undefined ? {} : { closeOnTasksDone }) };
    if (Object.keys(patch).length) await f.rpc.pulse_task_settings_update!(patch);
  } };
}

const item = { id: "slack:tasks", source: "slack", title: "Follow up", detail: "Details", url: "https://example.com" };
const a = { id: "01A", key: "ABC-1", title: "First", status: "todo" };
const b = { id: "01B", key: "ABC-2", title: "Second", status: "done" };

function setup(enabled = true, plugins = [{ id: "jev", enabled: true, status: "running" }]) {
  const tasks = new Map([[a.id, { ...a }], [b.id, { ...b }]]);
  let fail = false;
  const f = fakeBb({ settings: { closeOnTasksDone: enabled }, overrides: {
    "plugins.list": () => ({ plugins }),
    "plugins.callRpc": ({ pluginId, method, input, outputSchema }: any) => {
      if (pluginId !== "tasks") return {};
      if (fail) throw new Error("Tasks offline");
      let result: unknown;
      if (method === "listProjects") result = { projects: [{ id: "p1", name: "Project", prefix: "ABC" }] };
      else if (method === "listTasks") result = { tasks: [...tasks.values()].map((task) => ({ ...task, description: "", projectId: "p1", labelIds: [], updatedAt: "2026-01-01" })), nextCursor: null };
      else if (method === "getTask") result = { task: tasks.get(input.taskId) ?? null };
      else if (method === "getTaskByKey") result = { task: [...tasks.values()].find((t) => t.key === input.taskKey) ?? null };
      else if (method === "createTask") {
        if (input.projectId === "bad") result = { ok: false, error: { code: "not_found", message: "Project not found" } };
        else { const task = { id: "01C", key: "ABC-3", title: input.title, status: "backlog" }; tasks.set(task.id, task); result = { ok: true, task }; }
      } else throw new Error("unexpected method");
      return outputSchema.parse(result);
    },
  }});
  return { ...f, tasks, offline: (value: boolean) => { fail = value; } };
}

async function init(f: ReturnType<typeof setup>) {
  await plugin(f.bb as never);
  store.upsert(item, "manual", f.home);
}

test("fresh installs disable Task operations and keep capture settings native", async () => {
  const f = baseFakeBb({ overrides: { "plugins.list": () => ({ plugins: [{ id: "tasks", enabled: true, status: "running" }] }) } });
  const define = f.bb.settings.define;
  let fields: string[] = [];
  f.bb.settings.define = (descriptors) => { fields = Object.keys(descriptors); return define(descriptors); };
  await plugin(f.bb as never); store.upsert(item, "manual", f.home);
  store.changeTaskLink(item.id, a, false, f.home);
  const snap = await f.rpc.pulse_snapshot!(null);
  assert.equal(snap.taskIntegrationEnabled, false); assert.equal(snap.tasksAvailable, false);
  assert.equal(fields.includes("taskAiRecommendations"), false); assert.equal(fields.includes("closeOnTasksDone"), false);
  assert.ok(fields.includes("permissionMode")); assert.ok(fields.includes("hourlyCron"));
  for (const [method, input] of [
    ["pulse_task_projects", null], ["pulse_task_labels", { projectId: "p1" }],
    ["pulse_task_search", { search: "" }], ["pulse_task_link", { id: item.id, key: a.key }],
    ["pulse_task_unlink", { id: item.id, taskId: a.id }], ["pulse_task_create", { id: item.id, projectId: "p1", title: "New" }],
  ] as const) await assert.rejects(async () => f.rpc[method]!(input), /integration is disabled/);
  assert.deepEqual(await f.rpc.pulse_task_recommend!({ id: item.id }), { match: null, related: null, suggestions: [], projects: [] });
  await f.startServices();
  await f.rpc.pulse_start_action!({ id: item.id });
  const spawned = f.calls["threads.spawn"]![0]![0] as { prompt: string };
  assert.match(spawned.prompt, /Linked Tasks:\n- \(none\)/);
  assert.equal((f.calls["plugins.callRpc"] ?? []).some(([args]: any) => args.pluginId === "tasks" || args.pluginId === "jev"), false);
  assert.equal(store.getItem(item.id, f.home).taskLinks.length, 1);
});

test("enabling requires installed and enabled Tasks, not merely a setting write", async () => {
  const f = baseFakeBb({ overrides: { "plugins.list": () => ({ plugins: [{ id: "tasks", enabled: false, status: "disabled" }] }) } });
  await plugin(f.bb as never);
  assert.equal((await f.rpc.pulse_task_settings!(null)).tasksPluginEnabled, false);
  await assert.rejects(f.rpc.pulse_task_settings_update!({ enabled: true }), /Install and enable Tasks/);
  assert.equal((await f.rpc.pulse_task_settings!(null)).enabled, false);
});

test("status filters reach Tasks before pagination; empty filters make no request", async () => {
  const inputs: any[] = [];
  const f = fakeBb({ overrides: { "plugins.callRpc": ({ method, input, outputSchema }: any) => {
    assert.equal(method, "listTasks"); inputs.push(input);
    return outputSchema.parse({ tasks: [], nextCursor: null });
  } } });
  await plugin(f.bb as never);
  await f.rpc.pulse_task_search!({ search: "cloudsync", cursor: "next", statuses: ["todo", "backlog"] });
  assert.deepEqual(inputs[0], { limit: 100, search: "cloudsync", cursor: "next", statuses: ["todo", "backlog"] });
  assert.deepEqual(await f.rpc.pulse_task_search!({ search: "", statuses: [] }), { tasks: [], nextCursor: null });
  assert.equal(inputs.length, 1);
  await f.rpc.pulse_task_search!({ search: "" });
  assert.equal("statuses" in inputs[1], false);
});

test("disable and re-enable cannot let an old Task read write a link", async () => {
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = fakeBb({ overrides: { "plugins.callRpc": ({ method, outputSchema }: any) => {
    assert.equal(method, "getTaskByKey"); entered();
    return new Promise((resolve) => { finish = (value) => resolve(outputSchema.parse(value)); });
  } } });
  await plugin(f.bb as never); store.upsert(item, "manual", f.home);
  const pending = f.rpc.pulse_task_link!({ id: item.id, key: a.key });
  const rejected = assert.rejects(pending, /abort|disabled/i);
  await started;
  await f.rpc.pulse_task_settings_update!({ enabled: false });
  await f.rpc.pulse_task_settings_update!({ enabled: true });
  finish({ task: a }); await rejected;
  assert.equal(store.getItem(item.id, f.home).taskLinks?.length ?? 0, 0);
});

test("completed creation keeps its key when disabling cancels the local link", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = fakeBb({ overrides: { "plugins.callRpc": ({ method, outputSchema }: any) => {
    assert.equal(method, "createTask"); entered();
    return new Promise((resolve) => { finish = () => resolve(outputSchema.parse({ ok: true, task: a })); });
  } } });
  await plugin(f.bb as never); store.upsert(item, "manual", f.home);
  const pending = f.rpc.pulse_task_create!({ id: item.id, projectId: "p1", title: "New" });
  const rejected = assert.rejects(pending, /Created ABC-1, but could not link it/);
  await started; await f.rpc.pulse_task_settings_update!({ enabled: false });
  finish(); await rejected;
  assert.equal(store.getItem(item.id, f.home).taskLinks?.length ?? 0, 0);
});

test("failed registry reads retain settings and permit disabling", async () => {
  const f = fakeBb({ settings: { taskAiRecommendations: true }, overrides: { "plugins.list": () => { throw new Error("Registry offline"); } } });
  await plugin(f.bb as never);
  assert.deepEqual(await f.rpc.pulse_task_settings!(null), { enabled: true, taskAiRecommendations: true, closeOnTasksDone: false, tasksPluginEnabled: false });
  assert.equal((await f.rpc.pulse_task_settings_update!({ enabled: false })).enabled, false);
});

test("enabled Tasks with broken RPCs still permits local unlink", async () => {
  const f = setup(); await init(f);
  await f.rpc.pulse_task_link!({ id: item.id, key: a.key });
  f.offline(true); await f.rpc.pulse_snapshot!(null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const snapshot = await f.rpc.pulse_snapshot!(null);
  assert.equal(snapshot.tasksPluginEnabled, true);
  await f.rpc.pulse_task_unlink!({ id: item.id, taskId: a.id });
  assert.equal(store.getItem(item.id, f.home).taskLinks.length, 0);
});

test("create, link and unlink retain user-owned task links through capture", async () => {
  const f = setup(); await init(f);
  await f.rpc.pulse_snapshot!(null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await f.rpc.pulse_snapshot!(null)).tasksAvailable, true);
  await assert.rejects(f.rpc.pulse_task_create!({ id: item.id, projectId: "bad", title: "New" }), /Project not found/);
  await f.rpc.pulse_task_link!({ id: item.id, key: a.key });
  await f.rpc.pulse_task_create!({ id: item.id, projectId: "p1", title: "New" });
  assert.deepEqual(store.getItem(item.id, f.home).taskLinks.map((t: any) => t.key), ["ABC-1", "ABC-3"]);
  store.upsert({ id: item.id, title: "Changed" }, "hourly", f.home);
  await f.rpc.pulse_task_unlink!({ id: item.id, taskId: a.id });
  assert.deepEqual(store.getItem(item.id, f.home).taskLinks.map((t: any) => t.key), ["ABC-3"]);
  await assert.rejects(f.rpc.pulse_task_link!({ id: item.id, key: "NO-1" }), /not found/);
});

test("overlapping task creation shares the guard and releases it after success or failure", { timeout: 2000 }, async () => {
  for (const fail of [false, true]) {
    let calls = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const f = fakeBb({ overrides: {
      "plugins.callRpc": async ({ method, input, outputSchema }: any) => {
        if (method === "listProjects") return outputSchema.parse({ projects: [] });
        assert.equal(method, "createTask");
        if (++calls === 1) {
          entered(); await pending;
          if (fail) throw new Error("Tasks failed");
        }
        return outputSchema.parse({ ok: true, task: { id: "new" + calls, key: "ABC-" + calls, title: input.title, status: "backlog" } });
      },
    } });
    await plugin(f.bb as never); store.upsert(item, "manual", f.home);
    const input = { id: item.id, projectId: "p1", title: "New" };
    const first = f.rpc.pulse_task_create!(input).then((result) => result, (error) => error);
    await started;
    await assert.rejects(f.rpc.pulse_task_create!(input), /already in progress/);
    assert.equal(calls, 1);
    release();
    const result = await first;
    if (fail) assert.match(result.message, /creation may have completed/);
    else assert.equal(result.items[0].taskLinks.length, 1);
    await f.rpc.pulse_task_create!(input);
    assert.equal(calls, 2);
  }
});

test("creation guard releases while response snapshot is pending", { timeout: 2000 }, async () => {
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const f = fakeBb({ overrides: {
    "plugins.callRpc": ({ method, input, outputSchema }: any) => {
      if (method === "listProjects") return outputSchema.parse({ projects: [] });
      assert.equal(method, "createTask");
      return outputSchema.parse({ ok: true, task: { id: "new" + ++calls, key: "ABC-" + calls, title: input.title, status: "backlog" } });
    },
  } });
  await plugin(f.bb as never); store.upsert(item, "manual", f.home);
  f.bb.storage.kv.get = async (key: string) => { entered(); await pending; return f.kv.get(key); };
  const input = { id: item.id, projectId: "p1", title: "New" };
  const first = f.rpc.pulse_task_create!(input);
  await started;
  const second = f.rpc.pulse_task_create!(input);
  const secondCreated = new Promise<void>((resolve) => {
    // Each create reaches its first snapshot KV read after linking the task.
    const get = f.bb.storage.kv.get;
    f.bb.storage.kv.get = async (key: string) => { resolve(); return get(key); };
  });
  await secondCreated;
  assert.equal(calls, 2);
  release();
  await Promise.all([first, second]);
});

const jevStatus = () => ({ configured: true, keySource: "env", keyError: null, baseUrl: "https://example.com", defaultModel: "jev-1.14.0", shadowModel: null, storeStates: false, allowImages: false, limits: { timeoutMs: 8000, maxRetries: 0, maxStateBytes: 32768, maxQuestionBytes: 262144, maxAssetBytes: 0, maxConcurrency: 8, perCallerConcurrency: 4, ratePerMinute: 240, perCallerRatePerMinute: 120, batchConcurrency: 4 }, retention: { callDays: 90, outcomeCallDays: 0, stateDays: 30 }, reachable: null, reachableError: null, listedModels: null, checkedAt: 1 });
const jevSuccess = () => ({ ok: true, callId: "call1", tag: "pulse.task-recommend", requestedModel: "jev-1.14.0", model: "jev-1.14.0", latencyMs: 1, attempts: 1, retries: [], questionSet: null, inputHash: null, shadowModel: null, usage: { inputTokens: 1, outputTokens: 1 }, answers: { link_0: { type: "noul", noul: .95 }, related_0: { type: "noul", noul: .9 } } });

test("recommend, search and create preserve the selected project, labels and description", async () => {
  const candidate = { ...a, projectId: "p1", labelIds: ["label1"], description: "Existing details", updatedAt: "2026-01-01" };
  const label = { id: "label1", projectId: "p1", name: "sync", color: "blue" };
  let created: any;
  const f = fakeBb({ settings: { taskAiRecommendations: true }, overrides: {
    "plugins.callRpc": ({ pluginId, method, input, outputSchema }: any) => {
      let result: unknown;
      if (pluginId === "jev" && method === "status") { assert.equal(input.probe, false); result = jevStatus(); }
      else if (pluginId === "jev") { assert.equal(method, "judge"); assert.equal(input.maxRetries, 0); assert.equal(input.shadow, false); result = jevSuccess(); }
      else if (method === "listProjects") result = { projects: [{ id: "p1", name: "Project", prefix: "ABC" }] };
      else if (method === "listTasks") { if (input.statuses) assert.deepEqual(input.statuses, ["backlog", "todo", "in_progress", "in_review"]); result = { tasks: [candidate, { ...candidate, ...b }], nextCursor: null }; }
      else if (method === "listLabels") result = { labels: [label] };
      else if (method === "createTask") { created = input; result = { ok: true, task: { ...b, id: "new" } }; }
      else throw new Error("unexpected method");
      return outputSchema.parse(result);
    },
  }});
  await plugin(f.bb as never); store.upsert(item, "manual", f.home);
  const result = await f.rpc.pulse_task_recommend!({ id: item.id });
  assert.equal(result.match.key, a.key);
  assert.equal((f.calls["plugins.callRpc"] ?? []).some(([args]: any) => args.method === "listLabels"), false);
  assert.deepEqual(await f.rpc.pulse_task_labels!({ projectId: "p1" }), { labels: [label] });
  const found = await f.rpc.pulse_task_search!({ search: "bins" });
  assert.equal(found.tasks[0].key, a.key);
  await f.rpc.pulse_task_create!({ id: item.id, projectId: "p1", title: "Edited", description: "Edited description", labelIds: [label.id] });
  assert.deepEqual(created, { projectId: "p1", title: "Edited", description: "Edited description", labelIds: [label.id] });
});

test("recommendation forwards Jev's advertised question byte limit", async () => {
  const rows = [a, { ...a, id: "other", key: "ABC-3" }].map(t => ({ ...t, description: "", projectId: "p1", labelIds: [], updatedAt: "2026-01-01" }));
  const f = fakeBb({ settings: { taskAiRecommendations: true }, overrides: {
    "plugins.callRpc": ({ pluginId, method, input, outputSchema }: any) => {
      if (pluginId === "jev" && method === "status") { const status = jevStatus(); status.limits.maxQuestionBytes = 1024; return outputSchema.parse(status); }
      if (pluginId === "jev") {
        assert.ok(Buffer.byteLength(JSON.stringify(input.questions)) <= 1024);
        assert.equal(input.state.tasks.length, 1);
        return outputSchema.parse(jevSuccess());
      }
      return outputSchema.parse(method === "listProjects" ? { projects: [] } : { tasks: rows, nextCursor: null });
    },
  } });
  await plugin(f.bb as never); store.upsert(item, "manual", f.home);
  assert.equal((await f.rpc.pulse_task_recommend!({ id: item.id })).match.id, a.id);
});

test("concurrent recommendation requests share one Jev call", { timeout: 2000 }, async () => {
  const candidate = { ...a, projectId: "p1", labelIds: [], description: "", updatedAt: "2026-01-01" };
  let calls = 0; let resolve!: (value: unknown) => void;
  const f = fakeBb({ settings: { taskAiRecommendations: true }, overrides: {
    "plugins.callRpc": async ({ pluginId, method, outputSchema }: any) => {
      if (pluginId === "jev" && method === "status") return outputSchema.parse(jevStatus());
      if (pluginId === "jev") { calls++; return outputSchema.parse(await new Promise((r) => { resolve = r; })); }
      return outputSchema.parse(method === "listProjects" ? { projects: [{ id: "p1", name: "P", prefix: "ABC" }] } : method === "listLabels" ? { labels: [] } : { tasks: [candidate], nextCursor: null });
    },
  }});
  await plugin(f.bb as never); store.upsert(item, "manual", f.home);
  const first = f.rpc.pulse_task_recommend!({ id: item.id });
  const second = f.rpc.pulse_task_recommend!({ id: item.id });
  while (!resolve) await new Promise((r) => setTimeout(r, 1));
  resolve(jevSuccess());
  const [one, two] = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.deepEqual(one, two);
});

test("recommended link rechecks task status before linking", async () => {
  const f = setup(); await init(f);
  await assert.rejects(f.rpc.pulse_task_link!({ id: item.id, key: b.key, recommended: true }), /no longer open/);
  assert.deepEqual(store.getItem(item.id, f.home).taskLinks ?? [], []);
  await f.rpc.pulse_task_link!({ id: item.id, key: a.key, recommended: true });
  assert.equal(store.getItem(item.id, f.home).taskLinks[0].key, a.key);
});

test("recommendations default off and do not read tasks or call Jev", async () => {
  const f = setup(); await init(f);
  const result = await f.rpc.pulse_task_recommend!({ id: item.id });
  assert.deepEqual(result, { match: null, related: null, suggestions: [], projects: [] });
  assert.equal((f.calls["plugins.callRpc"] ?? []).some(([args]: any) => args.method === "listTasks"), false);
});

test("only all done closes; disabled, missing, canceled and offline fail safe", async () => {
  const f = setup(false); await init(f);
  await f.rpc.pulse_task_link!({ id: item.id, key: a.key });
  await f.rpc.pulse_task_link!({ id: item.id, key: b.key });
  f.tasks.get(a.id)!.status = "done";
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "open");
  await f.changeSettings({ closeOnTasksDone: true });
  f.tasks.get(a.id)!.status = "canceled";
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "open");
  f.tasks.delete(a.id);
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "open");
  f.tasks.set(a.id, { ...a, status: "done" }); f.offline(true);
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "open");
  f.offline(false);
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "done");
});

test("manual reopen holds until a linked task becomes incomplete and completes again", async () => {
  const f = setup(); await init(f);
  await f.rpc.pulse_task_link!({ id: item.id, key: b.key });
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "done");
  await f.rpc.pulse_action!({ id: item.id, action: "reopen" });
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "open");
  f.tasks.get(b.id)!.status = "todo";
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "open");
  f.tasks.get(b.id)!.status = "done";
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "done");
});

test("capture reopen and link changes preserve the reopen hold", async () => {
  const f = setup(); await init(f);
  await f.rpc.pulse_task_link!({ id: item.id, key: b.key });
  await f.startServices();
  store.upsert({ id: item.id, reopen: true, reason: "New activity" }, "hourly", f.home);
  await f.rpc.pulse_task_link!({ id: item.id, key: a.key });
  f.tasks.get(a.id)!.status = "done";
  await f.startServices();
  assert.equal(store.getItem(item.id, f.home).status, "open");
  await f.rpc.pulse_task_unlink!({ id: item.id, taskId: a.id });
  await f.startServices();
  assert.equal(store.getItem(item.id, f.home).status, "open");
});

test("a status-only capture reopen holds until incomplete; removing all links clears it", async () => {
  const f = setup(); await init(f);
  await f.rpc.pulse_task_link!({ id: item.id, key: b.key });
  store.upsert({ id: item.id, status: "resolved", reason: "Complete" }, "hourly", f.home);
  store.upsert({ id: item.id, status: "open" }, "hourly", f.home);
  await f.startServices();
  assert.equal(store.getItem(item.id, f.home).status, "open");
  await f.rpc.pulse_task_unlink!({ id: item.id, taskId: b.id });
  await f.rpc.pulse_task_link!({ id: item.id, key: b.key });
  await f.startServices();
  assert.equal(store.getItem(item.id, f.home).status, "done");
});

test("completed tasks close an actively snoozed item", async () => {
  const f = setup(); await init(f);
  await f.rpc.pulse_task_link!({ id: item.id, key: b.key });
  store.userAction(item.id, "snoozed", { until: "2099-01-01T00:00:00Z" }, f.home);
  await f.startServices();
  assert.equal(store.getItem(item.id, f.home).status, "done");
});

test("without Tasks the board still loads and linked items stay open", async () => {
  const f = setup(); await init(f);
  await f.rpc.pulse_task_link!({ id: item.id, key: b.key });
  f.offline(true);
  await f.startServices();
  assert.equal(store.getItem(item.id, f.home).status, "open");
  await f.rpc.pulse_task_unlink!({ id: item.id, taskId: b.id });
  assert.deepEqual(store.getItem(item.id, f.home).taskLinks, []);
});

test("a stalled optional Tasks plugin does not block snapshots or service shutdown", { timeout: 2000 }, async () => {
  const f = fakeBb({ settings: { closeOnTasksDone: true }, overrides: {
    "plugins.callRpc": ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  }});
  await plugin(f.bb as never);
  store.upsert(item, "manual", f.home);
  store.changeTaskLink(item.id, b, false, f.home);
  const snapshot = await f.rpc.pulse_snapshot!(null);
  assert.equal(snapshot.items[0].status, "open");
  await f.startServices();
  assert.equal(store.getItem(item.id, f.home).status, "open");
});

for (const [name, plugins] of [["missing", []], ["disabled", [{ id: "jev", enabled: false, status: "disabled" }]]] as const) {
  test(`${name} Jev skips recommendation work but preserves manual Tasks actions`, async () => {
    const f = setup(true, [...plugins]); await init(f);
    await f.changeSettings({ taskAiRecommendations: true });
    const registryReads = f.count("plugins.list");
    const [one, two] = await Promise.all([f.rpc.pulse_task_recommend!({ id: item.id }), f.rpc.pulse_task_recommend!({ id: item.id })]);
    assert.deepEqual(one, { match: null, related: null, suggestions: [], projects: [] }); assert.deepEqual(one, two);
    assert.equal((await f.rpc.pulse_snapshot!(null)).taskSuggestions, name);
    assert.equal(f.count("plugins.list") - registryReads, 1);
    assert.equal((f.calls["plugins.callRpc"] ?? []).some(([args]: any) => args.pluginId === "jev" || args.method === "listTasks"), false);
    assert.equal((await f.rpc.pulse_task_search!({ search: "" })).tasks.length, 2);
    await f.rpc.pulse_task_create!({ id: item.id, projectId: "p1", title: "Manual" });
    await f.rpc.pulse_task_link!({ id: item.id, key: a.key });
    await f.rpc.pulse_task_unlink!({ id: item.id, taskId: a.id });
    assert.equal(store.getItem(item.id, f.home).taskLinks.length, 1);
  });
}

test("stalled Jev discovery shares its deadline without blocking snapshots", { timeout: 7000 }, async () => {
  const f = fakeBb({ settings: { taskAiRecommendations: true }, overrides: {
    "plugins.list": () => new Promise(() => {}),
  } });
  await plugin(f.bb as never);
  store.upsert(item, "manual", f.home);
  const one = f.rpc.pulse_task_recommend!({ id: item.id });
  const two = f.rpc.pulse_task_recommend!({ id: item.id });
  const started = Date.now();
  assert.equal((await f.rpc.pulse_snapshot!(null)).taskSuggestions, "checking");
  assert.ok(Date.now() - started < 1000);
  const [first, second] = await Promise.all([one, two]);
  assert.deepEqual(first, { match: null, related: null, suggestions: [], projects: [] });
  assert.deepEqual(first, second);
  assert.equal((await f.rpc.pulse_snapshot!(null)).taskSuggestions, "unavailable");
  assert.equal(f.count("plugins.list"), 1);
  assert.equal((f.calls["plugins.callRpc"] ?? []).some(([args]: any) => args.pluginId === "jev" || args.method === "listTasks"), false);
});

test("wake and undo snooze do not create a hold for completed tasks", async () => {
  for (const status of ["open", "waiting"] as const) {
    const f = setup(); await init(f);
    await f.rpc.pulse_task_link!({ id: item.id, key: b.key });
    store.userAction(item.id, "snoozed", { until: "2099-01-01T00:00:00Z" }, f.home);
    store.userAction(item.id, status, {}, f.home);
    assert.notEqual(store.getItem(item.id, f.home).taskReopenHold, true);
    await f.startServices();
    assert.equal(store.getItem(item.id, f.home).status, "done");
  }
});

test("capture waking a snooze follows the same reopen-hold rule", async () => {
  const f = setup(); await init(f);
  await f.rpc.pulse_task_link!({ id: item.id, key: b.key });
  store.userAction(item.id, "snoozed", { until: "2099-01-01T00:00:00Z" }, f.home);
  store.upsert({ id: item.id, reopen: true, reason: "Wake" }, "hourly", f.home);
  assert.notEqual(store.getItem(item.id, f.home).taskReopenHold, true);
  await f.startServices(); assert.equal(store.getItem(item.id, f.home).status, "done");
});

test("a transport failure stops a multi-item reconciliation pass", async () => {
  let reads = 0;
  const f = fakeBb({ settings: { closeOnTasksDone: true }, overrides: {
    "plugins.callRpc": ({ method, outputSchema }: any) => {
      if (method === "listProjects") return outputSchema.parse({ projects: [] });
      if (method === "getTask") { reads++; throw new Error("Tasks transport failed"); }
      throw new Error("unexpected method");
    },
  }});
  await plugin(f.bb as never);
  for (let i = 0; i < 5; i++) {
    const id = `slack:failed-${i}`;
    store.upsert({ ...item, id }, "manual", f.home); store.changeTaskLink(id, a, false, f.home);
  }
  await f.startServices();
  assert.equal(reads, 1);
  assert.equal(f.warns.filter((warning) => warning.startsWith("task reconcile")).length, 1);
});

test("a read that fails for one item doesn't starve the items after it", async () => {
  let reads = 0;
  const f = fakeBb({ settings: { closeOnTasksDone: true }, overrides: {
    "plugins.callRpc": ({ method, input, outputSchema }: any) => {
      if (method === "listProjects") return outputSchema.parse({ projects: [] });
      if (method !== "getTask") throw new Error("unexpected method");
      reads++;
      if (input.taskId === a.id) throw new Error("Task cannot be read");
      return outputSchema.parse({ task: { id: b.id, key: b.key, title: b.title, status: "done" } });
    },
  }});
  await plugin(f.bb as never);
  // Two items whose task read always fails, then one whose linked task is done. Ids sort in this
  // order and the store sorts by first sight, so the third item is always reconciled last.
  for (const id of ["slack:a-bad-0", "slack:a-bad-1"]) {
    store.upsert({ ...item, id }, "manual", f.home);
    store.changeTaskLink(id, a, false, f.home);
  }
  store.upsert({ ...item, id: "slack:z-good" }, "manual", f.home);
  store.changeTaskLink("slack:z-good", b, false, f.home);
  await f.startServices();
  assert.equal(reads, 3, "the last item is still read after two failures");
  assert.equal(store.getItem("slack:z-good", f.home).status, "done");
  assert.equal(store.getItem("slack:a-bad-0", f.home).status, "open", "a failed read never closes anything");
  assert.equal(f.warns.filter((w) => w.startsWith("task reconcile")).length, 2);
});

test("a pass stops after repeated failures, so Tasks being down costs three reads", async () => {
  let reads = 0;
  const f = fakeBb({ settings: { closeOnTasksDone: true }, overrides: {
    "plugins.callRpc": ({ method, outputSchema }: any) => {
      if (method === "listProjects") return outputSchema.parse({ projects: [] });
      reads++;
      throw new Error("Task cannot be read");
    },
  }});
  await plugin(f.bb as never);
  for (let i = 0; i < 5; i++) {
    const id = `slack:down-${i}`;
    store.upsert({ ...item, id }, "manual", f.home); store.changeTaskLink(id, a, false, f.home);
  }
  await f.startServices();
  assert.equal(reads, 3);
});

test("stale task reads cannot close an item after a user changes it", () => {
  const f = setup(); store.upsert(item, "manual", f.home);
  store.changeTaskLink(item.id, b, false, f.home);
  const old = store.getItem(item.id, f.home);
  store.userAction(item.id, "snoozed", { until: "2099-01-01T00:00:00Z" }, f.home);
  assert.equal(store.reconcileTasks(item.id, old, true, f.home), false);
  assert.equal(store.getItem(item.id, f.home).status, "snoozed");
});
