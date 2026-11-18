import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
// @ts-ignore -- plain ESM module shared with the CLI
import * as storeModule from "./store.mjs";
import type { PulseItem, PulseSnapshot } from "../types";
import { recommendTasks, selectCandidates } from "./task-recommend";
import { jevClient } from "./jev-contract";

const store = storeModule as unknown as {
  snapshot(home: string): Pick<PulseSnapshot, "items">;
  getItem(id: string, home: string): PulseItem;
  changeTaskLink(id: string, task: { id: string; key: string; title: string }, remove: boolean, home: string): PulseItem;
  reconcileTasks(id: string, expected: PulseItem, allDone: boolean, home: string): boolean;
};
const TASK_CAPABILITY_TTL_MS = 30_000;
/** Consecutive item failures after which the pass gives up: Tasks itself is probably unavailable. */
const RECONCILE_FAILURE_LIMIT = 3;
/** Errors that no single task read can recover from, so the whole pass stops. */
const TASKS_GONE = /unknown plugin|not running|not installed|not enabled|plugin [^.]*unavailable|transport/i;
const OPEN_TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export const taskContract = defineRpcContract({
  pulse_task_projects: { input: z.null(), output: z.any() },
  pulse_task_recommend: { input: z.object({ id: z.string().min(3).max(400) }), output: z.any() },
  pulse_task_search: { input: z.object({ search: z.string().max(200).default(""), cursor: z.string().max(2000).optional(), statuses: z.array(z.enum(["todo", "backlog", "done"])).max(3).optional() }), output: z.any() },
  pulse_task_labels: { input: z.object({ projectId: z.string().min(1).max(100) }), output: z.any() },
  pulse_task_link: { input: z.object({ id: z.string().min(3).max(400), key: z.string().min(1).max(100), recommended: z.boolean().optional() }), output: z.any() },
  pulse_task_unlink: { input: z.object({ id: z.string().min(3).max(400), taskId: z.string().min(1).max(100) }), output: z.any() },
  pulse_task_create: { input: z.object({ id: z.string().min(3).max(400), projectId: z.string().min(1).max(100), title: z.string().trim().min(1).max(500), description: z.string().max(20000).optional(), labelIds: z.array(z.string().min(1).max(100)).max(100).optional() }), output: z.any() },
});
type Input<M extends keyof typeof taskContract> = z.output<(typeof taskContract)[M]["input"]>;
type TaskSettings = { enabled: boolean; taskAiRecommendations: boolean; closeOnTasksDone: boolean };

