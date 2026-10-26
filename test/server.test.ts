// Server paths behind past outages: dead run threads, unrecorded action threads,
// schedule state after a settings change, and thread probes per snapshot.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../server.ts";
import * as store from "../lib/store.mjs";

type Fn = (...args: any[]) => any;

function fakeBb(overrides: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-server-"));
  const kv = new Map<string, unknown>();
  const rpc: Record<string, Fn> = {};
  const events: Record<string, Fn[]> = {};
  const calls: Record<string, unknown[][]> = {};
  const onChange: Fn[] = [];
  const disposers: Fn[] = [];
  let values: Record<string, unknown> = {};
  const record = (name: string, impl: Fn = () => undefined) => async (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return impl(...args);
  };
  const threads: Record<string, Fn> = {
    get: () => ({ id: "x", archivedAt: null, deletedAt: null, visibility: "hidden", status: "idle" }),
    spawn: () => ({ id: "thr_new" }),
    send: () => ({}),
    update: () => ({}),
    stop: () => ({}),
    archive: () => ({}),
    output: () => ({ output: null }),
    ...(overrides as Record<string, Fn>),
  };
  const bb = {
    settings: {
      define(desc: Record<string, { default?: unknown }>) {
        const defaults = Object.fromEntries(Object.entries(desc).map(([k, d]) => [k, d.default ?? ""]));
        values = { ...defaults, project: "proj_1", storeDir: home };
        return { get: async () => ({ ...values }), onChange: (f: Fn) => onChange.push(f) };
      },
    },
    status: { needsConfiguration: () => undefined },
    storage: { kv: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) } },
    sdk: {
      threads: Object.fromEntries(Object.entries(threads).map(([k, f]) => [k, record(`threads.${k}`, f)])),
      threadSections: { list: async () => [{ id: "sec_1", name: "Pulse" }], create: async () => ({ id: "sec_1" }) },
      plugins: { callRpc: async () => ({}) },
    },
    log: { info: () => undefined, warn: () => undefined },
    background: { schedule: () => undefined, service: () => undefined },
    realtime: { publish: () => undefined },
    rpc: { register: (_c: unknown, handlers: Record<string, Fn>) => Object.assign(rpc, handlers) },
    events: { on: (name: string, f: Fn) => void (events[name] ??= []).push(f) },
    onDispose: (f: Fn) => void disposers.push(f),
  };
  const loaded = { bb, home, kv, rpc, calls,
    count: (name: string) => calls[name]?.length ?? 0,
    emit: (name: string, payload: unknown) => events[name]?.forEach((f) => f(payload)),
    changeSettings: (next: Record<string, unknown>) => { values = { ...values, ...next }; onChange.forEach((f) => f({ ...values })); },
  };
  live.push(async () => { for (const d of disposers) await d(); });
  return loaded;
}

// Close each plugin's store watcher and publish timer so the test process can exit.
const live: (() => Promise<void>)[] = [];
afterEach(async () => { while (live.length) await live.pop()!(); });

const item = { id: "slack:1", source: "slack", kind: "reply", title: "Answer Sam" };

test("a run whose cached thread was archived spawns and remembers a new one", async () => {
  const f = fakeBb({ get: () => ({ id: "thr_old", archivedAt: 1, deletedAt: null }) });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_old");
  const res = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(res.threadId, "thr_new");
  assert.equal(f.count("threads.send"), 0);
  assert.equal(f.kv.get("thread:hourly"), "thr_new");
  assert.equal(store.getRunThreads(f.home).hourly, "thr_new");
});

test("a run thread that dies between probe and send is replaced, not wedged", async () => {
  const f = fakeBb({ send: () => { throw new Error("409: thread is archived"); } });
  await plugin(f.bb as never);
  f.kv.set("thread:daily", "thr_old");
  const res = await f.rpc.pulse_run_now!({ run: "daily" });
  assert.equal(res.threadId, "thr_new");
  assert.equal(f.count("threads.spawn"), 1);
});

test("a pinned run thread whose send fails for good is skipped on later runs", async () => {
  const send = { ok: false };
  const f = fakeBb({
    send: ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_pinned" && !send.ok) throw new Error("409: environment is unavailable");
      return {};
    },
  });
  await plugin(f.bb as never);
  f.changeSettings({ hourlyThread: "thr_pinned" });
  const first = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(first.threadId, "thr_new");
  const second = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(second.threadId, "thr_new", "the replacement is reused, not another fresh thread");
  assert.equal(f.count("threads.spawn"), 1);
  assert.deepEqual(f.calls["threads.send"]?.map(([a]) => (a as { threadId: string }).threadId), ["thr_pinned", "thr_new"]);
  // Pinning a different thread tries the new pin.
  f.changeSettings({ hourlyThread: "thr_other" });
  const third = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(third.threadId, "thr_other");
  // Changing back to a repaired pin tries it again instead of trusting the old dead marker.
  send.ok = true;
  f.changeSettings({ hourlyThread: "thr_pinned" });
  const fourth = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(fourth.threadId, "thr_pinned");
});

test("an action thread that can't be recorded is stopped and archived, and the click fails", async () => {
  const f = fakeBb({
    // The item disappears while the thread spawns, so recording the action fails.
    spawn: () => { fs.writeFileSync(path.join(f.home, "items.json"), JSON.stringify({ version: 1, items: {} })); return { id: "thr_orphan" }; },
  });
  await plugin(f.bb as never);
  store.upsert([item], "hourly", f.home);
  await assert.rejects(f.rpc.pulse_start_action!({ id: item.id }), /Couldn't record the agent thread/);
  assert.deepEqual(f.calls["threads.stop"]?.[0]?.[0], { threadId: "thr_orphan" });
  assert.deepEqual(f.calls["threads.archive"]?.[0]?.[0], { threadId: "thr_orphan" });
});

test("a finished action thread settles to ready with its Ready line", async () => {
  const f = fakeBb({ spawn: () => ({ id: "thr_act" }) });
  await plugin(f.bb as never);
  store.upsert([item], "hourly", f.home);
  await f.rpc.pulse_start_action!({ id: item.id });
  f.emit("thread.idle", { thread: { id: "thr_act" }, lastAssistantText: "Drafted it.\n\n**Ready:** reply to Sam drafted" });
  const action = store.getItem(item.id, f.home).action;
  assert.equal(action.status, "ready");
  assert.equal(action.summary, "reply to Sam drafted");
});

test("a changed schedule shows as pending reload, not paused, until reload", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  f.changeSettings({ hourlyCron: "0 * * * *" });
  const snap = await f.rpc.pulse_snapshot!(null);
  const hourly = snap.automations.find((a: { run: string }) => a.run === "hourly");
  assert.equal(hourly.pendingReload, true);
  assert.equal(hourly.paused, false);
  assert.equal(hourly.enabled, false);
  assert.equal(snap.automations.find((a: { run: string }) => a.run === "daily").pendingReload, false);
});

test("back-to-back snapshots reuse thread probes; a run still probes fresh", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  for (const run of ["hourly", "daily", "weekly"]) f.kv.set(`thread:${run}`, `thr_${run}`);
  await f.rpc.pulse_snapshot!(null);
  const first = f.count("threads.get");
  assert.equal(first, 3);
  await f.rpc.pulse_snapshot!(null);
  await f.rpc.pulse_snapshot!(null);
  assert.equal(f.count("threads.get"), first);
  await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.ok(f.count("threads.get") > first);
});
