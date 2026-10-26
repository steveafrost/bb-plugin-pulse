// A fake bb for server tests: records schedules, services, events, warnings and every SDK call,
// and keeps a per-thread queue so queue-if-active sends to a busy thread behave like the host's.
import { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Fn = (...args: any[]) => any;
type Thread = { id: string; status: string; createdAt: number; archivedAt: number | null; deletedAt: number | null; visibility: string; queuedMessageCount?: number };

export const MIN = 60_000;

export function fakeBb({ threads: seed = {}, overrides = {}, settings: initial = {} }: { threads?: Record<string, Partial<Thread>>; overrides?: Record<string, Fn>; settings?: Record<string, unknown> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-srv-"));
  const kv = new Map<string, unknown>();
  const rpc: Record<string, Fn> = {};
  const events: Record<string, Fn[]> = {};
  const calls: Record<string, unknown[][]> = {};
  const onChange: Fn[] = [];
  const schedules: Record<string, { cron: string; fn: Fn }> = {};
  const services: Record<string, { start: (signal: AbortSignal) => Promise<void> }> = {};
  const warns: string[] = [];
  const infos: string[] = [];
  const disposers: Fn[] = [];
  const threadState = new Map<string, Thread>();
  const queues = new Map<string, { id: string; updatedAt: number; payload: { kind: string }; content: { type: string; text: string }[] }[]>();
  const thread = (id: string): Thread => {
    if (!threadState.has(id)) threadState.set(id, { id, status: "idle", createdAt: Date.now(), archivedAt: null, deletedAt: null, visibility: "hidden" });
    return threadState.get(id)!;
  };
  for (const [id, t] of Object.entries(seed)) Object.assign(thread(id), t);
  let spawned = 0;
  let values: Record<string, unknown> = {};
  const record = (name: string, impl: Fn) => async (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return impl(...args);
  };
  const impls: Record<string, Fn> = {
    "threads.get": ({ threadId }: { threadId: string }) => ({ ...thread(threadId), queuedMessageCount: queues.get(threadId)?.length ?? 0 }),
    "threads.spawn": () => { const id = spawned++ ? `thr_new${spawned}` : "thr_new"; thread(id); return { id }; },
    "threads.send": ({ threadId, input }: { threadId: string; input: { text: string }[] }) => {
      if (thread(threadId).status === "active") {
        const q = queues.get(threadId) ?? [];
        q.push({ id: `q${q.length + 1}`, updatedAt: Date.now(), payload: { kind: "inline" }, content: [{ type: "text", text: input[0]!.text }] });
        queues.set(threadId, q);
      }
      return {};
    },
    "threads.update": () => ({}),
    "threads.stop": () => ({}),
    "threads.archive": ({ threadId }: { threadId: string }) => { thread(threadId).archivedAt = Date.now(); return {}; },
    "threads.output": () => ({ output: null }),
    "threads.retry": () => ({ kind: "queued" }),
    "threads.list": () => [],
    "threads.experimental_listPluginMetadata": () => ({ threads: [] }),
    "queued.list": ({ threadId }: { threadId: string }) => queues.get(threadId) ?? [],
    "queued.update": ({ threadId, queuedMessageId, input }: { threadId: string; queuedMessageId: string; input: { text: string }[] }) => {
      const row = queues.get(threadId)?.find((r) => r.id === queuedMessageId);
      if (row) { row.content = [{ type: "text", text: input[0]!.text }]; row.updatedAt = Date.now(); }
      return {};
    },
    ...overrides,
  };
  const area = (prefix: string, names: string[]) => Object.fromEntries(names.map((n) => [n, record(`${prefix}.${n}`, (...a: unknown[]) => impls[`${prefix}.${n}`]!(...a))]));
  const threadsArea = area("threads", ["get", "spawn", "send", "update", "stop", "archive", "output", "retry", "list", "experimental_listPluginMetadata"]);
  const bb = {
    pluginId: "pulse",
    settings: {
      define(desc: Record<string, { default?: unknown }>) {
        const defaults = Object.fromEntries(Object.entries(desc).map(([k, d]) => [k, d.default ?? ""]));
        values = { ...defaults, project: "proj_1", storeDir: home, ...initial };
        return { get: async () => ({ ...values }), onChange: (f: Fn) => onChange.push(f) };
      },
    },
    status: { needsConfiguration: () => undefined },
    storage: { kv: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) } },
    sdk: {
      threads: { ...threadsArea, queuedMessages: area("queued", ["list", "update"]) },
      threadSections: { list: async () => [{ id: "sec_1", name: "Pulse" }], create: async () => ({ id: "sec_1" }) },
      plugins: { callRpc: async () => ({}) },
    },
    log: { info: (m: string) => void infos.push(m), warn: (m: string) => void warns.push(m) },
    background: {
      schedule: (name: string, cron: string, fn: Fn) => { schedules[name] = { cron, fn }; },
      service: (name: string, s: { start: (signal: AbortSignal) => Promise<void> }) => { services[name] = s; },
    },
    realtime: { publish: () => undefined },
    rpc: { register: (_c: unknown, handlers: Record<string, Fn>) => Object.assign(rpc, handlers) },
    events: { on: (name: string, f: Fn) => void (events[name] ??= []).push(f) },
    onDispose: (f: Fn) => void disposers.push(f),
  };
  const loaded = {
    bb, home, kv, rpc, calls, schedules, services, warns, infos, events, thread, queues,
    count: (name: string) => calls[name]?.length ?? 0,
    sends: () => (calls["threads.send"] ?? []).map(([a]) => (a as { threadId: string }).threadId),
    emit: async (name: string, payload: unknown) => { for (const f of events[name] ?? []) await f(payload); },
    changeSettings: (next: Record<string, unknown>) => { values = { ...values, ...next }; onChange.forEach((f) => f({ ...values })); },
    tick: async (run: string) => schedules[`run-${run}`]!.fn(),
    automation: async (run: string) => (await rpc.pulse_snapshot!(null)).automations.find((a: { run: string }) => a.run === run),
    /** Run the reconcile service's first pass (catch-up + housekeeping), then stop it. */
    startServices: async () => {
      const ac = new AbortController();
      const done = services["action-reconcile"]!.start(ac.signal);
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      await done;
    },
  };
  live.push(async () => { for (const d of disposers) await d(); });
  return loaded;
}

const live: (() => Promise<void>)[] = [];
afterEach(async () => { while (live.length) await live.pop()!(); });
export const settle = () => new Promise((r) => setTimeout(r, 10));
/** A daily cron whose tick is `offsetMin` minutes from now (negative = in the past). */
export const cronAt = (offsetMin: number) => { const d = new Date(Date.now() + offsetMin * MIN); return `${d.getMinutes()} ${d.getHours()} * * *`; };

