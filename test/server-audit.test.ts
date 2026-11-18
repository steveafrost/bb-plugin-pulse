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

import { cronAt, fakeBb, makeQueueEntry, MIN, settle, type Fn } from "./fake-bb.ts";

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
  f.queues.set("thr_run", [makeQueueEntry({ id: "qr", originPluginId: "pulse", payload: { kind: "retry" }, content: [{ type: "text", text: "[Pulse scheduled hourly run · old]" }] })]);
  await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.deepEqual(f.calls["queued.delete"]?.map(([a]) => (a as { queuedMessageId: string }).queuedMessageId), ["qr"]);
  // The thread stopped on an error, so the run goes to a fresh thread: still exactly one run.
  assert.equal(f.count("threads.send") + f.count("threads.spawn"), 1);
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

// ---- review: an older run's log covered a newer dispatch ----
test("review: a stamped log covers only its own dispatch, so a newer prompt can still be overdue or missed", async () => {
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

test("review: recording a dispatch notifies the panel", async () => {
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

test("review: two runs can't pin the same thread: the earlier run keeps it, the later uses its own", async () => {
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

test("review: a hung thread is reported stuck even when a Pulse prompt is already queued behind it", async () => {
  const f = fakeBb({ threads: { thr_run: { status: "active" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_run");
  f.kv.set("dispatches:hourly", [{ at: new Date(Date.now() - 70 * MIN).toISOString(), threadId: "thr_run", trigger: "manual" }]);
  f.queues.set("thr_run", [queuedRun("q1")]);
  f.changeSettings({ dailyCron: cronAt(180), weeklyCron: cronAt(240) });
  await f.tick("hourly");
  assert.equal(f.count("queued.update"), 0, "the queued prompt is left alone");
  assert.match((await f.automation("hourly")).failure.error, /busy for 7\d min/);
});

// ---- 0.1.24: a queue on a stopped thread never drains ----
/** A queued run prompt Pulse sent, as the host stores it. */
const queuedRun = (id: string, kind = "inline", extra: { waitingOn?: { kind: string } } = {}) =>
  makeQueueEntry({ id, originPluginId: "pulse", payload: { kind }, content: [{ type: "text", text: "[Pulse scheduled hourly run · Nov 7]" }], ...extra });

test("stuck queue: a run thread that stopped on an error is retired, not refreshed forever", async () => {
  const f = fakeBb({ threads: { thr_err: { status: "error" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_err");
  f.queues.set("thr_err", [queuedRun("q1"), queuedRun("qr", "retry")]);
  const res = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(res.threadId, "thr_new");
  assert.equal(f.count("queued.update"), 0, "the stranded prompt is not refreshed");
  assert.deepEqual(f.queues.get("thr_err"), [], "Pulse's stranded prompt and retry are dropped");
  assert.deepEqual(f.calls["threads.archive"]?.map(([a]) => (a as { threadId: string }).threadId), ["thr_err"]);
  assert.equal(store.getRunThreads(f.home).hourly, "thr_new");
});

test("stuck queue: a pinned thread that stopped keeps the user's queue and gets the run directly", async () => {
  const f = fakeBb({ threads: { thr_pin: { status: "error" } } });
  await plugin(f.bb as never);
  f.changeSettings({ hourlyThread: "thr_pin" });
  const mine = makeQueueEntry({ id: "qu" });
  f.queues.set("thr_pin", [queuedRun("q1"), queuedRun("qr", "retry"), mine]);
  const res = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(res.threadId, "thr_pin");
  assert.deepEqual(f.queues.get("thr_pin")!.map((r) => r.id), ["qr", "qu"], "only Pulse's own run prompt is dropped");
  assert.equal(f.count("threads.archive"), 0);
  assert.deepEqual(f.sends(), ["thr_pin"]);
});

test("stuck queue: an idle thread with a stranded prompt gets a fresh send, not a refreshed queue", async () => {
  const f = fakeBb({ threads: { thr_idle: { status: "idle" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_idle");
  f.queues.set("thr_idle", [queuedRun("q1")]);
  const res = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(res.threadId, "thr_idle", "a young idle thread is kept");
  assert.equal(f.count("queued.update"), 0);
  assert.deepEqual(f.queues.get("thr_idle"), []);
  assert.deepEqual(f.sends(), ["thr_idle"]);
});

// ---- review: a queued row's text doesn't prove Pulse queued it (originPluginId does) ----
test("review: a user's queued message that quotes a Pulse header is never deleted or overwritten", async () => {
  const quoting = makeQueueEntry({ id: "qu", content: [{ type: "text", text: "[Pulse scheduled hourly run · Nov 7]\n\nmy own follow-up" }] });
  const pinned = fakeBb({ threads: { thr_pin: { status: "idle" } } });
  await plugin(pinned.bb as never);
  pinned.changeSettings({ hourlyThread: "thr_pin" });
  pinned.queues.set("thr_pin", [quoting]);
  assert.equal((await pinned.rpc.pulse_run_now!({ run: "hourly" })).threadId, "thr_pin");
  assert.deepEqual(pinned.calls["queued.delete"] ?? [], [], "another plugin's or the user's row is left alone");
  assert.deepEqual(pinned.queues.get("thr_pin")!.map((r) => r.id), ["qu"]);

  const busy = fakeBb({ threads: { thr_run: { status: "active" } } });
  await plugin(busy.bb as never);
  busy.kv.set("thread:hourly", "thr_run");
  busy.queues.set("thr_run", [quoting]);
  await busy.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(busy.count("queued.update"), 0, "the user's message is not rewritten with the run prompt");
  assert.equal(busy.queues.get("thr_run")![0]!.content[0]!.text, quoting.content[0]!.text);
  assert.equal(busy.queues.get("thr_run")!.length, 2, "the run is queued behind it");
});

test("review: a Pulse queued run for another run name is left alone", async () => {
  const f = fakeBb({ threads: { thr_run: { status: "idle" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_run");
  f.queues.set("thr_run", [makeQueueEntry({ id: "qd", originPluginId: "pulse", content: [{ type: "text", text: "[Pulse scheduled daily run · Nov 7]" }] })]);
  assert.equal((await f.rpc.pulse_run_now!({ run: "hourly" })).threadId, "thr_run");
  assert.deepEqual(f.calls["queued.delete"] ?? [], []);
  assert.deepEqual(f.calls["queued.update"] ?? [], []);
  assert.deepEqual(f.queues.get("thr_run")!.map((r) => r.id), ["qd"]);
});

// ---- review: a cached thread that another run pins is the user's ----
test("review: another run's pinned thread is never used, cleared or archived", async () => {
  const f = fakeBb({ threads: { thr_shared: { status: "error" } } });
  await plugin(f.bb as never);
  f.changeSettings({ dailyThread: "thr_shared" });
  f.kv.set("thread:hourly", "thr_shared");
  f.queues.set("thr_shared", [
    makeQueueEntry({ id: "qd", originPluginId: "pulse", content: [{ type: "text", text: "[Pulse scheduled daily run · Nov 7]" }] }),
    makeQueueEntry({ id: "qu" }),
  ]);
  const res = await f.rpc.pulse_run_now!({ run: "hourly" });
  assert.equal(res.threadId, "thr_new", "the hourly starts its own thread instead");
  assert.deepEqual(f.calls["threads.archive"] ?? [], [], "the daily's pinned thread is never archived");
  assert.deepEqual(f.queues.get("thr_shared")!.map((r) => r.id), ["qd", "qu"], "and its queue is untouched");
  assert.equal(store.getRunThreads(f.home).hourly, "thr_new");
  // The daily still sends to its pin.
  assert.equal((await f.rpc.pulse_run_now!({ run: "daily" })).threadId, "thr_shared");
});

// ---- review: an unreadable or uncleared queue must not turn into a second run ----
test("review: a queue that can't be cleared stops the run instead of sending a second one", async () => {
  const f = fakeBb({
    threads: { thr_err: { status: "error" } },
    overrides: { "queued.delete": () => { throw new Error("queue is locked"); } },
  });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_err");
  f.queues.set("thr_err", [queuedRun("q1")]);
  assert.equal((await f.rpc.pulse_run_now!({ run: "hourly" })).threadId, "thr_err");
  assert.equal(f.count("threads.send"), 0, "no second prompt while the first one is still queued");
  assert.equal(f.count("threads.spawn"), 0);
  assert.equal(f.count("threads.archive"), 0);
  assert.deepEqual(f.queues.get("thr_err")!.map((r) => r.id), ["q1"]);
  assert.match((await f.automation("hourly")).failure.error, /skipped: could not clear the queued run on thr_err/);
});

test("review: a queue that can't be read stops the run and is reported", async () => {
  const f = fakeBb({
    threads: { thr_idle: { status: "idle" } },
    overrides: { "queued.list": () => { throw new Error("rpc timed out"); } },
  });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_idle");
  f.queues.set("thr_idle", [queuedRun("q1")]);
  assert.equal((await f.rpc.pulse_run_now!({ run: "hourly" })).threadId, "thr_idle");
  assert.equal(f.count("threads.send"), 0, "an unreadable queue isn't treated as an empty one");
  assert.equal(f.count("threads.spawn"), 0);
  assert.match((await f.automation("hourly")).failure.error, /skipped: could not read the queue on thr_idle/);
});

test("review: a queued row waiting on an offline host is left to bb, not replaced", async () => {
  const f = fakeBb({ threads: { thr_wait: { status: "error" } } });
  await plugin(f.bb as never);
  f.kv.set("thread:hourly", "thr_wait");
  f.queues.set("thr_wait", [queuedRun("q1", "inline", { waitingOn: { kind: "host-offline" } })]);
  assert.equal((await f.rpc.pulse_run_now!({ run: "hourly" })).threadId, "thr_wait");
  assert.deepEqual(f.calls["queued.delete"] ?? [], [], "the waiting prompt is not stranded work");
  assert.equal(f.count("threads.send"), 0, "and a second prompt would run the window twice");
  assert.equal(f.count("threads.spawn"), 0);
  assert.deepEqual(f.queues.get("thr_wait")!.map((r) => r.id), ["q1"]);
});
