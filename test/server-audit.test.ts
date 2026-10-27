// Regression tests for the 0.1.13 server audit (audit/server.md), plus the server side of the
// capture and UI audits. Each test names the finding it covers. The fake bb records schedules,
// services, events, warnings and every SDK call, and keeps a per-thread queue so queue-if-active
// sends to a busy thread behave like the host's.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import plugin from "../server.ts";
import * as store from "../lib/store.mjs";

import { cronAt, fakeBb, MIN, settle, type Fn } from "./fake-bb.ts";

// ---- server.md #1 / improvement 1: a turn that died after the send counted as a success ----
test("server#1 a run turn that fails is retried once, then recorded for the panel", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_run");
  await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.ok(f.events["turn.failed"], "turn.failed is observed");
  const before = Date.now();
  await f.emit("turn.failed", { threadId: "thr_run", requestId: "creq_1", turnId: null, errorInfo: { category: "connection-failed", httpStatusCode: null, providerCode: null }, inputAccepted: false, rateLimits: null, attemptNumber: 1 });
  const [retry] = f.calls["threads.retry"]![0] as [{ threadId: string; turnRequestId: string; sendAt: number }];
  assert.equal(retry.threadId, "thr_run");
  assert.equal(retry.turnRequestId, "creq_1");
  assert.ok(retry.sendAt >= before + 4 * MIN && retry.sendAt <= Date.now() + 6 * MIN);
  await f.emit("turn.failed", { threadId: "thr_run", requestId: "creq_2", turnId: null, errorInfo: { category: "connection-failed", httpStatusCode: null, providerCode: null }, inputAccepted: false, rateLimits: null, attemptNumber: 2 });
  assert.equal(f.count("threads.retry"), 1, "only one automatic retry");
  const hourly = await f.automation("hourly");
  assert.match(hourly.failure.error, /connection-failed/);
  assert.ok(f.warns.some((w) => /hourly run on thr_run failed/.test(w)));
  // A later logged run clears it.
  await settle();
  store.logRun({ run: "hourly", summary: "ok", sources: ["slack"] }, f.home);
  assert.equal((await f.automation("hourly")).failure, null);
});

test("server#1 a failure in a pinned (user) thread is recorded, never retried", async () => {
  const f = fakeBb({ settings: { hourlyThread: "thr_mine" } });
  await plugin(f.bb as never);
  await f.emit("turn.failed", { threadId: "thr_mine", requestId: "creq_1", turnId: null, errorInfo: null, inputAccepted: true, rateLimits: null, attemptNumber: 1 });
  assert.equal(f.count("threads.retry"), 0);
  assert.ok((await f.automation("hourly")).failure);
});