/** One instance owns task requests and capability state for one Pulse plugin lifetime. */
export function createTasks({ bb, home, getConfig, readSettings, publish }: {
  bb: BbPluginApi;
  home: string;
  getConfig: () => TaskSettings;
  // Recommendation opt-in reads persisted settings; background closure reads the live config callback.
  readSettings: () => Promise<TaskSettings>;
  publish: () => void;
}) {
  const taskLifetime = new AbortController();
  let integrationLifetime = new AbortController();
  const requireEnabled = () => { if (!getConfig().enabled) throw new Error("Task integration is disabled"); };
  const taskSchema = z.object({ id: z.string(), key: z.string(), title: z.string(), status: z.string() });
  const taskResult = z.object({ task: taskSchema.nullable() });
  const createTaskResult = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), task: taskSchema }),
    z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
  ]);
  const projectResult = z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), prefix: z.string() })) });
  const labelResult = z.object({ labels: z.array(z.object({ id: z.string(), projectId: z.string(), name: z.string(), color: z.string() })) });
  const candidateSchema = taskSchema.extend({ description: z.string(), projectId: z.string(), labelIds: z.array(z.string()), updatedAt: z.string() });
  const taskListResult = z.object({ tasks: z.array(candidateSchema), nextCursor: z.string().nullable() });
  const taskRpc = async <T>(method: string, input: Record<string, string | number | string[]>, outputSchema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => {
    requireEnabled();
    const requestSignal = AbortSignal.any([taskLifetime.signal, integrationLifetime.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
    const result = await bb.sdk.plugins.callRpc({ pluginId: "tasks", method, input, outputSchema, signal: requestSignal });
    // Preserve a completed create; cancel only its local link follow-up.
    if (method !== "createTask") { requestSignal.throwIfAborted(); requireEnabled(); }
    return result;
  };
  const taskProjects = (signal?: AbortSignal) => taskRpc("listProjects", {}, projectResult, signal);
  let tasksAvailable = false;
  let tasksProbeAt = 0;
  let tasksProbe: Promise<void> | null = null;
  function refreshTaskAvailability(signal?: AbortSignal) {
    if (!getConfig().enabled || tasksProbe || Date.now() - tasksProbeAt < TASK_CAPABILITY_TTL_MS) return;
    tasksProbeAt = Date.now();
    const lifetime = integrationLifetime.signal;
    const probe = taskProjects(signal).then(() => true, () => false).then((available) => {
      if (taskLifetime.signal.aborted || lifetime.aborted || signal?.aborted) return;
      if (available !== tasksAvailable) { tasksAvailable = available; publish(); }
    }).finally(() => { if (tasksProbe === probe) tasksProbe = null; });
    tasksProbe = probe;
  }

  let registryEnabled = false;
  let registryReadAt = 0;
  let registryProbe: ReturnType<typeof bb.sdk.plugins.list> | null = null;
  function readRegistry() {
    if (registryProbe) return registryProbe;
    const signal = AbortSignal.any([taskLifetime.signal, AbortSignal.timeout(5000)]);
    let abort: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
    const probe = Promise.race([bb.sdk.plugins.list(), canceled]).then((result) => {
      registryReadAt = Date.now();
      const enabled = result.plugins.some((plugin) => plugin.id === "tasks" && plugin.enabled);
      if (!taskLifetime.signal.aborted && enabled !== registryEnabled) { registryEnabled = enabled; publish(); }
      return result;
    }).catch((error) => {
      if (!taskLifetime.signal.aborted && registryEnabled) { registryEnabled = false; publish(); }
      throw error;
    }).finally(() => {
      signal.removeEventListener("abort", abort);
      if (registryProbe === probe) registryProbe = null;
    });
    registryProbe = probe;
    return probe;
  }

  let jevAvailability: NonNullable<PulseSnapshot["taskSuggestions"]> = "checking";
  let jevProbeAt = 0;
  let jevProbe: Promise<void> | null = null;
  function refreshJevAvailability(): Promise<void> {
    if (taskLifetime.signal.aborted) return Promise.resolve();
    if (jevProbe) return jevProbe;
    if (Date.now() - jevProbeAt < TASK_CAPABILITY_TTL_MS) return Promise.resolve();
    jevProbeAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    let cancel: () => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(taskLifetime.signal.reason);
      taskLifetime.signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => reject(new Error("Plugin discovery timed out")), 5000);
    });
    jevProbe = Promise.race([readRegistry(), deadline]).then(({ plugins }) => {
      const plugin = plugins.find((p) => p.id === "jev");
      jevAvailability = !plugin ? "missing" : !plugin.enabled ? "disabled" : plugin.status === "running" ? "available" : "unavailable";
    }, () => { jevAvailability = "unavailable"; }).finally(() => {
      clearTimeout(timer);
      taskLifetime.signal.removeEventListener("abort", cancel);
      jevProbe = null;
      if (!taskLifetime.signal.aborted) publish();
    });
    return jevProbe;
  }

  async function reconcileLinkedTasks(signal: AbortSignal) {
    if (!getConfig().enabled || !getConfig().closeOnTasksDone || !tasksAvailable || signal.aborted) return;
    const items = store.snapshot(home).items.filter((item) => item.taskLinks?.length && !["done", "dismissed", "resolved"].includes(item.status));
    // One unreadable item must not end the pass: a repeatable, item-specific error would otherwise
    // starve every item after it in a stable order. Each failed read waits out the 5 s RPC timeout,
    // so repeated failures stop the pass and leave the rest to the next tick.
    let failures = 0;
    for (const item of items) {
      if (signal.aborted) return;
      try {
        const tasks = await Promise.all(item.taskLinks!.map(({ id }) => taskRpc("getTask", { taskId: id }, taskResult, signal)));
        failures = 0;
        if (signal.aborted || !getConfig().enabled || !getConfig().closeOnTasksDone || tasks.some(({ task }) => !task)) continue;
        store.reconcileTasks(item.id, item, tasks.every(({ task }) => task?.status === "done"), home);
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        bb.log.warn(`task reconcile ${item.id}: ${message(error)}`);
        if (!getConfig().enabled || failures >= RECONCILE_FAILURE_LIMIT || TASKS_GONE.test(message(error))) return;
      }
    }
  }

  const creatingTasks = new Set<string>();
  const pendingRecommendations = new Map<string, Promise<unknown>>();
  return {
    /** Starts shared, TTL-limited discovery without waiting; returns the last known capability state. */
    refreshCapabilities(): Pick<PulseSnapshot, "tasksAvailable" | "taskSuggestions" | "tasksPluginEnabled"> {
      if (!getConfig().enabled) return { tasksAvailable: false, tasksPluginEnabled: false, taskSuggestions: "off" };
      if (!registryProbe && Date.now() - registryReadAt >= TASK_CAPABILITY_TTL_MS) { registryReadAt = Date.now(); void readRegistry().catch(() => undefined); }
      refreshTaskAvailability();
      if (getConfig().taskAiRecommendations) void refreshJevAvailability();
      return { tasksAvailable, tasksPluginEnabled: registryEnabled, taskSuggestions: getConfig().taskAiRecommendations ? jevAvailability : "off" };
    },
    async reconcile(signal: AbortSignal) {
      if (!getConfig().enabled) return;
      refreshTaskAvailability(signal);
      if (tasksProbe) {
        let abort: () => void = () => {};
        try {
          await Promise.race([tasksProbe, new Promise<void>((resolve) => {
            abort = resolve;
            if (signal.aborted) resolve(); else signal.addEventListener("abort", abort, { once: true });
          })]);
        } finally { signal.removeEventListener("abort", abort); }
      }
      await reconcileLinkedTasks(signal);
    },
    settingsChanged() {
      if (!getConfig().enabled) { integrationLifetime.abort(); tasksAvailable = false; tasksProbe = null; pendingRecommendations.clear(); }
      else if (integrationLifetime.signal.aborted) integrationLifetime = new AbortController();
      tasksProbeAt = 0;
      jevProbeAt = 0;
    },
    async pluginEnabled() {
      const { plugins } = await readRegistry();
      return plugins.some((plugin) => plugin.id === "tasks" && plugin.enabled);
    },
    dispose() { taskLifetime.abort(); integrationLifetime.abort(); },
    projects: () => taskProjects(),
    labels: ({ projectId }: Input<"pulse_task_labels">) => taskRpc("listLabels", { projectId }, labelResult),
    search: ({ search, cursor, statuses }: Input<"pulse_task_search">) => {
      requireEnabled();
      if (statuses && !statuses.length) return Promise.resolve({ tasks: [], nextCursor: null });
      return taskRpc("listTasks", { limit: 100, ...(search.trim() ? { search: search.trim() } : {}), ...(cursor ? { cursor } : {}), ...(statuses ? { statuses } : {}) }, taskListResult);
    },
    recommend: async ({ id }: Input<"pulse_task_recommend">) => {
      if (!getConfig().enabled) return { match: null, related: null, suggestions: [], projects: [] };
      const existing = pendingRecommendations.get(id);
      if (existing) return existing;
      const request = (async () => {
        const { enabled, taskAiRecommendations } = await readSettings();
        if (!enabled || !taskAiRecommendations) return { match: null, related: null, suggestions: [], projects: [] };
        await refreshJevAvailability();
        if (jevAvailability !== "available") return { match: null, related: null, suggestions: [], projects: [] };
        const signal = AbortSignal.any([taskLifetime.signal, integrationLifetime.signal, AbortSignal.timeout(8000)]);
        const requestJev = jevClient(bb, { signal });
        const { configured, limits } = await requestJev.status({ probe: false });
        if (!configured) { jevAvailability = "unavailable"; publish(); return { match: null, related: null, suggestions: [], projects: [] }; }
        const item = store.getItem(id, home);
        const [{ projects }, first] = await Promise.all([taskProjects(signal), taskRpc("listTasks", { limit: 500, statuses: OPEN_TASK_STATUSES }, taskListResult, signal)]);
        const linked = new Set((item.taskLinks ?? []).map((t) => t.id));
        const candidates = selectCandidates(item, first.tasks.filter((t) => !linked.has(t.id) && OPEN_TASK_STATUSES.includes(t.status)));
        signal.throwIfAborted(); requireEnabled();
        if (!getConfig().taskAiRecommendations) return { match: null, related: null, suggestions: [], projects: [] };
        const recommendation = await recommendTasks(item, candidates, { jev: requestJev, signal, maxStateBytes: limits.maxStateBytes, maxQuestionBytes: limits.maxQuestionBytes });
        signal.throwIfAborted();
        requireEnabled();
        return { ...recommendation, projects };
      })();
      pendingRecommendations.set(id, request);
      try { return await request; } finally { if (pendingRecommendations.get(id) === request) pendingRecommendations.delete(id); }
    },
    link: async ({ id, key, recommended }: Input<"pulse_task_link">) => {
      requireEnabled();
      const signal = integrationLifetime.signal;
      const { task } = await taskRpc("getTaskByKey", { taskKey: key.trim() }, taskResult);
      if (!task) throw new Error(`Task ${key} was not found`);
      if (recommended && !OPEN_TASK_STATUSES.includes(task.status)) throw new Error("The recommended task is no longer open. Choose another task.");
      signal.throwIfAborted(); requireEnabled();
      store.changeTaskLink(id, { id: task.id, key: task.key, title: task.title }, false, home);
    },
    unlink: async ({ id, taskId }: Input<"pulse_task_unlink">) => {
      requireEnabled();
      const signal = integrationLifetime.signal;
      if (!await readRegistry().then(({ plugins }) => plugins.some((plugin) => plugin.id === "tasks" && plugin.enabled))) throw new Error("Tasks plugin is not installed or enabled");
      signal.throwIfAborted();
      requireEnabled();
      const task = store.getItem(id, home).taskLinks?.find((t) => t.id === taskId);
      if (!task) throw new Error("Task link was not found");
      store.changeTaskLink(id, task, true, home);
    },
    create: async ({ id, projectId, title, description: submittedDescription, labelIds }: Input<"pulse_task_create">) => {
      requireEnabled();
      const signal = integrationLifetime.signal;
      if (creatingTasks.has(id)) throw new Error("Task creation is already in progress for this item");
      creatingTasks.add(id);
      try {
        const item = store.getItem(id, home);
        const description = submittedDescription ?? [item.detail, item.url].filter(Boolean).join("\n\n");
        let result: z.infer<typeof createTaskResult>;
        try { result = await taskRpc("createTask", { projectId, title, description, ...(labelIds ? { labelIds } : {}) }, createTaskResult); }
        catch (error) {
          if (/invalid_input|unknown.plugin|unknown.method/i.test(message(error))) throw error;
          throw new Error(`Task creation may have completed. Check Tasks before retrying: ${message(error)}`);
        }
        if (!result.ok) throw new Error(result.error.message);
        const task = result.task;
        try { signal.throwIfAborted(); requireEnabled(); store.changeTaskLink(id, { id: task.id, key: task.key, title: task.title }, false, home); }
        catch (error) { throw new Error(`Created ${task.key}, but could not link it: ${message(error)}`); }
      } finally { creatingTasks.delete(id); }
    },
  };
}
