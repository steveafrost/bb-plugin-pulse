/**
 * bb-plugin-pulse — server.
 *
 * Reads the Pulse item store (lib/store.mjs, the same module the `pulse` CLI
 * uses), watches its directory and pushes a realtime signal so the panel stays
 * live while runs write. The user's actions (done / dismiss / snooze / reopen)
 * go through the store's user path, so the next run respects them.
 *
 * Pulse owns its capture runs: plugin schedules send the prompts in
 * lib/prompts.ts to one thread per run (created on first run, rotated daily).
 * Run now calls the same function. Everything personal lives in the plugin
 * settings. Run health (dispatches, failures, retries, overdue runs) is kept in
 * plugin kv and shown in the panel's run menu.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi, type PluginProviderReasoningLevel } from "@get-bb/plugin-sdk";
import { z } from "zod";
// @ts-ignore -- plain ESM module shared with the CLI
import * as storeModule from "./lib/store.mjs";
import { cronError, nextCronRun, prevCronRun } from "./lib/cron";
import { DEFAULT_SOURCES, runPrompt, type PromptContext, type RunName } from "./lib/prompts";
import { parseSkillRules, skillsFor, type SkillRule } from "./lib/skills";
import { threadGone } from "./lib/thread-gone";
import { actionPrompt, readySummary, type ActionContext } from "./lib/action";
import { createTasks, taskContract } from "./lib/tasks";
import { createTaskSettings, taskSettingsContract } from "./lib/task-settings";

export { actionPrompt, readySummary, type ActionContext };
import type { ActionStatus, Automation, ItemAction, MissedRun, PulseItem, PulseRun, PulseSnapshot, RunDispatch, RunFailure } from "./types";

type Home = string;
const store = storeModule as unknown as {
  pulseHome(): string;
  snapshot(home: Home): Omit<PulseSnapshot, "automations" | "parentThreadId">;
  userAction(id: string, status: string, opts: { until?: string; reason?: string; by?: string }, home: Home): PulseItem;
  markSeen(at: string | undefined, home: Home): { lastViewedAt: string };
  getItem(id: string, home: Home): PulseItem;
  startAction(id: string, opts: { threadId: string; by?: string }, home: Home): PulseItem;
  setActionStatus(id: string, status: ActionStatus, opts: { threadId?: string; summary?: string | null; by?: string }, home: Home): PulseItem | null;
  markActionSeen(id: string, home: Home): PulseItem;
  actionItems(status: ActionStatus | null, home: Home): PulseItem[];
  readRuns(home: Home): PulseRun[];
  housekeep(home: Home): { snoozesExpired: string[]; fyisExpired: string[]; archivedItems: number; archivedRuns: number };
};

const CHANGED = "pulse-changed";
const RUN_NAMES: RunName[] = ["hourly", "daily", "weekly"];
const RUN_LABEL: Record<RunName, string> = { hourly: "Hourly", daily: "Daily", weekly: "Weekly" };
/** Hourly on weekday working hours; Daily after the 16:00 Hourly slot, which it covers. */
const DEFAULT_CRON: Record<RunName, string> = { hourly: "0 8-18/2 * * 1-5", daily: "30 16 * * 1-5", weekly: "0 15 * * 5" };
const STATUS_FOR: Record<ItemAction, string> = { done: "done", dismiss: "dismissed", snooze: "snoozed", reopen: "open" };
const MINUTE = 60_000;
const RECONCILE_MS = 2 * MINUTE;
const PROBE_TTL_MS = 30_000;
/** A memory line that reads as a tool tip or workaround, for seeding tips.md from older files. */
const TIP_LINE = /\btips?\b|workaround|`| --[a-z]|\b(needs|takes|wants|prefer)\b|\b(TGW|MCP|CLI)\b|devx|codemode|token|validation/i;
/** A Daily or Weekly run this close to an Hourly slot does the Hourly's work, so the Hourly skips. */
const COLLIDE_MS = 45 * MINUTE;
/** A dispatched run with no `pulse log` after this long is overdue (it died, or never started). */
const OVERDUE_MS = 45 * MINUTE;
/** A dispatch with no logged run after this long, or superseded by a later one, didn't finish. */
const UNFINISHED_MS = 90 * MINUTE;
/** A run thread busy this long is stuck; scheduled runs skip it instead of queueing behind it. */
const STUCK_MS = 60 * MINUTE;
/** A failed run turn is retried once, this much later. */
const RETRY_DELAY_MS = 5 * MINUTE;
/** Pulse starts a fresh run thread once its current one is this old (the prompt carries all state). */
const ROTATE_MS = 24 * 60 * MINUTE;
/** A run missed while bb or Pulse was not loaded is caught up when its tick is this recent. */
const CATCH_UP_WINDOW_MS = 24 * 60 * MINUTE;
const CATCH_UP_GRACE_MS = 2 * MINUTE;
const DISPATCH_HISTORY = 20;
/** Plugin root (server runs from dist/server.js or ./server.ts). */
const ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist" ? path.dirname(here) : here;
})();

const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const stamp = (t: number | string | null | undefined) => (typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN);
/** The header every run prompt starts with; queued rows carrying it are Pulse's own. */
const RUN_HEADER = /^\[Pulse (?:scheduled|manual|catch-up) (\w+) run · /;

const CAPTURE_MODEL_KEY = "captureModel";
const captureModelSchema = z.object({ providerId: z.string(), model: z.string(), reasoningLevel: z.string() });
type CaptureModel = z.infer<typeof captureModelSchema>;
const EMPTY_CAPTURE_MODEL: CaptureModel = { providerId: "", model: "", reasoningLevel: "" };
const normalizeCaptureModel = (raw: unknown): CaptureModel => {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CAPTURE_MODEL };
  const r = raw as Record<string, unknown>;
  return {
    providerId: typeof r.providerId === "string" ? r.providerId.trim() : "",
    model: typeof r.model === "string" ? r.model.trim() : "",
    reasoningLevel: typeof r.reasoningLevel === "string" ? r.reasoningLevel.trim() : "",
  };
};

export const rpcContract = defineRpcContract({
  pulse_snapshot: { input: z.null(), output: z.any() },
  pulse_action: {
    input: z.object({
      id: z.string().min(3).max(400),
      action: z.enum(["done", "dismiss", "snooze", "reopen"]),
      until: z.iso.datetime({ offset: true }).optional(),
      /** Undo: reopen to the status the item had before the click. */
      restore: z.enum(["open", "waiting"]).optional(),
    }),
    output: z.any(),
  },
  ...taskContract,
  ...taskSettingsContract,
  pulse_model_get: { input: z.null(), output: captureModelSchema },
  pulse_model_set: { input: captureModelSchema, output: captureModelSchema },
  pulse_seen: { input: z.null(), output: z.any() },
  pulse_run_now: { input: z.object({ run: z.enum(["hourly", "daily", "weekly"]) }), output: z.object({ threadId: z.string() }) },
  pulse_set_run_enabled: { input: z.object({ run: z.enum(["hourly", "daily", "weekly"]), enabled: z.boolean() }), output: z.any() },
  pulse_start_action: { input: z.object({ id: z.string().min(3).max(400) }), output: z.any() },
  pulse_action_seen: { input: z.object({ id: z.string().min(3).max(400) }), output: z.any() },
});

export default async function plugin(bb: BbPluginApi) {
  const kv = bb.storage.kv;
  const migrationKey = `${CAPTURE_MODEL_KEY}:legacy-settings-migrated`;
  const migrationPending = (await kv.get<boolean>(migrationKey)) !== true;
  const readLegacy = migrationPending && (await kv.get(CAPTURE_MODEL_KEY)) === undefined;
  const settings = bb.settings.define({
    project: { type: "project", label: "Project for run and agent threads", description: "Pulse creates its Hourly, Daily and Weekly threads and its agent threads here. Required." },
    userName: { type: "string", label: "Your first name", description: "Used in the prompts (\"what needs Sam\"). Empty = \"the user\".", default: "" },
    sources: {
      type: "string", experimental_multiline: true, default: DEFAULT_SOURCES,
      label: "How agents reach Slack, Gmail and Calendar",
      description: "Pasted into every run and agent prompt. Name the MCP servers, CLIs or plugins to use.",
    },
    instructions: {
      type: "string", experimental_multiline: true, default: "",
      label: "House rules for capture runs",
      description: "Appended to every run prompt, e.g. what to ignore or which writing-style skill to load for quick action text.",
    },
    skillRules: {
      type: "string", experimental_multiline: true, default: "",
      label: "Skills for agent threads",
      description: "One rule per line: skill-name | why | regex. `*` matches every actionable item. Only installed skills are used, at most 4.",
    },
    permissionMode: {
      type: "select", label: "Permission mode for capture runs", options: ["default", "accept-edits", "auto", "full"],
      experimental_optionLabels: { default: "Thread default" }, default: "default",
      description: "Runs call the Pulse CLI from a shell, so they need permission to run commands.",
    },
    hourlyCron: { type: "string", label: "Hourly schedule (cron, server time; empty = off)", description: "The default runs every 2 hours from 8 AM to 6 PM on weekdays. An Hourly slot within 45 minutes of a Daily or Weekly run is skipped; that run covers it.", default: DEFAULT_CRON.hourly },
    dailyCron: { type: "string", label: "Daily schedule (cron, server time; empty = off)", description: "The default runs at 4:30 PM on weekdays.", default: DEFAULT_CRON.daily },
    weeklyCron: { type: "string", label: "Weekly schedule (cron, server time; empty = off)", default: DEFAULT_CRON.weekly },
    section: { type: "string", label: "Sidebar section for Pulse threads (created if missing; empty = none)", default: "Pulse" },
    timeZone: { type: "string", label: "Time zone (IANA; empty = server time zone)", default: "" },
    storeDir: { type: "string", label: "Store directory (empty = $PULSE_HOME or ~/.config/pulse)", default: "" },
    hourlyThread: { type: "string", label: "Existing thread for Hourly runs (optional thread id)", default: "" },
    dailyThread: { type: "string", label: "Existing thread for Daily runs (optional thread id)", default: "" },
    weeklyThread: { type: "string", label: "Existing thread for Weekly runs (optional thread id)", default: "" },
    // The SDK reads only declared keys. Do not register these again after migration.
    ...(readLegacy
      ? {
          model: {
            type: "string" as const,
            label: "Legacy model (migration only)",
            description: "Use the provider and model picker to change this selection.",
            default: "",
          },
          reasoningLevel: {
            type: "select" as const,
            label: "Legacy reasoning level (migration only)",
            description: "Use the provider and model picker to change this selection.",
            options: ["default", "low", "medium", "high"],
            default: "default",
          },
        }
      : {}),
  });
  type Values = Awaited<ReturnType<typeof settings.get>>;
  const readConfig = (v: Values) => {
    const timeZone = (v.timeZone ?? "").trim() || systemTimeZone();
    return {
      projectId: (v.project ?? "").trim(),
      user: v.userName.trim() || "the user",
      sources: v.sources.trim() || DEFAULT_SOURCES,
      instructions: v.instructions,
      skillRules: parseSkillRules(v.skillRules, (m) => bb.log.warn(m)) as SkillRule[],
      permissionMode: (v.permissionMode === "default" ? "" : v.permissionMode) as "" | "accept-edits" | "auto" | "full",
      cron: { hourly: v.hourlyCron.trim(), daily: v.dailyCron.trim(), weekly: v.weeklyCron.trim() } as Record<RunName, string>,
      section: v.section.trim(),
      timeZone: (() => { try { new Intl.DateTimeFormat("en-US", { timeZone }); return timeZone; } catch { bb.log.warn(`bad time zone "${timeZone}"`); return systemTimeZone(); } })(),
      // Absolute, so the panel and the run's shell (which runs in the project cwd) share one store.
      home: path.resolve(os.homedir(), v.storeDir.trim().replace(/^~(?=\/|$)/, os.homedir()) || store.pulseHome()),
      ...pinsOf({ hourly: v.hourlyThread.trim(), daily: v.dailyThread.trim(), weekly: v.weeklyThread.trim() }),
    };
  };
  /**
   * One run per pinned thread. Failure attribution and queued-prompt replacement assume a thread
   * has one owner, so a pin already taken by an earlier run is dropped (that run keeps it) and the
   * later run falls back to its own thread.
   */
  const pinsOf = (raw: Record<RunName, string>) => {
    const threads = { ...raw };
    const sharedWith: Partial<Record<RunName, RunName>> = {};
    RUN_NAMES.forEach((run, i) => {
      const owner = RUN_NAMES.slice(0, i).find((r) => threads[r] !== "" && threads[r] === raw[run]);
      if (raw[run] === "" || !owner) return;
      threads[run] = "";
      sharedWith[run] = owner;
      bb.log.warn(`${run} thread setting ${raw[run]} is already the ${owner} thread; ${run} runs use Pulse's own thread`);
    });
    return { threads, sharedWith };
  };
  const deadPinnedKey = (name: RunName) => `deadPinned:${name}`;
  let pinClears: Promise<void> = Promise.resolve();
  const initialSettings = await settings.get();
  if (migrationPending) {
    if (readLegacy) {
      const model = initialSettings.model?.trim() ?? "";
      const reasoning = initialSettings.reasoningLevel ?? "default";
      if ((model || reasoning !== "default") && (await kv.get(CAPTURE_MODEL_KEY)) === undefined) {
        await kv.set(CAPTURE_MODEL_KEY, {
          providerId: "",
          model,
          reasoningLevel: reasoning === "default" ? "" : reasoning,
        });
      }
    }
    await kv.set(migrationKey, true);
  }
  let captureModel = normalizeCaptureModel(await bb.storage.kv.get(CAPTURE_MODEL_KEY));
  let config = readConfig(initialSettings);
  const home = config.home;
  const loadedCron = { ...config.cron };
  const loadedWithoutProject = !config.projectId;
  settings.onChange((next) => {
    const prev = config;
    config = readConfig(next);
    // A pin that was marked dead gets a fresh try as soon as its setting changes, even if it
    // later changes back to the same id (the user may have repaired that thread).
    const cleared = RUN_NAMES.filter((r) => config.threads[r] !== prev.threads[r]).map((r) => bb.storage.kv.delete(deadPinnedKey(r)));
    if (cleared.length) pinClears = Promise.all(cleared).then(() => undefined, () => undefined);
    for (const run of RUN_NAMES) {
      if (config.cron[run] === prev.cron[run]) continue;
      // Check now, so a typo shows in the panel before a reload makes bb drop the schedule.
      const problem = config.cron[run] ? cronError(config.cron[run]) : null;
      if (problem) bb.log.warn(`${run} schedule "${config.cron[run]}" is not valid (${problem}); bb will refuse it on reload`);
    }
    if (config.home !== prev.home || RUN_NAMES.some((r) => config.cron[r] !== prev.cron[r])) {
      bb.log.info("store directory or schedules changed; run `bb plugin reload` to apply");
    }
    publish();
  });
  fs.mkdirSync(home, { recursive: true });
  if (!config.projectId) bb.status.needsConfiguration("Choose a project in Pulse settings, then reload the plugin.");

  const cliPath = path.join(ROOT, "bin/pulse.mjs");
  const cliCommand = () => `PULSE_HOME=${shellQuote(home)} node ${shellQuote(cliPath)}`;
  /**
   * `<store>/bin/pulse`: a launcher for the bundled CLI, pinned to this store. bb copies the pulse
   * skill on its own into a global skills directory, so the skill can't point at the plugin's
   * files; it points here instead (default store: ~/.config/pulse/bin/pulse).
   */
  const writeLauncher = () => {
    const file = path.join(home, "bin", "pulse");
    const body = `#!/bin/sh\n# Written by the Pulse bb plugin on load: the bundled CLI, pinned to this store.\nPULSE_HOME=${shellQuote(home)} exec node ${shellQuote(cliPath)} "$@"\n`;
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === body) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, { mode: 0o755 });
      fs.chmodSync(file, 0o755);
    } catch (error) {
      bb.log.warn(`could not write the CLI launcher ${file}: ${message(error)}`);
    }
  };
  writeLauncher();
  /**
   * Runs used to keep tool tips in one memory file each, so a workaround Daily found never reached
   * Hourly. Since 0.1.15 every run reads memory/tips.md; seed it once from the old per-run files
   * (which stay, Weekly still keeps its context in weekly.md).
   */
  const seedTips = () => {
    const dir = path.join(home, "memory");
    const tips = path.join(dir, "tips.md");
    try {
      if (fs.existsSync(tips)) return;
      const lines: string[] = [];
      for (const run of ["hourly", "daily"] as const) {
        const file = path.join(dir, `${run}.md`);
        if (!fs.existsSync(file)) continue;
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          const t = line.trim();
          // The old files mixed run journals ("Last run: …", what was flagged) with tool tips.
          // Carry over only list or dated lines that read as a tip about a tool or a workaround.
          if (/^(- |\d{4}-\d{2}-\d{2})/.test(t) && TIP_LINE.test(t) && !lines.includes(t)) lines.push(t);
        }
      }
      if (!lines.length) return;
      fs.writeFileSync(tips, `# Pulse tool tips (shared by every run; newest last, keep under 40 lines)\n${lines.slice(-40).join("\n")}\n`);
      bb.log.info(`seeded ${tips} from the per-run memory files`);
    } catch (error) {
      bb.log.warn(`could not seed ${tips}: ${message(error)}`);
    }
  };
  seedTips();
  const promptContext = (startedAt?: string): PromptContext => ({
    cli: cliCommand(), user: config.user, timeZone: config.timeZone, memoryDir: path.join(home, "memory"),
    sources: config.sources, instructions: config.instructions, ...(startedAt ? { startedAt } : {}),
  });
  const skillsForItem = (item: PulseItem) => skillsFor(item, config.skillRules);

  const pausedKey = (name: RunName) => `paused:${name}`;
  const threadKey = (name: RunName) => `thread:${name}`;
  const dispatchKey = (name: RunName) => `dispatches:${name}`;
  const failureKey = (name: RunName) => `failure:${name}`;
  const isPaused = async (name: RunName) => (await bb.storage.kv.get<boolean>(pausedKey(name))) === true;

  /** Every prompt Pulse sent, newest last: the evidence for overdue and didn't-finish runs. */
  const dispatches = async (name: RunName): Promise<RunDispatch[]> => {
    const list = await bb.storage.kv.get<RunDispatch[]>(dispatchKey(name));
    return Array.isArray(list) ? list : [];
  };
  /** `replace`: the prompt replaced a queued one, so the earlier dispatch never ran on its own. */
  const recordDispatch = async (name: RunName, d: RunDispatch, { replace = false } = {}) => {
    const list = await dispatches(name);
    if (replace && list.length && list.at(-1)!.threadId === d.threadId) list.pop();
    list.push(d);
    await bb.storage.kv.set(dispatchKey(name), list.slice(-DISPATCH_HISTORY));
    // lastDispatchAt, overdue and missedRuns read this, and the queued-row path writes nothing else.
    publish();
  };
  const recordFailure = async (name: RunName, failure: RunFailure) => {
    await bb.storage.kv.set(failureKey(name), failure);
    publish();
  };
  const runsOf = (name: RunName): PulseRun[] => {
    try {
      return store.readRuns(home).filter((r) => r.run === name);
    } catch {
      return [];
    }
  };
  const lastRunOf = (name: RunName): PulseRun | undefined => runsOf(name).at(-1);

  /**
   * A run's thread id, from plugin kv or the store's durable `runThreads` map.
   * The store copy exists because `bb plugin remove` wipes kv; without it every
   * reinstall would spawn a fresh thread for each run.
   */
  const storedRunThread = async (name: RunName): Promise<string | null> => {
    const cached = await bb.storage.kv.get<string>(threadKey(name));
    if (cached) return cached;
    // kv is the fast path; the store copy only matters after a reinstall. A store
    // read failure must not break an otherwise healthy run, so treat it as absent.
    try {
      const durable = storeModule.getRunThreads(home)?.[name];
      return typeof durable === "string" && durable ? durable : null;
    } catch (error) {
      bb.log.warn(`could not read run threads from ${home}: ${message(error)}`);
      return null;
    }
  };
  /**
   * Remember a run's thread in both places: kv for speed, the store directory so
   * it survives a plugin reinstall. A failed store write must not fail the run —
   * the thread works either way, only the next reinstall loses the id.
   */
  const rememberRunThread = async (name: RunName, threadId: string) => {
    await bb.storage.kv.set(threadKey(name), threadId);
    try {
      storeModule.setRunThread(name, threadId, home);
    } catch (error) {
      bb.log.warn(`could not persist ${name} run thread to ${home}: ${message(error)}`);
    }
  };
  const forgetRunThread = async (name: RunName) => {
    await bb.storage.kv.delete(threadKey(name));
    try {
      storeModule.setRunThread(name, null, home);
    } catch (error) {
      bb.log.warn(`could not clear ${name} run thread from ${home}: ${message(error)}`);
    }
  };
  /**
   * When kv and the store's copy are both gone (a new store directory, say), find the run thread
   * Pulse spawned earlier from the `pulseRun` metadata it put on it, instead of spawning a duplicate.
   */
  const recoverRunThread = async (name: RunName): Promise<string | null> => {
    if (!config.projectId) return null;
    try {
      const listed = await bb.sdk.threads.list({ projectId: config.projectId, includeHidden: true, archived: false, originPluginId: bb.pluginId, limit: 200 });
      const threads = listed as unknown as { id: string; createdAt: number; archivedAt?: unknown; deletedAt?: unknown }[];
      const live = threads.filter((t) => !t.archivedAt && !t.deletedAt);
      if (!live.length) return null;
      const meta = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: live.map((t) => t.id) });
      const rows = meta.threads as { threadId: string; metadata: Record<string, unknown> }[];
      const mine = new Set(rows.filter((r) => r.metadata?.pulseRun === name).map((r) => r.threadId));
      const found = live.filter((t) => mine.has(t.id)).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!found) return null;
      bb.log.info(`recovered the ${name} run thread ${found.id} from its plugin metadata`);
      await rememberRunThread(name, found.id);
      return found.id;
    } catch (error) {
      bb.log.warn(`could not look for an earlier ${name} run thread: ${message(error)}`);
      return null;
    }
  };

  type ThreadInfo = { status?: string; createdAt?: number; visibility?: string; queuedMessageCount?: number };
  type Probe = { state: "ok" | "dead" | "unknown"; thread?: ThreadInfo };
  /**
   * Whether a run thread can still receive a message. "dead" means the host answered definitively
   * that the thread is gone (archived, deleted, or unknown id) — retrying that id can only fail
   * again, so it is safe to discard. "unknown" means the probe itself failed for some other
   * reason; the thread may still be fine, so the caller keeps it and lets the send decide.
   */
  const probeRunThread = async (id: string): Promise<Probe> => {
    try {
      const thread = await bb.sdk.threads.get({ threadId: id });
      return { state: thread.archivedAt || thread.deletedAt ? "dead" : "ok", thread: thread as ThreadInfo };
    } catch (cause) {
      return { state: threadGone(cause) ? "dead" : "unknown" };
    }
  };
  /**
   * Panel snapshots probe every run thread, and the panel refetches on each store write, so a
   * capture run would otherwise cost several thread lookups per item it writes. Snapshots reuse a
   * probe for PROBE_TTL_MS; the run path always probes fresh before it sends.
   */
  const probeCache = new Map<string, { at: number; probe: Probe }>();
  const probe = async (id: string, fresh: boolean): Promise<Probe> => {
    const hit = probeCache.get(id);
    if (!fresh && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.probe;
    const result = await probeRunThread(id);
    probeCache.set(id, { at: Date.now(), probe: result });
    return result;
  };
  /** The run whose setting pins this thread, if any. A pin belongs to the user, not to Pulse. */
  const pinOwner = (threadId: string): RunName | null =>
    RUN_NAMES.find((r) => config.threads[r] !== "" && config.threads[r] === threadId) ?? null;
  /**
   * A pinned thread whose send failed permanently. Its probe can still look healthy (an
   * unavailable environment isn't archived), so without this every run would pick it again and
   * orphan a fresh replacement. Keyed by id and cleared on any change to the setting (see
   * settings.onChange), so editing the pin, even back to the same id, retries it.
   */
  /**
   * The thread a run should continue, or null to start a fresh one. The settings-pinned thread
   * wins over the cached one, but either may have gone stale, so each is probed. `prune` drops a
   * dead cached id from storage — only the run path does that; a panel refresh must not mutate
   * state, and an inconclusive probe leaves the id alone so a flaky call cannot churn threads.
   */
  const resolveRunThread = async (name: RunName, { prune = false } = {}): Promise<{ id: string; pinned: boolean; thread?: ThreadInfo } | null> => {
    await pinClears;
    const pinned = config.threads[name];
    const pinnedDead = pinned !== "" && (await bb.storage.kv.get<string>(deadPinnedKey(name))) === pinned;
    if (pinned && !pinnedDead) {
      const p = await probe(pinned, prune);
      if (p.state !== "dead") return { id: pinned, pinned: true, thread: p.thread };
    }
    const cached = (await storedRunThread(name)) ?? (prune ? await recoverRunThread(name) : null);
    if (!cached) return null;
    // A cached id that is another run's pin is the user's thread. Never send, clear or archive it
    // from here: forget the stale id and start this run's own thread instead.
    const owner = pinOwner(cached);
    if (owner && owner !== name) {
      if (!prune) return null;
      bb.log.warn(`${name} run thread ${cached} is the ${owner} thread setting; starting a fresh ${name} thread`);
      await forgetRunThread(name);
      return null;
    }
    const p = await probe(cached, prune);
    if (p.state !== "dead") return { id: cached, pinned: false, thread: p.thread };
    if (!prune) return null;
    bb.log.warn(`${name} run thread ${cached} is archived or gone; starting a new one`);
    await forgetRunThread(name);
    return null;
  };
  /** Which run, if any, currently sends to this thread (its cached thread or its pin). */
  const runForThread = async (threadId: string): Promise<{ name: RunName; pinned: boolean } | null> => {
    for (const name of RUN_NAMES) {
      if (config.threads[name] === threadId) return { name, pinned: true };
      if ((await storedRunThread(name)) === threadId) return { name, pinned: false };
    }
    return null;
  };

  /** Turn starts on run threads, for "busy since". Unknown after a reload: the dispatch time stands in. */
  const activeSince = new Map<string, number>();

  /** Only the cron registered at load can fire; the error bb gave when it refused one. */
  const registered = new Map<RunName, string | null>();

  /**
   * Whether a logged run covers this dispatch. A log stamped with `--started` covers only the
   * dispatch it names, so an older run that finishes after a newer prompt was queued can't hide
   * the newer one. Only unstamped logs fall back to "finished between this dispatch and the next".
   */
  const covered = (d: RunDispatch, next: RunDispatch | undefined, runs: PulseRun[]): boolean => {
    const at = Date.parse(d.at);
    const until = next ? Date.parse(next.at) : Infinity;
    return runs.some((r) => r.startedAt ? r.startedAt === d.at : Date.parse(r.finishedAt) > at && Date.parse(r.finishedAt) <= until);
  };
  /** Whether a dispatch didn't finish: no logged run covers it, and it can't still be running. */
  const unfinished = (d: RunDispatch, next: RunDispatch | undefined, runs: PulseRun[], now: number): boolean => {
    if (covered(d, next, runs)) return false;
    return next !== undefined || now - Date.parse(d.at) > UNFINISHED_MS;
  };

  async function loadAutomations(): Promise<{ automations: Automation[]; missedRuns: MissedRun[] }> {
    const now = Date.now();
    let runs: PulseRun[] = [];
    try { runs = store.readRuns(home); } catch { /* the snapshot reports store errors */ }
    const missedRuns: MissedRun[] = [];
    const automations = await Promise.all(
      RUN_NAMES.map(async (run): Promise<Automation> => {
        const cron = config.cron[run];
        const paused = await isPaused(run);
        const pendingReload = cron !== loadedCron[run];
        const scheduleError = !pendingReload && cron ? registered.get(run) ?? null : null;
        const pendingError = pendingReload && cron ? cronError(cron) : null;
        const enabled = !paused && cron !== "" && !pendingReload && !scheduleError;
        const resolved = await resolveRunThread(run);
        const sent = await dispatches(run);
        const ofRun = runs.filter((r) => r.run === run);
        const lastRun = ofRun.at(-1);
        const lastDispatch = sent.at(-1) ?? null;
        const failure = (await bb.storage.kv.get<RunFailure>(failureKey(run))) ?? null;
        // A failure counts until a later run of this name logs.
        const currentFailure = failure && (!lastRun || failure.at > lastRun.finishedAt) ? failure : null;
        const overdue = !!lastDispatch && !covered(lastDispatch, undefined, ofRun) && now - Date.parse(lastDispatch.at) > OVERDUE_MS;
        sent.forEach((d, i) => {
          if (now - Date.parse(d.at) < 3 * 86_400_000 && unfinished(d, sent[i + 1], ofRun, now)) missedRuns.push({ run, label: RUN_LABEL[run], ...d });
        });
        const pinned = config.threads[run];
        const pinState: Automation["pinState"] = config.sharedWith[run] ? "shared"
          : !pinned ? null
          : (await bb.storage.kv.get<string>(deadPinnedKey(run))) === pinned ? "skipped"
          : (await probe(pinned, false)).state === "dead" ? "dead" : "ok";
        const next = enabled ? nextCronRun(cron) : null;
        return {
          run, label: RUN_LABEL[run], threadId: resolved?.id ?? null, schedule: cron || null, enabled, paused, pendingReload,
          nextRunAt: next ? next.toISOString() : null,
          scheduleError, pendingError, failure: currentFailure, overdue, lastDispatchAt: lastDispatch?.at ?? null, pinState,
        };
      }),
    );
    missedRuns.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { automations, missedRuns };
  }

  const execution = () => ({
    ...(captureModel.providerId ? { providerId: captureModel.providerId } : {}),
    ...(captureModel.model ? { model: captureModel.model } : {}),
    ...(captureModel.reasoningLevel
      ? { reasoningLevel: captureModel.reasoningLevel as PluginProviderReasoningLevel }
      : {}),
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
  });

  const runStarting = new Set<RunName>();
  /**
   * A run thread is hidden from bb's thread list. It stays alive and sendable —
   * hidden is not archived, and archiving the *current* thread is exactly what wedged runs before.
   */
  const RUN_THREAD_VISIBILITY = "hidden" as const;
  /**
   * Hide a Pulse-made run thread that predates this default, so an upgraded install does not keep
   * one visible Pulse row per run. Never a pinned thread: that one is the user's. Best-effort.
   */
  const hideRunThread = async (name: RunName, threadId: string, info?: ThreadInfo) => {
    try {
      const visibility = info?.visibility ?? (await bb.sdk.threads.get({ threadId })).visibility;
      if (visibility === RUN_THREAD_VISIBILITY) return;
      await bb.sdk.threads.update({ threadId, visibility: RUN_THREAD_VISIBILITY });
      bb.log.info(`${name} run thread ${threadId} is now hidden`);
    } catch (error) {
      bb.log.warn(`could not hide ${name} run thread ${threadId}: ${message(error)}`);
    }
  };
  /** A 409 from a send that means the thread itself is unusable, not a transient conflict. */
  const deadThread = (cause: unknown) => /thread is archived|environment is unavailable|thread not found/i.test(message(cause));

  /**
   * A Pulse prompt still waiting in the thread's queue. A new run replaces its text rather than
   * queueing a second one, so a thread stuck behind a long turn ends up with one pending run that
   * carries the current window, not a pile of stale ones.
   */
  type QueuedRow = {
    id: string; updatedAt: number;
    /** The plugin that queued the row, stamped by the host; null for a message the user queued. */
    originPluginId?: string | null;
    /** What bb is still waiting for before it delivers the row. */
    waitingOn?: { kind?: string } | null;
    payload?: { kind?: string };
    content: { type: string; text?: string }[];
  };
  /** The queue, or null when it can't be read: an unreadable queue must not look like an empty one. */
  const queuedRows = async (threadId: string): Promise<QueuedRow[] | null> => {
    try {
      return (await bb.sdk.threads.queuedMessages.list({ threadId })) as QueuedRow[];
    } catch (error) {
      bb.log.warn(`could not read the queue of ${threadId}: ${message(error)}`);
      return null;
    }
  };
  const dropQueued = async (threadId: string, rows: QueuedRow[], label: string): Promise<string | null> => {
    const outcomes = await Promise.allSettled(
      rows.map((row) => bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: row.id })),
    );
    let failure: string | null = null;
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") bb.log.info(`dropped ${label}`);
      else failure ??= `skipped: could not clear the queued run on ${threadId} (${message(outcome.reason)})`;
    }
    return failure;
  };
  /** The run a queued row's header names. Only a row Pulse queued can name one. */
  const rowRun = (r: QueuedRow): RunName | null => {
    if (r.originPluginId !== bb.pluginId) return null;
    for (const c of r.content) {
      if (c.type !== "text") continue;
      const m = RUN_HEADER.exec(c.text ?? "");
      if (m) return m[1] as RunName;
    }
    return null;
  };
  /** Pulse's own queued prompt for this run. A header alone proves nothing: a user can quote one. */
  const isRunRow = (r: QueuedRow, name: RunName) => r.payload?.kind !== "retry" && rowRun(r) === name;
  /**
   * A queued row this run may delete. A row of unknown origin is never Pulse's, and Pulse only ever
   * replaces its own prompt for this run (or, on its own threads, its own pending retry).
   */
  const removableRow = (r: QueuedRow, name: RunName, pinned: boolean) => {
    // bb queues every retry with no origin, whoever asked for it, so origin can't identify one.
    // Only Pulse sends to its own (unpinned) threads, so a retry there re-runs an older Pulse
    // prompt; on a pinned thread it may be the user's turn, so it is left alone.
    if (r.payload?.kind === "retry") return !pinned;
    if (r.originPluginId !== bb.pluginId) return false;
    return rowRun(r) === name;
  };
  /**
   * Reasons bb still delivers a queued row later: a host that is offline, an environment being
   * provisioned, a timed send, a plugin's own gate, or a question waiting on the user. A row
   * waiting like that is not stranded work, even on a thread that reads as stopped.
   */
  const WAITING_KINDS = new Set(["host-offline", "provisioning", "time", "plugin", "interaction"]);
  const stillWaiting = (rows: QueuedRow[], name: RunName, pinned: boolean) =>
    rows.find((r) => {
      const kind = r.waitingOn?.kind;
      if (!kind || !WAITING_KINDS.has(kind)) return false;
      // A Pulse retry on its own thread waiting out its timer re-runs an older window; this run
      // supersedes it. Any other wait (offline host, provisioning, a gate) holds this run too.
      return !(kind === "time" && r.payload?.kind === "retry" && removableRow(r, name, pinned));
    });

  /** Send a run's prompt to its thread (created on first run, replaced once a day). */
  async function startRun(name: RunName, trigger: "schedule" | "manual" | "catch-up"): Promise<string> {
    if (!config.projectId) throw new Error("Choose a project in Pulse settings first");
    captureModel = normalizeCaptureModel(await bb.storage.kv.get(CAPTURE_MODEL_KEY));
    const startedAt = new Date();
    const at = startedAt.toISOString();
    const when = startedAt.toLocaleString("en-US", { timeZone: config.timeZone, dateStyle: "medium", timeStyle: "short" });
    const text = `[Pulse ${trigger === "schedule" ? "scheduled" : trigger} ${name} run · ${when}]\n\n${runPrompt(name, promptContext(at))}`;
    const input = [{ type: "text" as const, mentions: [], text }];
    let retire: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = await resolveRunThread(name, { prune: true });
      if (!target) break;
      const { id, pinned, thread } = target;
      // Read the queue at most once per attempt, and only when a path below needs it.
      let listed: QueuedRow[] | null = null;
      const rows = async () => (listed ??= await queuedRows(id));
      /**
       * Leave the thread alone and record why. Sending through an uncleared or unreadable queue
       * would run the window twice; the next tick can retry once the queue is readable.
       */
      const skipped = async (error: string) => {
        bb.log.warn(`${name} run ${error} (${id})`);
        await recordFailure(name, { at, error, threadId: id });
        return id;
      };
      // bb only drains a thread's queue when a turn ends, so a queue on a thread that has stopped
      // (on an error, or idle) never moves. Counting it as busy would refresh the same queued
      // prompt forever and never rotate the thread.
      const status = thread?.status;
      const stopped = status === "error" || status === "idle";
      const queued = (thread?.queuedMessageCount ?? 0) > 0;
      const busy = status === "active" || status === "starting" || status === "stopping" || status === "pending" || (queued && !stopped);
      // Someone else's message still queued here. Archiving the thread would strand it for good; a
      // turn on this thread drains it once the run ends, so the run goes here instead.
      let othersQueued = false;
      if (stopped && queued) {
        const list = await rows();
        if (!list) return skipped(`skipped: could not read the queue on ${id}`);
        const waiting = stillWaiting(list, name, pinned);
        if (waiting) {
          // bb will deliver this row on its own, so the run is waiting, not stranded. Leaving it
          // and not sending keeps one prompt per thread; the next tick checks again.
          bb.log.info(`${name} run waits: ${id} has a queued message waiting on ${waiting.waitingOn!.kind}`);
          return id;
        }
        // Drop Pulse's own stranded prompts (and, on its own threads, pending retries) so they
        // can't fire later on top of this run. Anything else in the queue is the user's.
        const stranded = list.filter((row) => removableRow(row, name, pinned));
        othersQueued = stranded.length < list.length;
        const dropped = await dropQueued(id, stranded, `a stranded queued run on ${id} (thread ${status})`);
        if (dropped) return skipped(dropped);
      }
      const old = !!thread?.createdAt && Date.now() - stamp(thread.createdAt) > ROTATE_MS;
      if (!pinned && !busy && !othersQueued && (old || status === "error")) {
        // State lives in the store and memory files, not the thread; a day-old thread only adds
        // context to resume, compact and time out on, and a thread that stopped on an error
        // (often a failed compaction) tends to fail again. Start fresh and retire this one below.
        retire = id;
        break;
      }
      if (busy) {
        // Before touching the queue: refreshing a queued prompt would otherwise keep a hung
        // thread looking fresh, and the panel would never say it is stuck.
        if (trigger === "schedule" && thread?.status === "active") {
          const since = activeSince.get(id) ?? stamp((await dispatches(name)).at(-1)?.at);
          if (Number.isFinite(since) && Date.now() - since > STUCK_MS) {
            const minutes = Math.round((Date.now() - since) / MINUTE);
            const error = `skipped: the ${RUN_LABEL[name]} thread has been busy for ${minutes} min`;
            bb.log.warn(`${name} run ${error} (${id})`);
            await recordFailure(name, { at, error, threadId: id });
            return id;
          }
        }
        const list = await rows();
        if (!list) return skipped(`skipped: could not read the queue on ${id}`);
        const row = list.find((r) => isRunRow(r, name));
        // A pending automatic retry re-sends an older prompt; this one supersedes it. (Only on
        // Pulse's own threads: a pinned thread's retries may be the user's.)
        if (!pinned) {
          const dropped = await dropQueued(
            id,
            list.filter((r) => r.payload?.kind === "retry"),
            `the pending retry on ${id}; the new ${name} run replaces it`,
          );
          if (dropped) return skipped(dropped);
        }
        if (row) {
          try {
            await bb.sdk.threads.queuedMessages.update({ threadId: id, queuedMessageId: row.id, expectedUpdatedAt: row.updatedAt, input });
            await recordDispatch(name, { at, threadId: id, trigger }, { replace: true });
            bb.log.info(`${trigger} ${name} run → ${id} (replaced the run already queued there)`);
            return id;
          } catch (error) {
            // The row changed or started draining under us. Sending a fresh prompt now could run
            // the window twice, so send only once the row is confirmed gone.
            bb.log.warn(`could not update the queued ${name} run on ${id}: ${message(error)}; re-reading the queue`);
            const after = await queuedRows(id);
            if (after === null || after.some((r) => r.id === row.id)) return skipped(`skipped: could not replace the queued run on ${id}`);
            listed = after; // the row is gone; fall through and send a fresh prompt
          }
        }
      }
      const { providerId: _providerId, ...sendExecution } = execution();
      const sources = Object.fromEntries(Object.keys(sendExecution).map((k) => [k, "explicit" as const]));
      try {
        await bb.sdk.threads.send({
          threadId: id,
          mode: "queue-if-active",
          input,
          ...sendExecution,
          ...(Object.keys(sources).length ? { executionInputSources: sources } : {}),
        });
        await recordDispatch(name, { at, threadId: id, trigger });
        bb.log.info(`${trigger} ${name} run → ${id}`);
        if (!pinned) void hideRunThread(name, id, thread);
        return id;
      } catch (cause) {
        // The thread died between the probe above and this send (archived, deleted, or its
        // environment reclaimed). Retrying the same id can only fail again.
        if (!deadThread(cause)) throw cause;
        const reason = message(cause);
        if (pinned) {
          // The pin comes from settings, so it can't be forgotten; skip it until the setting
          // changes, and fall back to the cached run thread (which was never tried).
          bb.log.warn(`pinned ${name} run thread ${id} is unusable (${reason}); using Pulse's own thread until the ${RUN_LABEL[name]} thread setting changes`);
          await bb.storage.kv.set(deadPinnedKey(name), id);
        } else {
          bb.log.warn(`${name} run thread ${id} became unusable (${reason}); starting a new one`);
          await forgetRunThread(name);
        }
      }
    }
    if (runStarting.has(name)) throw new Error(`The ${name} thread is already being created`);
    runStarting.add(name);
    try {
      const sectionId = await sectionIdFor();
      const spawnExecution = execution();
      const spawnSources = Object.fromEntries(Object.keys(spawnExecution).map((k) => [k, "explicit" as const]));
      const thread = await bb.sdk.threads.spawn({
        projectId: config.projectId,
        ...(sectionId ? { sectionId } : {}),
        environment: { type: "project-default" },
        title: `Pulse ${RUN_LABEL[name]}`,
        prompt: text,
        visibility: RUN_THREAD_VISIBILITY,
        ...spawnExecution,
        ...(Object.keys(spawnSources).length ? { executionInputSources: spawnSources } : {}),
        pluginMetadata: { pulseRun: name },
      });
      await rememberRunThread(name, thread.id);
      await recordDispatch(name, { at, threadId: thread.id, trigger });
      bb.log.info(`${trigger} ${name} run → new thread ${thread.id}`);
      if (retire) {
        // Checked again just before the archive: the settings can change while the replacement
        // spawns, and the thread may have taken work in the meantime.
        await retireRunThread(name, retire);
      }
      publish();
      return thread.id;
    } finally {
      runStarting.delete(name);
    }
  }

  /**
   * Archive a run thread this run has finished with, after the replacement exists. Every check is
   * repeated here because the resolve above can be minutes old: a thread that became a pin, took a
   * turn, or holds queued work is kept, with a log line saying why.
   */
  async function retireRunThread(name: RunName, threadId: string) {
    const owner = pinOwner(threadId);
    if (owner) {
      bb.log.warn(`kept the previous ${name} run thread ${threadId}: it is now the ${owner} thread setting`);
      return;
    }
    let info: ThreadInfo & { archivedAt?: unknown; deletedAt?: unknown };
    try {
      info = await bb.sdk.threads.get({ threadId });
    } catch (error) {
      bb.log.warn(`kept the previous ${name} run thread ${threadId}: could not re-check it (${message(error)})`);
      return;
    }
    if (info.archivedAt || info.deletedAt) return;
    if (info.status !== "idle" && info.status !== "error") {
      bb.log.info(`kept the previous ${name} run thread ${threadId}: it is ${info.status ?? "busy"} again`);
      return;
    }
    // Pulse's own stranded rows were removed above, so anything still queued is someone else's.
    const rows = await queuedRows(threadId);
    if (!rows) {
      bb.log.warn(`kept the previous ${name} run thread ${threadId}: its queue could not be read`);
      return;
    }
    if (rows.length) {
      bb.log.warn(`kept the previous ${name} run thread ${threadId}: it has ${rows.length} queued message(s) that are not this run's`);
      return;
    }
    await bb.sdk.threads.archive({ threadId }).then(
      () => bb.log.info(`retired the previous ${name} run thread ${threadId}`),
      (error) => bb.log.warn(`could not archive the previous ${name} run thread ${threadId}: ${message(error)}`),
    );
    probeCache.delete(threadId);
  }

  /**
   * Why an Hourly run at `now` should skip: a Daily or Weekly run fires within COLLIDE_MS (it reads
   * the same window and more), or one is still in flight. Two full runs on one window re-edit each
   * other's items and double the quota; this applies to existing configs, not just the defaults.
   */
  const hourlyYields = async (now: number): Promise<string | null> => {
    for (const other of ["daily", "weekly"] as const) {
      const cron = loadedCron[other];
      if (!cron || config.cron[other] !== cron || registered.get(other) || (await isPaused(other))) continue;
      const prev = prevCronRun(cron, new Date(now + 1000));
      const next = nextCronRun(cron, new Date(now));
      if ((prev && now - prev.getTime() <= COLLIDE_MS) || (next && next.getTime() - now <= COLLIDE_MS)) return `the ${RUN_LABEL[other]} run is scheduled within 45 minutes`;
      const sent = (await dispatches(other)).at(-1);
      if (sent && !covered(sent, undefined, runsOf(other)) && now - Date.parse(sent.at) < UNFINISHED_MS) return `the ${RUN_LABEL[other]} run is still in progress`;
    }
    return null;
  };

  const scheduledRun = async (run: RunName, trigger: "schedule" | "catch-up") => {
    if (run === "hourly") {
      const reason = await hourlyYields(Date.now());
      if (reason) { bb.log.info(`hourly run skipped: ${reason}`); return; }
    }
    await startRun(run, trigger);
  };

  for (const run of RUN_NAMES) {
    const cron = config.cron[run];
    if (!cron) continue;
    try {
      bb.background.schedule(`run-${run}`, cron, async () => {
        try {
          // The SDK can't unschedule, so a cron changed or cleared in settings leaves this job
          // registered until reload. Skip it rather than run on a cadence the user turned off.
          if (config.cron[run] !== cron) return;
          if (await isPaused(run)) return;
          await scheduledRun(run, "schedule");
        } catch (error) {
          // bb records this in `bb plugin list`; log it here too, and show it in the panel.
          bb.log.warn(`scheduled ${run} run failed: ${message(error)}`);
          await recordFailure(run, { at: new Date().toISOString(), error: message(error), threadId: null }).catch(() => undefined);
          throw error;
        }
      });
      registered.set(run, null);
    } catch (error) {
      registered.set(run, message(error));
      bb.log.warn(`schedule ${run} ("${cron}"): ${message(error)}`);
    }
  }

  /**
   * bb sets each schedule's next run to the next *future* tick on every load, so a tick that came
   * due while bb was quit or Pulse was reloading is lost (for Weekly, a whole week). On load, run
   * any enabled schedule whose latest tick in the last day has no dispatch and no logged run.
   * A fresh install (no dispatch, no run yet) has missed nothing.
   */
  /** The cron each run had at the previous load: a tick under a different schedule was never due. */
  const previousCron = new Map<RunName, string | undefined>();
  for (const run of RUN_NAMES) {
    previousCron.set(run, await bb.storage.kv.get<string>(`cron:${run}`));
    await bb.storage.kv.set(`cron:${run}`, loadedCron[run]);
  }
  async function catchUp() {
    const now = Date.now();
    for (const run of ["weekly", "daily", "hourly"] as const) {
      const cron = loadedCron[run];
      if (!cron || registered.get(run) !== null || (await isPaused(run))) continue;
      if (previousCron.get(run) !== cron) continue; // first load with this schedule (or of 0.1.15)
      const tick = prevCronRun(cron, new Date(now));
      if (!tick || now - tick.getTime() > CATCH_UP_WINDOW_MS || now - tick.getTime() < CATCH_UP_GRACE_MS) continue;
      // An Hourly tick that yielded to a Daily or Weekly run at the time was skipped on purpose.
      if (run === "hourly" && (await hourlyYields(tick.getTime()))) continue;
      const last = lastRunOf(run);
      const sent = (await dispatches(run)).at(-1);
      if (!last && !sent) continue;
      const tickIso = tick.toISOString();
      if ((last && last.finishedAt >= tickIso) || (sent && sent.at >= tickIso)) continue;
      bb.log.info(`${run} run due ${tickIso} was missed while Pulse was not loaded; catching up`);
      try {
        await scheduledRun(run, "catch-up");
      } catch (error) {
        bb.log.warn(`catch-up ${run} run failed: ${message(error)}`);
        await recordFailure(run, { at: new Date().toISOString(), error: message(error), threadId: null }).catch(() => undefined);
      }
    }
  }

  // Task capability changes use the same debounced notification as store writes.
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => bb.realtime.publish(CHANGED, { at: new Date().toISOString() }), 250);
  };
  // Retired native Task keys must not be registered again: old rows can survive descriptor removal.
  const taskSettings = await createTaskSettings({ bb, onChange: () => { tasks.settingsChanged(); publish(); } });
  const tasks = createTasks({ bb, home, getConfig: () => taskSettings.get(), readSettings: () => taskSettings.read(), publish });

  async function fullSnapshot(): Promise<PulseSnapshot> {
    const snap = store.snapshot(home);
    // Tell the panel which skills an agent thread would load, for the robot button's tooltip.
    const items = snap.items.map((i) => (i.status === "open" || i.status === "waiting" ? { ...i, agentSkills: skillsForItem(i).map((k) => k.name) } : i));
    const { automations, missedRuns } = await loadAutomations();
    const capabilities = tasks.refreshCapabilities();
    return {
      ...snap, items, ...capabilities, taskIntegrationEnabled: taskSettings.get().enabled, automations, missedRuns, parentThreadId: null,
      needsProject: !config.projectId,
      projectSetLive: loadedWithoutProject && !!config.projectId,
      homePending: config.home !== home,
    };
  }

  // Live updates: any write to the store dir (CLI or panel) nudges the panel.
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(home, { recursive: true }, (_event, file) => {
      const f = String(file ?? "");
      if (f.endsWith(".tmp") || f.startsWith(".lock") || f.endsWith(".bak")) return;
      actionThreads = null;
      publish();
    });
  } catch (error) {
    bb.log.warn(`cannot watch ${home}: ${message(error)}`);
  }

  bb.rpc.register(rpcContract, {
    pulse_snapshot: () => fullSnapshot(),
    pulse_action: async ({ id, action, until, restore }) => {
      const status = action === "reopen" && restore ? restore : STATUS_FOR[action];
      store.userAction(id, status, { until, by: "user", ...(action === "reopen" && restore ? { reason: "undo" } : {}) }, home);
      return fullSnapshot();
    },
    pulse_task_settings: async () => {
      const tasksPluginEnabled = await tasks.pluginEnabled().catch(() => false);
      return { ...taskSettings.get(), tasksPluginEnabled };
    },
    pulse_task_settings_update: async (patch) => {
      if (patch.enabled && !await tasks.pluginEnabled()) throw new Error("Install and enable Tasks before enabling Task integration");
      await taskSettings.update(patch);
      const tasksPluginEnabled = await tasks.pluginEnabled().catch(() => false);
      return { ...taskSettings.get(), tasksPluginEnabled };
    },
    pulse_task_projects: () => tasks.projects(),
    pulse_task_labels: (input) => tasks.labels(input),
    pulse_task_search: (input) => tasks.search(input),
    pulse_task_recommend: (input) => tasks.recommend(input),
    pulse_task_link: async (input) => { await tasks.link(input); return fullSnapshot(); },
    pulse_task_unlink: async (input) => { await tasks.unlink(input); return fullSnapshot(); },
    pulse_task_create: async (input) => { await tasks.create(input); return fullSnapshot(); },
    pulse_model_get: async () => {
      captureModel = normalizeCaptureModel(await bb.storage.kv.get(CAPTURE_MODEL_KEY));
      return captureModel;
    },
    pulse_model_set: async (input) => {
      const next = normalizeCaptureModel(input);
      await bb.storage.kv.set(CAPTURE_MODEL_KEY, next);
      captureModel = next;
      publish();
      return next;
    },
    pulse_seen: async () => {
      store.markSeen(undefined, home);
      return fullSnapshot();
    },
    pulse_run_now: async ({ run: name }) => ({ threadId: await startRun(name, "manual") }),
    pulse_set_run_enabled: async ({ run: name, enabled }) => {
      await bb.storage.kv.set(pausedKey(name), !enabled);
      publish();
      return fullSnapshot();
    },
    pulse_start_action: async ({ id }) => {
      const threadId = await startAction(id);
      return { threadId, snapshot: await fullSnapshot() };
    },
    pulse_action_seen: async ({ id }) => {
      store.markActionSeen(id, home);
      return fullSnapshot();
    },
  });

  const starting = new Set<string>();
  async function startAction(id: string): Promise<string> {
    const item = store.getItem(id, home);
    if (item.action?.status === "running") return item.action.threadId;
    if (starting.has(id)) throw new Error("An action for this item is already starting");
    starting.add(id);
    try {
      if (!config.projectId) throw new Error("Choose a project in Pulse settings first");
      const sectionId = await sectionIdFor();
      const thread = await bb.sdk.threads.spawn({
        projectId: config.projectId,
        ...(sectionId ? { sectionId } : {}),
        environment: { type: "project-default" },
        title: item.title.slice(0, 120),
        prompt: actionPrompt(taskSettings.get().enabled ? item : { ...item, taskLinks: [] }, { user: config.user, sources: config.sources, timeZone: config.timeZone, skills: skillsForItem(item) }),
        pluginMetadata: { pulseItemId: id },
      });
      try {
        store.startAction(id, { threadId: thread.id, by: "user" }, home);
        actionThreads = null;
      } catch (error) {
        // Unrecorded, the thread would work unseen and the next click would spawn a second one.
        bb.log.warn(`action ${id}: could not record thread ${thread.id}; stopping and archiving it`);
        await bb.sdk.threads.stop({ threadId: thread.id }).catch(() => undefined);
        await bb.sdk.threads.archive({ threadId: thread.id }).catch((e) => bb.log.warn(`archive ${thread.id}: ${message(e)}`));
        throw new Error(`Couldn't record the agent thread, so it was stopped: ${message(error)}`);
      }
      await notifyOnFinish(thread.id);
      bb.log.info(`action ${id} → ${thread.id}`);
      return thread.id;
    } finally {
      starting.delete(id);
    }
  }

  /** The configured sidebar section, created when missing. A failure never blocks a run or action. */
  async function sectionIdFor(): Promise<string | null> {
    const name = config.section;
    if (!name) return null;
    try {
      const sections = (await bb.sdk.threadSections.list()) as ReadonlyArray<{ id: string; name: string }>;
      const existing = sections.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
      return existing ? existing.id : (await bb.sdk.threadSections.create({ name })).id;
    } catch (error) {
      bb.log.warn(`section "${name}" unavailable: ${message(error)}`);
      return null;
    }
  }

  // Notification path: the builtin push-notifications plugin notifies on finished turns only for
  // threads at level "all"; child threads default to "input-only". Raise this thread to "all" so
  // its finished turn reaches the user on mobile (Expo push), web and desktop.
  async function notifyOnFinish(threadId: string) {
    try {
      await bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "threadNotifications.set",
        input: { threadId, level: "all" },
        outputSchema: z.any(),
      });
    } catch (error) {
      bb.log.warn(`push-notifications level for ${threadId}: ${message(error)}`);
    }
  }

  /**
   * Thread ids of items' agent actions. Thread events fire for every thread in bb, including the
   * run threads' own turns, so look them up in memory and only read items.json for a real match.
   * Reset on every store write.
   */
  let actionThreads: Set<string> | null = null;
  const isActionThread = (threadId: string) => {
    if (!actionThreads) {
      try { actionThreads = new Set(store.actionItems(null, home).map((i) => i.action!.threadId)); } catch { return true; }
    }
    return actionThreads.has(threadId);
  };
  const itemForThread = (threadId: string) => store.actionItems(null, home).find((i) => i.action?.threadId === threadId);
  const settle = (threadId: string, status: ActionStatus, summary?: string | null) => {
    if (!isActionThread(threadId)) return;
    const item = itemForThread(threadId);
    if (!item || item.action?.status === status) return;
    store.setActionStatus(item.id, status, { threadId, summary, by: "pulse" }, home);
    bb.log.info(`action ${item.id} (${threadId}) → ${status}`);
    publish();
  };
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    activeSince.delete(thread.id);
    settle(thread.id, "ready", readySummary(lastAssistantText));
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    activeSince.delete(thread.id);
    settle(thread.id, "failed", error ?? "Thread stopped on an error");
  });
  bb.events.on("thread.active", ({ thread }) => {
    activeSince.set(thread.id, Date.now());
    settle(thread.id, "running");
  });
  /**
   * A run turn that failed after the send (resume or start timed out, compaction in progress,
   * provider error). Retry a Pulse thread's first failure once, later; record anything else so the
   * run menu says so instead of the board quietly going stale.
   */
  bb.events.on("turn.failed", async (event) => {
    try {
      const owner = await runForThread(event.threadId);
      if (!owner) return;
      const info = event.errorInfo;
      const why = info ? `${info.category}${info.providerCode ? ` (${info.providerCode})` : ""}${info.httpStatusCode ? ` HTTP ${info.httpStatusCode}` : ""}` : "the turn failed";
      const at = new Date().toISOString();
      if (event.attemptNumber === 1 && !owner.pinned) {
        const retryAt = Date.now() + RETRY_DELAY_MS;
        try {
          await bb.sdk.threads.retry({ threadId: event.threadId, turnRequestId: event.requestId, sendAt: retryAt, reason: "Pulse: retrying a failed run once" });
          bb.log.warn(`${owner.name} run on ${event.threadId} failed (${why}); retrying in ${RETRY_DELAY_MS / MINUTE} min`);
          await recordFailure(owner.name, { at, error: `${why}; retrying`, threadId: event.threadId, retryAt: new Date(retryAt).toISOString() });
          return;
        } catch (error) {
          bb.log.warn(`could not retry the ${owner.name} run on ${event.threadId}: ${message(error)}`);
        }
      }
      bb.log.warn(`${owner.name} run on ${event.threadId} failed (${why}, attempt ${event.attemptNumber})`);
      await recordFailure(owner.name, { at, error: why, threadId: event.threadId });
    } catch (error) {
      bb.log.warn(`turn.failed handler: ${message(error)}`);
    }
  });

  // Safety net for events missed while the plugin was reloading: reconcile running actions.
  async function reconcile() {
    await Promise.all(
      store.actionItems("running", home).map(async (item) => {
      const threadId = item.action!.threadId;
      try {
        const t = await bb.sdk.threads.get({ threadId });
        if (t.deletedAt || t.archivedAt) settle(threadId, "failed", "Action thread was archived or deleted");
        else if (t.status === "error") settle(threadId, "failed", "Thread stopped on an error");
        else if (t.status === "idle") {
          const out = await bb.sdk.threads.output({ threadId }).catch(() => ({ output: null }));
          settle(threadId, "ready", readySummary(out.output));
        }
      } catch (error) {
        // A deleted thread answers 404 forever; settle it instead of retrying every pass.
        if (threadGone(error)) settle(threadId, "failed", "Action thread was archived or deleted");
        else bb.log.warn(`reconcile ${threadId}: ${message(error)}`);
      }
      }),
    );
  }
  /** Expired snoozes, aged-out FYIs, archiving: writes only when there is work. */
  const housekeep = () => {
    try {
      const out = store.housekeep(home);
      if (out.snoozesExpired.length || out.fyisExpired.length || out.archivedItems || out.archivedRuns) {
        bb.log.info(`housekeeping: ${out.snoozesExpired.length} snooze(s) woke, ${out.fyisExpired.length} FYI(s) aged out, ${out.archivedItems} item(s) and ${out.archivedRuns} run(s) archived`);
      }
    } catch (error) {
      bb.log.warn(`housekeeping: ${message(error)}`);
    }
  };
  bb.background.service("action-reconcile", {
    async start(signal) {
      await catchUp().catch((error) => bb.log.warn(`catch-up: ${message(error)}`));
      while (!signal.aborted) {
        housekeep();
        await reconcile();
        await tasks.reconcile(signal).catch((error) => bb.log.warn(`task reconcile: ${message(error)}`));
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, RECONCILE_MS);
          signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
    },
  });

  bb.onDispose(async () => {
    tasks.dispose();
    watcher?.close();
    if (publishTimer) clearTimeout(publishTimer);
  });
}