test("server#1 a sent run with no log after 45 minutes is overdue, and a failing schedule is logged", async () => {
  // Daily and Weekly far from now, so the Hourly doesn't yield to them (the 16:30 default would near 16:00).
  const f = fakeBb({ settings: { dailyCron: cronAt(180), weeklyCron: cronAt(240) }, overrides: { "threads.send": () => { throw new Error("JSON-RPC request timed out: thread/resume"); } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_run");
  // The hourly default may not be due now (weekday hours); call the registered callback directly.
  await assert.rejects(f.tick("hourly"), /timed out/);
  assert.ok(f.warns.some((w) => /scheduled hourly run failed: JSON-RPC request timed out/.test(w)));
  assert.match((await f.automation("hourly")).failure.error, /thread\/resume/);
  f.kv.set("dispatches:daily", [{ at: new Date(Date.now() - 50 * MIN).toISOString(), threadId: "thr_d", trigger: "schedule" }]);
  assert.equal((await f.automation("daily")).overdue, true);
  f.kv.set("dispatches:weekly", [{ at: new Date(Date.now() - 10 * MIN).toISOString(), threadId: "thr_w", trigger: "schedule" }]);
  assert.equal((await f.automation("weekly")).overdue, false);
});

// ---- server.md #2 / improvement 4: scheduled prompts piled up behind a busy run thread ----
test("server#2 runs sent to a busy thread collapse into one queued prompt with the current stamp", async () => {
  const f = fakeBb({ threads: { thr_run: { status: "active" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_run");
  await f.emit("thread.active", { thread: { id: "thr_run" } });
  for (let i = 0; i < 3; i++) await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(f.count("threads.send"), 1, "one send; the next two update the queued row");
  assert.equal(f.count("queued.update"), 2);
  assert.equal(f.queues.get("thr_run")!.length, 1);
  // Superseded dispatches don't count as runs that didn't finish.
  assert.equal((f.kv.get("dispatches:hourly") as unknown[]).length, 1);
});

test("server#2 a scheduled run skips a thread that has been busy for over an hour", async () => {
  const f = fakeBb({ threads: { thr_run: { status: "active" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_run");
  f.kv.set("dispatches:hourly", [{ at: new Date(Date.now() - 70 * MIN).toISOString(), threadId: "thr_run", trigger: "schedule" }]);
  // Daily and Weekly far from now, so the Hourly doesn't yield to them.
  f.changeSettings({ dailyCron: cronAt(180), weeklyCron: cronAt(240) });
  await f.tick("hourly");
  assert.equal(f.count("threads.send"), 0);
  assert.match((await f.automation("hourly")).failure.error, /busy for 7\d min/);
});

test("server#2 a new run drops a pending automatic retry instead of running twice", async () => {
  const f = fakeBb({ threads: { thr_run: { status: "error" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_run");
  f.queues.set("thr_run", [{ id: "qr", updatedAt: 1, payload: { kind: "retry" }, content: [{ type: "text", text: "[Pulse scheduled hourly run · old]" }] }]);
  await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.deepEqual(f.calls["queued.delete"]?.map(([a]) => (a as { queuedMessageId: string }).queuedMessageId), ["qr"]);
  assert.equal(f.count("threads.send"), 1);
});

test("server#4 an Hourly tick that yielded to the Daily is not caught up later", async () => {
  // Daily 30 minutes after the Hourly tick, both in the past: the Hourly skipped on purpose.
  const hourly = cronAt(-80);
  const daily = cronAt(-50);
  const f = fakeBb({ settings: { hourlyCron: hourly, dailyCron: daily, weeklyCron: "" }, kv: { "cron:hourly": hourly, "cron:daily": daily } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_h");
  f.kv.set("dispatches:hourly", [{ at: new Date(Date.now() - 23 * 60 * MIN).toISOString(), threadId: "thr_h", trigger: "schedule" }]);
  f.kv.set("dispatches:daily", [{ at: new Date(Date.now() - 50 * MIN).toISOString(), threadId: "thr_d", trigger: "schedule" }]);
  store.logRun({ run: "daily", summary: "ok", sources: ["slack"] }, f.home);
  await f.startServices();
  assert.equal(f.count("threads.send"), 0);
});

// ---- server.md #3 / improvement 6: a cron bb rejected showed as enabled with a next run ----
test("server#3 a schedule bb refuses shows as not running, with bb's reason", async () => {
  const f = fakeBb({ settings: { hourlyCron: "0 9-30 * * *" } });
  f.bb.background.schedule = (name: string, cron: string, fn: Fn) => {
    if (/9-30/.test(cron)) throw new Error(`invalid cron "${cron}" for schedule "${name}": Constraint error, got range 9-30 expected range 0-23`);
    f.schedules[name] = { cron, fn };
  };
  await plugin(f.bb as never);
  const hourly = await f.automation("hourly");
  assert.equal(hourly.enabled, false);
  assert.equal(hourly.nextRunAt, null);
  assert.match(hourly.scheduleError, /Constraint error/);
});

test("server improvement 6: a changed cron that bb will refuse is flagged before the reload", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  f.changeSettings({ dailyCron: "0 16-30 * * *", storeDir: "/tmp/elsewhere" });
  const snap = await f.rpc.pulse_snapshot!(null);
  const daily = snap.automations.find((a: { run: string }) => a.run === "daily");
  assert.equal(daily.pendingReload, true);
  assert.match(daily.pendingError, /hour 30 is out of range/);
  assert.equal(snap.homePending, true);
  assert.ok(f.warns.some((w) => /daily schedule .* is not valid/.test(w)));
});

test("server improvement 6: a project set after load is reported, since bb keeps the needs-configuration flag", async () => {
  const f = fakeBb({ settings: { project: "" } });
  await plugin(f.bb as never);
  assert.equal((await f.rpc.pulse_snapshot!(null)).needsProject, true);
  f.changeSettings({ project: "proj_2" });
  const snap = await f.rpc.pulse_snapshot!(null);
  assert.equal(snap.needsProject, false);
  assert.equal(snap.projectSetLive, true);
});

// ---- server.md #4 / improvement 3: a run due while Pulse was not loaded was skipped ----
test("server#4 a tick missed across a reload is caught up on load", async () => {
  const cron = cronAt(-10);
  const f = fakeBb({ settings: { dailyCron: cron, hourlyCron: "", weeklyCron: "" }, kv: { "cron:daily": cron } });
  await plugin(f.bb as never);
  f.kv.set("thread:daily", "thr_daily");
  f.kv.set("dispatches:daily", [{ at: new Date(Date.now() - 24 * 60 * MIN + 5 * MIN).toISOString(), threadId: "thr_daily", trigger: "schedule" }]);
  await f.startServices();
  assert.deepEqual(f.sends(), ["thr_daily"]);
  assert.match((f.calls["threads.send"]![0]![0] as { input: { text: string }[] }).input[0]!.text, /^\[Pulse catch-up daily run · /);
});

test("server#4 no catch-up when the tick already ran, on a fresh install, or right after a schedule change", async () => {
  const cron = cronAt(-10);
  const changed = fakeBb({ settings: { dailyCron: cron, hourlyCron: "", weeklyCron: "" }, kv: { "cron:daily": "0 16 * * *" } });
  await plugin(changed.bb as never);
  changed.kv.set("thread:daily", "thr_daily");
  changed.kv.set("dispatches:daily", [{ at: new Date(Date.now() - 24 * 60 * MIN + 5 * MIN).toISOString(), threadId: "thr_daily", trigger: "schedule" }]);
  await changed.startServices();
  assert.equal(changed.count("threads.send"), 0, "a tick under the new schedule was never due under the old one");
  assert.equal(changed.kv.get("cron:daily"), cron, "the next load compares against this schedule");
  const ran = fakeBb({ settings: { dailyCron: cron, hourlyCron: "", weeklyCron: "" }, kv: { "cron:daily": cron } });
  await plugin(ran.bb as never);
  ran.kv.set("thread:daily", "thr_daily");
  ran.kv.set("dispatches:daily", [{ at: new Date(Date.now() - 9 * MIN).toISOString(), threadId: "thr_daily", trigger: "schedule" }]);
  await ran.startServices();
  assert.equal(ran.count("threads.send"), 0);
  const fresh = fakeBb({ settings: { dailyCron: cron, hourlyCron: "", weeklyCron: "" }, kv: { "cron:daily": cron } });
  await plugin(fresh.bb as never);
  await fresh.startServices();
  assert.equal(fresh.count("threads.send") + fresh.count("threads.spawn"), 0);
});

// ---- server.md #5: a failing pin threw away the healthy cached thread ----
test("server#5 a failing pinned thread falls back to the cached run thread", async () => {
  const f = fakeBb({
    overrides: { "threads.send": ({ threadId }: { threadId: string }) => { if (threadId === "thr_pinned") throw new Error("409: environment is unavailable"); return {}; } },
  });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_cached");
  store.setRunThread("hourly", "thr_cached", f.home);
  f.changeSettings({ hourlyThread: "thr_pinned" });
  const res = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(res.threadId, "thr_cached");
  assert.equal(f.count("threads.spawn"), 0);
  assert.equal(f.kv.get("thread:hourly"), "thr_cached");
});

// ---- server.md #6: pinning a visible thread hid it ----
test("server#6 a pinned thread keeps its visibility; Pulse's own threads are hidden", async () => {
  const f = fakeBb({ threads: { thr_mine: { visibility: "visible" }, thr_own: { visibility: "visible" } } });
  await plugin(f.bb as never);
  f.changeSettings({ dailyThread: "thr_mine" });
  await f.rpc.pulse_run_now!({ run: "daily" });
  f.kv.set("thread:weekly", "thr_own");
  await f.rpc.pulse_run_now!({ run: "weekly" });
  await settle();
  assert.deepEqual(f.calls["threads.update"]?.map(([a]) => (a as { threadId: string }).threadId), ["thr_own"]);
});

// ---- server.md improvement 2: rotate run threads ----
test("server improvement 2: a day-old idle run thread is replaced and archived; a busy or pinned one is kept", async () => {
  const old = Date.now() - 25 * 60 * MIN;
  const f = fakeBb({ threads: { thr_old: { createdAt: old }, thr_busy: { createdAt: old, status: "active" }, thr_pin: { createdAt: old } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_old");
  const res = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(res.threadId, "thr_new");
  assert.deepEqual(f.calls["threads.archive"]?.map(([a]) => (a as { threadId: string }).threadId), ["thr_old"]);
  assert.equal(store.getRunThreads(f.home).hourly, "thr_new");
  f.kv.set("thread:daily", "thr_busy");
  assert.equal((await f.rpc.pulse_run_now!({ run: "daily" })).threadId, "thr_busy");
  f.changeSettings({ weeklyThread: "thr_pin" });
  assert.equal((await f.rpc.pulse_run_now!({ run: "weekly" })).threadId, "thr_pin");
  assert.equal(f.count("threads.archive"), 1);
});

// ---- server.md improvement 5: say when a pinned-thread setting is dead ----
test("server improvement 5: an archived pin shows as dead, a pin whose send failed as skipped", async () => {
  const f = fakeBb({
    threads: { thr_arch: { archivedAt: 1 } },
    overrides: { "threads.send": ({ threadId }: { threadId: string }) => { if (threadId === "thr_bad") throw new Error("409: environment is unavailable"); return {}; } },
  });
  await plugin(f.bb as never);
  f.changeSettings({ dailyThread: "thr_arch", weeklyThread: "thr_bad" });
  await f.rpc.pulse_run_now!({ run: "weekly" });
  assert.equal((await f.automation("daily")).pinState, "dead");
  assert.equal((await f.automation("weekly")).pinState, "skipped");
  assert.equal((await f.automation("hourly")).pinState, null);
});

// ---- server.md improvement 7: cheaper event paths ----
test("server improvement 7: thread events for unrelated threads don't re-read items.json", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  store.upsert([{ id: "slack:1", title: "Answer Sam" }], "hourly", f.home);
  const items = path.join(f.home, "items.json");
  const real = fs.readFileSync;
  let reads = 0;
  (fs as { readFileSync: Fn }).readFileSync = (file: unknown, ...rest: unknown[]) => { if (file === items) reads++; return (real as Fn)(file, ...rest); };
  try {
    for (let i = 0; i < 50; i++) await f.emit("thread.idle", { thread: { id: `thr_other${i}` }, lastAssistantText: "x" });
  } finally { (fs as { readFileSync: Fn }).readFileSync = real; }
  assert.ok(reads <= 1, `${reads} reads`);
});

// ---- server.md improvement 8: recover run threads from plugin metadata ----
test("server improvement 8: with kv and state.json gone, the run thread is found by its pulseRun metadata", async () => {
  const f = fakeBb({
    overrides: {
      "threads.list": () => [{ id: "thr_meta", createdAt: 5, archivedAt: null, deletedAt: null }, { id: "thr_act", createdAt: 9, archivedAt: null, deletedAt: null }],
      "threads.experimental_listPluginMetadata": () => ({ threads: [{ threadId: "thr_meta", metadata: { pulseRun: "hourly" } }, { threadId: "thr_act", metadata: { pulseItemId: "slack:1" } }] }),
    },
  });
  await plugin(f.bb as never);
  const res = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(res.threadId, "thr_meta");
  assert.equal(f.count("threads.spawn"), 0);
  assert.equal(store.getRunThreads(f.home).hourly, "thr_meta");
});

// ---- capture.md B3: Hourly and Daily started together every afternoon ----
test("capture B3 an Hourly slot within 45 minutes of a Daily run is skipped", async () => {
  const f = fakeBb({ settings: { dailyCron: cronAt(20), weeklyCron: "" } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_h");
  await f.tick("hourly");
  assert.equal(f.count("threads.send"), 0);
  assert.ok(f.infos.some((m) => /hourly run skipped: the Daily run is scheduled within 45 minutes/.test(m)));
  // A Daily that already fired at this slot counts too (bb runs due schedules one after another).
  f.changeSettings({});
  const g = fakeBb({ settings: { dailyCron: cronAt(-1), weeklyCron: "" } });
  await plugin(g.bb as never);
  g.kv.set("thread:hourly", "thr_h");
  await g.tick("hourly");
  assert.equal(g.count("threads.send"), 0);
});

test("capture B3 the Hourly still runs when the Daily is far off or paused", async () => {
  const f = fakeBb({ settings: { dailyCron: cronAt(180), weeklyCron: "" } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_h");
  await f.tick("hourly");
  assert.equal(f.count("threads.send"), 1);
  const g = fakeBb({ settings: { dailyCron: cronAt(10), weeklyCron: "" } });
  await plugin(g.bb as never);
  g.kv.set("thread:hourly", "thr_h");
  g.kv.set("paused:daily", true);
  await g.tick("hourly");
  assert.equal(g.count("threads.send"), 1);
});

// ---- capture.md B4 / I9: runs that never finished didn't show anywhere ----
test("capture B4 a dispatched run that never logged is listed as didn't finish", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  const now = Date.now();
  const t = (m: number) => new Date(now - m * MIN).toISOString();
  store.logRun({ run: "hourly", summary: "logged", sources: ["slack"], started: t(118) }, f.home);
  f.kv.set("dispatches:hourly", [
    { at: t(240), threadId: "thr_h", trigger: "schedule" },
    { at: t(118), threadId: "thr_h", trigger: "schedule" },
    { at: t(5), threadId: "thr_h", trigger: "schedule" },
  ]);
  const snap = await f.rpc.pulse_snapshot!(null);
  assert.deepEqual(snap.missedRuns.map((m: { at: string }) => m.at), [t(240)]);
});

// ---- capture.md B2: the installed skill pointed at a CLI path that doesn't exist ----
test("capture B2 the server writes <store>/bin/pulse, a launcher pinned to its store", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  const launcher = path.join(f.home, "bin", "pulse");
  assert.ok(fs.statSync(launcher).mode & 0o100, "executable");
  execFileSync(launcher, ["upsert", "--run", "manual"], { input: JSON.stringify([{ id: "slack:L/1", title: "via launcher" }]), env: { ...process.env, PULSE_HOME: "/nonexistent" } });
  assert.equal(store.getItem("slack:L/1", f.home).title, "via launcher");
});

// ---- ui.md improvement 1 (Undo): reopen restores the status the item had ----
test("ui improvement 1: Undo reopens an item to waiting when it was waiting", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  store.upsert([{ id: "slack:U/1", title: "t", status: "waiting" }], "hourly", f.home);
  await f.rpc.pulse_action!({ id: "slack:U/1", action: "done" });
  const snap = await f.rpc.pulse_action!({ id: "slack:U/1", action: "reopen", restore: "waiting" });
  assert.equal(snap.items.find((i: { id: string }) => i.id === "slack:U/1").status, "waiting");
});

// ---- store.md improvement 4 via the server: the reconcile pass wakes expired snoozes ----
test("store imp4 the server's housekeeping wakes an expired snooze without a capture run", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  store.upsert([{ id: "slack:Z/1", title: "t" }], "hourly", f.home);
  store.userAction("slack:Z/1", "snoozed", { until: new Date(Date.now() - 1000).toISOString() }, f.home);
  await f.startServices();
  const raw = JSON.parse(fs.readFileSync(path.join(f.home, "items.json"), "utf8")).items["slack:Z/1"];
  assert.equal(raw.status, "open");
  assert.equal(raw.history.at(-1).change, "snooze-expired");
});

// ---- Binks (bb-marketplace#131): an older run's log covered a newer dispatch ----
test("binks a stamped log covers only its own dispatch, so a newer prompt can still be overdue or missed", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);
  const now = Date.now();
  const t = (m: number) => new Date(now - m * MIN).toISOString();
  // Run A (sent 180m ago) was still going when B was queued 120m ago; A logs after B's send time.
  f.kv.set("dispatches:daily", [
    { at: t(180), threadId: "thr_d", trigger: "schedule" },
    { at: t(120), threadId: "thr_d", trigger: "schedule" },
  ]);
  store.logRun({ run: "daily", summary: "A", sources: ["slack"], started: t(180) }, f.home);
  assert.equal((await f.automation("daily")).overdue, true, "A's log doesn't stand in for B");
  const snap = await f.rpc.pulse_snapshot!(null);
  assert.deepEqual(snap.missedRuns.filter((m: { run: string }) => m.run === "daily").map((m: { at: string }) => m.at), [t(120)]);
  // B logs with its own stamp: covered.
  store.logRun({ run: "daily", summary: "B", sources: ["slack"], started: t(120) }, f.home);
  assert.equal((await f.automation("daily")).overdue, false);
});

test("binks recording a dispatch notifies the panel", async () => {
  const f = fakeBb({ threads: { thr_run: { status: "active" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_run");
  await f.emit("thread.active", { thread: { id: "thr_run" } });
  await f.rpc.pulse_run_now!({ run: "hourly" });
  await new Promise((r) => setTimeout(r, 300));
  const before = f.count("realtime.publish");
  await f.rpc.pulse_run_now!({ run: "hourly" }); // updates the queued row only
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(f.count("realtime.publish") > before, "a queued-row dispatch publishes a change");
});

test("binks two runs can't pin the same thread: the earlier run keeps it, the later uses its own", async () => {
  const f = fakeBb({ threads: { thr_mine: { status: "idle" } } });
  await plugin(f.bb as never);
  f.changeSettings({ dailyThread: "thr_mine", weeklyThread: "thr_mine" });
  assert.equal((await f.automation("daily")).pinState, "ok");
  assert.equal((await f.automation("weekly")).pinState, "shared");
  assert.ok(f.warns.some((w) => /weekly thread setting thr_mine is already the daily thread/.test(w)));
  assert.equal((await f.rpc.pulse_run_now!({ run: "daily" })).threadId, "thr_mine");
  const weekly = await f.rpc.pulse_run_now!({ run: "weekly" });
  assert.notEqual(weekly.threadId, "thr_mine", "weekly never sends to (or replaces a queued run in) the daily pin");
  assert.equal(f.count("threads.spawn"), 1);
});

test("binks a hung thread is reported stuck even when a Pulse prompt is already queued behind it", async () => {
  const f = fakeBb({ threads: { thr_run: { status: "active" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_run");
  f.kv.set("dispatches:hourly", [{ at: new Date(Date.now() - 70 * MIN).toISOString(), threadId: "thr_run", trigger: "manual" }]);
  f.queues.set("thr_run", [{ id: "q1", updatedAt: 1, payload: { kind: "user" }, content: [{ type: "text", text: "[Pulse manual hourly run · old]" }] }]);
  f.changeSettings({ dailyCron: cronAt(180), weeklyCron: cronAt(240) });
  await f.tick("hourly");
  assert.equal(f.count("queued.update"), 0, "the queued prompt is left alone");
  assert.match((await f.automation("hourly")).failure.error, /busy for 7\d min/);
});
