// Pulse Task settings: the kv row behind the Task integration section.
//
// Covers the contract's defaults, persistence under one key, refused input, the
// queue that makes concurrent patches land in order, and the rule that the cache
// and its listener only see a value the kv row has already accepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createTaskSettings,
  TASK_CONFIG_DEFAULTS,
  TASK_SETTINGS_KEY,
  taskConfigPatchSchema,
  taskSettingsStateSchema,
  type TaskConfig,
} from "../lib/task-settings.ts";

type Deferred = { promise: Promise<void>; resolve: () => void };
function gate(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeBb(seed: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(Object.entries(seed));
  const writes: TaskConfig[] = [];
  const warns: string[] = [];
  /** When set, every kv write waits on the next gate before it lands (or throws). */
  const gates: Deferred[] = [];
  let refuse: ((value: unknown) => boolean) | null = null;
  const kv = {
    async get(key: string) {
      return rows.get(key);
    },
    async set(key: string, value: unknown) {
      writes.push(structuredClone(value) as TaskConfig);
      const next = gates.shift();
      if (next) await next.promise;
      if (refuse?.(value)) throw new Error("kv write failed");
      rows.set(key, structuredClone(value));
    },
    async delete(key: string) {
      rows.delete(key);
    },
    async list(prefix = "") {
      return [...rows.keys()].filter((key) => key.startsWith(prefix));
    },
  };
  const bb = {
    storage: { kv },
    log: {
      debug() {},
      info() {},
      warn: (line: string) => void warns.push(line),
      error() {},
    },
  } as unknown as BbPluginApi;
  return {
    bb,
    kv,
    rows,
    writes,
    warns,
    /** Hold the next kv write open, so a test can look at the store mid-write. */
    hold: () => { const g = gate(); gates.push(g); return g; },
    refuseWrites: (match: (value: unknown) => boolean) => { refuse = match; },
  };
}

async function store(seed: Record<string, unknown> = {}) {
  const fake = fakeBb(seed);
  const changes: { next: TaskConfig; prev: TaskConfig }[] = [];
  const settings = await createTaskSettings({ bb: fake.bb, onChange: (next, prev) => void changes.push({ next, prev }) });
  return { ...fake, settings, changes };
}

test("a fresh install reads every option off, under the one key", async () => {
  const s = await store();
  assert.equal(TASK_SETTINGS_KEY, "taskIntegration");
  assert.deepEqual(s.settings.get(), TASK_CONFIG_DEFAULTS);
  assert.deepEqual(await s.settings.read(), { enabled: false, taskAiRecommendations: false, closeOnTasksDone: false });
  // Reading never writes a row of its own.
  assert.equal(s.writes.length, 0);
  assert.equal(s.rows.size, 0);
});

test("the store loads the stored row before it returns", async () => {
  const s = await store({ [TASK_SETTINGS_KEY]: { enabled: true, taskAiRecommendations: true, closeOnTasksDone: true } });
  // No read() by the test: get() is already the stored value, which is what gating sees at load.
  assert.deepEqual(s.settings.get(), { enabled: true, taskAiRecommendations: true, closeOnTasksDone: true });
  assert.equal(s.changes.length, 0, "loading is not a change, so no listener fires");
});

test("an update persists the merged row and reads back through a new instance", async () => {
  const s = await store();
  const next = await s.settings.update({ enabled: true, taskAiRecommendations: true });
  assert.deepEqual(next, { enabled: true, taskAiRecommendations: true, closeOnTasksDone: false });
  assert.deepEqual(s.rows.get(TASK_SETTINGS_KEY), next);
  assert.deepEqual(s.settings.get(), next);

  const again = await createTaskSettings({ bb: s.bb, onChange: () => {} });
  assert.deepEqual(await again.read(), next);
});

test("a patch leaves the options it omits alone, so the master switch never unsets them", async () => {
  const s = await store({ [TASK_SETTINGS_KEY]: { enabled: true, taskAiRecommendations: true, closeOnTasksDone: true } });
  await s.settings.read();
  const next = await s.settings.update({ enabled: false });
  assert.deepEqual(next, { enabled: false, taskAiRecommendations: true, closeOnTasksDone: true });
  assert.deepEqual(s.rows.get(TASK_SETTINGS_KEY), next);
});

test("a non-boolean or unknown option is refused before it reaches the row", async () => {
  const s = await store({ [TASK_SETTINGS_KEY]: { enabled: false, taskAiRecommendations: false, closeOnTasksDone: false } });
  await s.settings.read();
  for (const patch of [{ enabled: "yes" }, { taskAiRecommendations: 1 }, { closeOnTasksDone: "true" }, { closeOnTasksDone: null }, { retiredNativeKey: true }]) {
    await assert.rejects(s.settings.update(patch as unknown as Partial<TaskConfig>));
  }
  assert.equal(s.writes.length, 0);
  assert.deepEqual(s.rows.get(TASK_SETTINGS_KEY), { enabled: false, taskAiRecommendations: false, closeOnTasksDone: false });
  assert.deepEqual(s.settings.get(), { enabled: false, taskAiRecommendations: false, closeOnTasksDone: false });
  assert.equal(s.changes.length, 0);
});

test("concurrent patches to different options both land", async () => {
  const s = await store();
  await Promise.all([
    s.settings.update({ enabled: true }),
    s.settings.update({ taskAiRecommendations: true }),
    s.settings.update({ closeOnTasksDone: true }),
  ]);
  const expected = { enabled: true, taskAiRecommendations: true, closeOnTasksDone: true };
  assert.deepEqual(s.settings.get(), expected);
  assert.deepEqual(s.rows.get(TASK_SETTINGS_KEY), expected);
  // Each write merged over the one before it, so no patch was lost to a stale read.
  assert.equal(s.writes.length, 3);
  assert.deepEqual(s.writes.at(-1), expected);
  assert.equal(s.changes.length, 3);
  assert.deepEqual(s.changes.map((c) => c.prev.enabled), [false, true, true]);
});

test("the cache and the listener wait for the kv write to resolve", async () => {
  const s = await store({ [TASK_SETTINGS_KEY]: { enabled: false, taskAiRecommendations: false, closeOnTasksDone: false } });
  await s.settings.read();
  const held = s.hold();
  const writing = s.settings.update({ enabled: true });
  // Mid-write: still the old value, and nobody has been told otherwise.
  assert.deepEqual(s.settings.get(), { enabled: false, taskAiRecommendations: false, closeOnTasksDone: false });
  assert.equal(s.changes.length, 0);
  held.resolve();
  assert.deepEqual(await writing, { enabled: true, taskAiRecommendations: false, closeOnTasksDone: false });
  assert.equal(s.changes.length, 1);
  assert.deepEqual(s.changes[0], { next: { enabled: true, taskAiRecommendations: false, closeOnTasksDone: false }, prev: { enabled: false, taskAiRecommendations: false, closeOnTasksDone: false } });
});

test("a read that starts during a write returns the value that write commits", async () => {
  const s = await store({ [TASK_SETTINGS_KEY]: { enabled: false, taskAiRecommendations: true, closeOnTasksDone: false } });
  await s.settings.read();
  const held = s.hold();
  const writing = s.settings.update({ enabled: true });
  const reading = s.settings.read();
  held.resolve();
  await writing;
  assert.deepEqual(await reading, { enabled: true, taskAiRecommendations: true, closeOnTasksDone: false });
});

test("a failed kv write leaves the committed value and the listener untouched", async () => {
  const s = await store({ [TASK_SETTINGS_KEY]: { enabled: false, taskAiRecommendations: true, closeOnTasksDone: false } });
  await s.settings.read();
  s.refuseWrites((value) => (value as TaskConfig).enabled === true);
  await assert.rejects(s.settings.update({ enabled: true }), /kv write failed/);
  assert.deepEqual(s.settings.get(), { enabled: false, taskAiRecommendations: true, closeOnTasksDone: false });
  assert.deepEqual(s.rows.get(TASK_SETTINGS_KEY), { enabled: false, taskAiRecommendations: true, closeOnTasksDone: false });
  assert.equal(s.changes.length, 0);
  // The queue survives the failure: the next write still lands.
  s.refuseWrites(() => false);
  assert.deepEqual(await s.settings.update({ closeOnTasksDone: true }), { enabled: false, taskAiRecommendations: true, closeOnTasksDone: true });
});

test("a missing, corrupt or orphaned row reads as the defaults", async () => {
  for (const seed of [
    {},
    { [TASK_SETTINGS_KEY]: "not an object" },
    { [TASK_SETTINGS_KEY]: { enabled: true } },
    { [TASK_SETTINGS_KEY]: { enabled: true, taskAiRecommendations: true, closeOnTasksDone: true, retiredNativeKey: true } },
  ]) {
    const s = await store(seed);
    assert.deepEqual(await s.settings.read(), TASK_CONFIG_DEFAULTS, JSON.stringify(seed));
  }
});

test("a read failure warns and leaves the integration off instead of throwing", async () => {
  const s = await store();
  s.kv.get = async () => { throw new Error("kv unavailable"); };
  assert.deepEqual(await s.settings.read(), TASK_CONFIG_DEFAULTS);
  assert.match(s.warns.join("\n"), /Task settings could not be read/);
});

test("a patch that changes nothing commits and stays quiet", async () => {
  const s = await store({ [TASK_SETTINGS_KEY]: { enabled: true, taskAiRecommendations: false, closeOnTasksDone: false } });
  await s.settings.read();
  await s.settings.update({ enabled: true });
  assert.equal(s.changes.length, 0);
  assert.equal(s.writes.length, 1);
});

test("callers cannot reach into the cached value", async () => {
  const s = await store();
  const reading = await s.settings.read();
  reading.enabled = true;
  assert.equal(s.settings.get().enabled, false);
  const updated = await s.settings.update({ enabled: true });
  updated.enabled = false;
  assert.equal(s.settings.get().enabled, true);
});

test("the shared contract accepts a partial update and describes the state it returns", () => {
  assert.deepEqual(taskConfigPatchSchema.parse({ enabled: true }), { enabled: true });
  assert.deepEqual(taskConfigPatchSchema.parse({}), {});
  assert.equal(taskConfigPatchSchema.safeParse({ enabled: "yes" }).success, false);
  assert.equal(taskConfigPatchSchema.safeParse({ tasksPluginEnabled: true }).success, false);
  assert.equal(taskSettingsStateSchema.safeParse({ enabled: true, taskAiRecommendations: false, closeOnTasksDone: false }).success, false);
  assert.deepEqual(
    taskSettingsStateSchema.parse({ enabled: true, taskAiRecommendations: false, closeOnTasksDone: false, tasksPluginEnabled: true }),
    { enabled: true, taskAiRecommendations: false, closeOnTasksDone: false, tasksPluginEnabled: true },
  );
});
