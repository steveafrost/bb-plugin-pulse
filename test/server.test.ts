// Server paths behind past outages: dead run threads, unrecorded action threads,
// schedule state after a settings change, and thread probes per snapshot.
//
// Items now come from the iPhone's snapshot, so the harness gives each plugin its
// own mirror directory and a helper to publish a snapshot into it.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../server.ts";
import * as store from "../lib/store.mjs";

type Fn = (...args: any[]) => any;

function fakeBb(overrides: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "thirdhand-server-"));
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), "thirdhand-mirror-"));
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
        values = { ...defaults, project: "proj_1", storeDir: home, snapshotDir: mirror };
        return { get: async () => ({ ...values }), onChange: (f: Fn) => onChange.push(f) };
      },
    },
    status: { needsConfiguration: () => undefined },
    storage: { kv: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) } },
    sdk: {
      threads: Object.fromEntries(Object.entries(threads).map(([k, f]) => [k, record(`threads.${k}`, f)])),
      threadSections: { list: async () => [{ id: "sec_1", name: "Third Hand" }], create: async () => ({ id: "sec_1" }) },
      plugins: { callRpc: async () => ({}) },
    },
    log: { info: () => undefined, warn: () => undefined },
    background: { schedule: () => undefined, service: () => undefined },
    realtime: { publish: () => undefined },
    rpc: { register: (_c: unknown, handlers: Record<string, Fn>) => Object.assign(rpc, handlers) },
    events: { on: (name: string, f: Fn) => void (events[name] ??= []).push(f) },
    onDispose: (f: Fn) => void disposers.push(f),
  };
  const loaded = { bb, home, mirror, kv, rpc, calls,
    /** Publish a snapshot the way the iPhone app would. */
    publishSnapshot: (items: unknown[], extra: Record<string, unknown> = {}) => {
      fs.writeFileSync(path.join(mirror, "snapshot.json"), JSON.stringify({
        schemaVersion: 1, generatedAt: new Date().toISOString(), deviceName: "iPhone", lastViewedAt: null, items, runs: [], draft: null, ...extra,
      }));
    },
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

const item = {
  id: "slack:1", source: "slack", kind: "reply", title: "Answer Sam", detail: "", url: null, due: null,
  priority: "normal", people: [], status: "open", snoozedUntil: null, resolution: null,
  firstSeenAt: "2026-10-23T08:00:00.000Z", lastSeenAt: "2026-10-23T08:00:00.000Z",
  updatedAt: "2026-10-23T08:00:00.000Z", resolvedAt: null, lastChangedBy: "capture", history: [], quickActions: [],
};

test("a run whose cached thread was archived spawns and remembers a new one", async () => {
  const f = fakeBb({ get: () => ({ id: "thr_old", archivedAt: 1, deletedAt: null }) });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_old");
  const res = await f.rpc.thirdhand_run_now!({ run: "hourly" });
  assert.equal(res.threadId, "thr_new");
  assert.equal(f.count("threads.send"), 0);
  assert.equal(f.kv.get("thread:hourly"), "thr_new");
  assert.equal(store.getRunThreads(f.home).hourly, "thr_new");
});

test("a run thread that dies between probe and send is replaced, not wedged", async () => {
  const f = fakeBb({ send: () => { throw new Error("409: thread is archived"); } });
  await plugin(f.bb as never);
  f.kv.set("thread:daily", "thr_old");
  const res = await f.rpc.thirdhand_run_now!({ run: "daily" });
  assert.equal(res.threadId, "thr_new");
  assert.equal(f.count("threads.spawn"), 1);
});

test("an action thread that can't be recorded is stopped and archived, and the click fails", async () => {
  const f = fakeBb({
    // The app republishes without the item while the thread spawns, so recording
    // the action finds no item and rejects.
    spawn: () => { f.publishSnapshot([]); return { id: "thr_orphan" }; },
  });
  await plugin(f.bb as never);
  f.publishSnapshot([item]);
  await assert.rejects(f.rpc.thirdhand_start_action!({ id: item.id }), /Couldn't record the agent thread/);
  assert.deepEqual(f.calls["threads.stop"]?.[0]?.[0], { threadId: "thr_orphan" });
  assert.deepEqual(f.calls["threads.archive"]?.[0]?.[0], { threadId: "thr_orphan" });
});

test("a finished action thread settles to ready with its Ready line", async () => {
  const f = fakeBb({ spawn: () => ({ id: "thr_act" }) });
  await plugin(f.bb as never);
  f.publishSnapshot([item]);
  await f.rpc.thirdhand_start_action!({ id: item.id });
  f.emit("thread.idle", { thread: { id: "thr_act" }, lastAssistantText: "Drafted it.\n\n**Ready:** reply to Sam drafted" });
  // The action record is Mac-local state (the app never sees it), so it lands in
  // the plugin's own state directory rather than the snapshot.
  const snap = await f.rpc.thirdhand_snapshot!(null);
  const action = snap.items.find((i: { id: string }) => i.id === item.id).action;
  assert.equal(action.status, "ready");
  assert.equal(action.summary, "reply to Sam drafted");
});

test("a changed schedule shows as pending reload, not paused, until reload", async () => {
  // Mac schedules are opt-in now that the iPhone captures, so this path only
  // exists with captureRuns="mac".
  const f = fakeBb();
  await plugin(f.bb as never);
  f.changeSettings({ captureRuns: "mac" });
  f.changeSettings({ hourlyCron: "0 * * * *" });
  const snap = await f.rpc.thirdhand_snapshot!(null);
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
  await f.rpc.thirdhand_snapshot!(null);
  const first = f.count("threads.get");
  assert.equal(first, 3);
  await f.rpc.thirdhand_snapshot!(null);
  await f.rpc.thirdhand_snapshot!(null);
  assert.equal(f.count("threads.get"), first);
  await f.rpc.thirdhand_run_now!({ run: "hourly" });
  assert.ok(f.count("threads.get") > first);
});

test("a panel action queues a command for the iPhone and marks the item pending", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  f.publishSnapshot([item]);
  const snap = await f.rpc.thirdhand_action!({ id: item.id, action: "done" });
  const row = snap.items.find((i: { id: string }) => i.id === item.id);
  // The iPhone owns content: the status is unchanged, only the marker is added.
  assert.equal(row.status, "open");
  assert.deepEqual(row.pending, ["done"]);
  assert.equal(snap.mirror.pendingCount, 1);
  const lines = fs.readFileSync(path.join(f.mirror, "commands.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].op, "done");
  assert.equal(lines[0].itemId, item.id);
});

test("an acknowledged command stops showing as pending", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  f.publishSnapshot([item]);
  const first = await f.rpc.thirdhand_action!({ id: item.id, action: "dismiss" });
  const id = first.items.find((i: { id: string }) => i.id === item.id).pending.length ? JSON.parse(fs.readFileSync(path.join(f.mirror, "commands.jsonl"), "utf8").trim()).id : null;
  assert.ok(id);
  // The app acknowledges, then republishes.
  fs.writeFileSync(path.join(f.mirror, "commands.ack.jsonl"), `${JSON.stringify({ id })}\n`);
  f.publishSnapshot([{ ...item, status: "dismissed" }], { generatedAt: new Date(Date.now() + 1000).toISOString() });
  const snap = await f.rpc.thirdhand_snapshot!(null);
  const row = snap.items.find((i: { id: string }) => i.id === item.id);
  assert.equal(row.status, "dismissed");
  assert.equal(row.pending, undefined);
  assert.equal(snap.mirror.pendingCount, 0);
});

test("an unreachable mirror still renders a board and says why", async () => {
  const f = fakeBb();
  fs.rmSync(path.join(f.mirror, "snapshot.json"), { force: true });
  await plugin(f.bb as never);
  const snap = await f.rpc.thirdhand_snapshot!(null);
  assert.equal(snap.mirror.state, "not-connected");
  assert.deepEqual(snap.items, []);
  assert.equal(snap.mirror.dir, f.mirror);
});
