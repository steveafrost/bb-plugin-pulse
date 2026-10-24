/**
 * bb-plugin-thirdhand — server.
 *
 * Third Hand on the iPhone owns the data (thirdhand-ios docs/DATA-CONTRACT.md). This
 * server reads the iOS snapshot from the mirror directory (lib/snapshot.mjs),
 * never writes it, and forwards the panel's user actions as commands
 * (lib/commands.mjs) for the app to apply. It watches snapshot.json and polls it
 * every 5 s, pushing `thirdhand-changed` only when `generatedAt` advances.
 *
 * Boundaries worth knowing:
 *   - The mirror is the panel's only item source. `lib/store.mjs` and the `thirdhand`
 *     CLI over it still work for an install that has not migrated, but nothing in
 *     the panel's read or write path touches items.json any more.
 *   - Capture runs are legacy: iOS captures now, so schedules are off by default
 *     (`captureRuns: "iphone"`). The run code below is kept intact and gated by
 *     that setting (`captureRuns: "mac"` restores the old behaviour exactly)
 *     rather than deleted, because it is entangled with run threads, the durable
 *     thread map and the run log the panel still displays.
 *   - Agent threads stay: they are Mac-local activity, so their records live in
 *     $THIRDHAND_HOME/actions.json (lib/actions.mjs), never in the snapshot.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
// @ts-ignore -- plain ESM module shared with the CLI
import * as storeModule from "./lib/store.mjs";
// @ts-ignore -- plain ESM module (plain JS, no build step)
import * as mirrorModule from "./lib/snapshot.mjs";
// @ts-ignore -- plain ESM module
import * as commandsModule from "./lib/commands.mjs";
// @ts-ignore -- plain ESM module
import * as actionsModule from "./lib/actions.mjs";
// @ts-ignore -- plain ESM module
import * as panelModule from "./lib/panel.mjs";
import { nextCronRun } from "./lib/cron";
import { DEFAULT_SOURCES, runPrompt, type PromptContext, type RunName } from "./lib/prompts";
import { parseSkillRules, skillsFor, type SkillRef, type SkillRule } from "./lib/skills";
import { threadGone } from "./lib/thread-gone";
import { actionPrompt, readySummary, type ActionContext } from "./lib/action";

export { actionPrompt, readySummary, type ActionContext };
import type { ActionStatus, Automation, ItemAction, ThirdHandItem, ThirdHandRun, ThirdHandSnapshot } from "./types";

type Home = string;
/**
 * Only the pieces of the legacy store this server still needs: home resolution
 * and the durable run-thread map (which survives a plugin reinstall). The panel's
 * item read and write paths are the mirror and the command writer, below.
 */
const store = storeModule as unknown as {
  thirdhandHome(): string;
  getRunThreads(home: Home): Record<string, string>;
  setRunThread(name: string, threadId: string | null, home: Home): Record<string, string>;
};

interface MirrorRead {
  state: "connected" | "not-connected" | "error" | "update";
  dir: string;
  file: string;
  schemaVersion: number | null;
  generatedAt: string | null;
  deviceName: string | null;
  lastViewedAt: string | null;
  items: ThirdHandItem[];
  runs: ThirdHandRun[];
  draft: ThirdHandSnapshot["draft"];
  message: string | null;
}
const mirror = mirrorModule as unknown as {
  resolveMirrorDir(env?: NodeJS.ProcessEnv): string;
  readSnapshot(opts?: { dir?: string }): MirrorRead;
  createMirrorPoller(opts: { dir: string; onChange?: (result: MirrorRead) => void }): { poll(): boolean; reset(): void };
};
const commands = commandsModule as unknown as {
  enqueue(input: { op: ItemAction; itemId: string; until?: string | null; reason?: string | null }, opts?: { dir?: string }): { command: unknown; queued: boolean };
  dropAcked(opts?: { dir?: string }): { removed: number; compacted: boolean };
  readPending(dir?: string): unknown[];
};
const panel = panelModule as unknown as {
  pendingByItem(pending?: unknown[]): Map<string, ItemAction[]>;
  actionsByItem(entries?: Array<[string, NonNullable<ThirdHandItem["action"]>]>): Record<string, NonNullable<ThirdHandItem["action"]>>;
  projectItems(items: ThirdHandItem[], opts: { actions?: Record<string, NonNullable<ThirdHandItem["action"]>>; pending?: Map<string, ItemAction[]>; skillsFor?: ((item: ThirdHandItem) => SkillRef[]) | null }): ThirdHandItem[];
};
const actions = actionsModule as unknown as {
  startAction(home: Home, id: string, opts: { threadId: string; at?: string }): NonNullable<ThirdHandItem["action"]>;
  setActionStatus(home: Home, id: string, status: ActionStatus, opts: { threadId?: string; summary?: string | null }): NonNullable<ThirdHandItem["action"]> | null;
  markActionSeen(home: Home, id: string): NonNullable<ThirdHandItem["action"]> | null;
  actionEntries(home: Home, status?: ActionStatus | null): Array<[string, NonNullable<ThirdHandItem["action"]>]>;
};

const CHANGED = "thirdhand-changed";
const RUN_NAMES: RunName[] = ["hourly", "daily", "weekly"];
const RUN_LABEL: Record<RunName, string> = { hourly: "Hourly", daily: "Daily", weekly: "Weekly" };
const DEFAULT_CRON: Record<RunName, string> = { hourly: "0 */2 * * *", daily: "0 16 * * *", weekly: "0 15 * * 5" };
const RECONCILE_MS = 2 * 60_000;
const PROBE_TTL_MS = 30_000;
/** The contract's snapshot poll cadence (DATA-CONTRACT.md, write protocol step 2). */
const MIRROR_POLL_MS = 5_000;
/** Plugin root (server runs from dist/server.js or ./server.ts). */
const ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist" ? path.dirname(here) : here;
})();

const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export const rpcContract = defineRpcContract({
  thirdhand_snapshot: { input: z.null(), output: z.any() },
  thirdhand_action: {
    input: z.object({
      id: z.string().min(3).max(400),
      action: z.enum(["done", "dismiss", "snooze", "reopen"]),
      until: z.string().datetime().optional(),
    }),
    output: z.any(),
  },
  thirdhand_seen: { input: z.null(), output: z.any() },
  thirdhand_run_now: { input: z.object({ run: z.enum(["hourly", "daily", "weekly"]) }), output: z.object({ threadId: z.string() }) },
  thirdhand_set_run_enabled: { input: z.object({ run: z.enum(["hourly", "daily", "weekly"]), enabled: z.boolean() }), output: z.any() },
  thirdhand_start_action: { input: z.object({ id: z.string().min(3).max(400) }), output: z.any() },
  thirdhand_action_seen: { input: z.object({ id: z.string().min(3).max(400) }), output: z.any() },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    project: { type: "project", label: "Project for run and agent threads", description: "Third Hand creates its Hourly, Daily and Weekly threads and its agent threads here. Required." },
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
    model: { type: "string", label: "Model for capture runs (empty = thread default)", default: "" },
    reasoningLevel: { type: "select", label: "Reasoning level for capture runs", options: ["default", "low", "medium", "high"], experimental_optionLabels: { default: "Thread default" }, default: "default" },
    permissionMode: {
      type: "select", label: "Permission mode for capture runs", options: ["default", "accept-edits", "auto", "full"],
      experimental_optionLabels: { default: "Thread default" }, default: "default",
      description: "Runs call the Third Hand CLI from a shell, so they need permission to run commands.",
    },
    hourlyCron: { type: "string", label: "Hourly schedule (cron, server time; empty = off)", description: "The default runs every 2 hours.", default: DEFAULT_CRON.hourly },
    dailyCron: { type: "string", label: "Daily schedule (cron, server time; empty = off)", default: DEFAULT_CRON.daily },
    weeklyCron: { type: "string", label: "Weekly schedule (cron, server time; empty = off)", default: DEFAULT_CRON.weekly },
    section: { type: "string", label: "Sidebar section for Third Hand threads (created if missing; empty = none)", default: "Third Hand" },
    timeZone: { type: "string", label: "Time zone (IANA; empty = server time zone)", default: "" },
    snapshotDir: {
      type: "string", label: "Mirror directory (empty = $THIRDHAND_SNAPSHOT_DIR, else the Third Hand iCloud folder)", default: "",
      description: "Where Third Hand on the iPhone writes snapshot.json. Leave empty to use its iCloud container, or point it at any folder that mirrors it.",
    },
    captureRuns: {
      type: "select", label: "Capture runs", options: ["iphone", "mac"], default: "iphone",
      experimental_optionLabels: { iphone: "Third Hand on iPhone (recommended)", mac: "This Mac (legacy schedules)" },
      description: "Third Hand captures on the iPhone now. Mac schedules are kept for installs that still rely on them, and are off by default.",
    },
    storeDir: { type: "string", label: "Plugin state directory (empty = $THIRDHAND_HOME or ~/.config/thirdhand)", default: "" },
    hourlyThread: { type: "string", label: "Existing thread for Hourly runs (optional thread id)", default: "" },
    dailyThread: { type: "string", label: "Existing thread for Daily runs (optional thread id)", default: "" },
    weeklyThread: { type: "string", label: "Existing thread for Weekly runs (optional thread id)", default: "" },
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
      model: v.model.trim(),
      reasoningLevel: (v.reasoningLevel === "default" ? "" : v.reasoningLevel) as "" | "low" | "medium" | "high",
      permissionMode: (v.permissionMode === "default" ? "" : v.permissionMode) as "" | "accept-edits" | "auto" | "full",
      cron: { hourly: v.hourlyCron.trim(), daily: v.dailyCron.trim(), weekly: v.weeklyCron.trim() } as Record<RunName, string>,
      section: v.section.trim(),
      timeZone: (() => { try { new Intl.DateTimeFormat("en-US", { timeZone }); return timeZone; } catch { bb.log.warn(`bad time zone "${timeZone}"`); return systemTimeZone(); } })(),
      // Absolute, so the panel and the run's shell (which runs in the project cwd) share one store.
      home: path.resolve(os.homedir(), v.storeDir.trim().replace(/^~(?=\/|$)/, os.homedir()) || store.thirdhandHome()),
      // Resolved once at load: THIRDHAND_SNAPSHOT_DIR, then THIRDHAND_HOME, then the app's iCloud container.
      mirrorDir: path.resolve(os.homedir(), (v.snapshotDir ?? "").trim().replace(/^~(?=\/|$)/, os.homedir()) || mirror.resolveMirrorDir()),
      captureOnMac: (v.captureRuns ?? "iphone") === "mac",
      threads: { hourly: v.hourlyThread.trim(), daily: v.dailyThread.trim(), weekly: v.weeklyThread.trim() } as Record<RunName, string>,
    };
  };
  let config = readConfig(await settings.get());
  const home = config.home;
  const loadedCron = { ...config.cron };
  settings.onChange((next) => {
    const prev = config;
    config = readConfig(next);
    if (config.home !== prev.home || config.mirrorDir !== prev.mirrorDir || RUN_NAMES.some((r) => config.cron[r] !== prev.cron[r])) {
      bb.log.info("mirror or state directory changed; run `bb plugin reload` to apply");
    }
    publish();
  });
  fs.mkdirSync(home, { recursive: true });
  // A project is only needed for the Mac-side surfaces: legacy run threads and agent threads.
  if (!config.projectId && config.captureOnMac) bb.status.needsConfiguration("Choose a project for Third Hand's run threads, then reload the plugin.");

  const cliCommand = () => `THIRDHAND_HOME=${shellQuote(home)} node ${shellQuote(path.join(ROOT, "bin/thirdhand.mjs"))}`;
  const promptContext = (): PromptContext => ({
    cli: cliCommand(), user: config.user, timeZone: config.timeZone, memoryDir: path.join(home, "memory"),
    sources: config.sources, instructions: config.instructions,
  });
  const skillsForItem = (item: ThirdHandItem) => skillsFor(item, config.skillRules);

  // ---- Capture runs (plugin-owned schedules) ----
  const pausedKey = (name: RunName) => `paused:${name}`;
  const threadKey = (name: RunName) => `thread:${name}`;
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
      bb.log.warn(`could not read run threads from ${home}: ${error instanceof Error ? error.message : String(error)}`);
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
      bb.log.warn(`could not persist ${name} run thread to ${home}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const forgetRunThread = async (name: RunName) => {
    await bb.storage.kv.delete(threadKey(name));
    try {
      storeModule.setRunThread(name, null, home);
    } catch (error) {
      bb.log.warn(`could not clear ${name} run thread from ${home}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  /**
   * Whether a run thread can still receive a message. "dead" means the host answered definitively
   * that the thread is gone (archived, deleted, or unknown id) — retrying that id can only fail
   * again, so it is safe to discard. "unknown" means the probe itself failed for some other
   * reason; the thread may still be fine, so the caller keeps it and lets the send decide.
   */
  const probeRunThread = async (id: string): Promise<"ok" | "dead" | "unknown"> => {
    try {
      const thread = await bb.sdk.threads.get({ threadId: id });
      return thread.archivedAt || thread.deletedAt ? "dead" : "ok";
    } catch (cause) {
      return threadGone(cause) ? "dead" : "unknown";
    }
  };
  /**
   * The thread a run should continue, or null to start a fresh one. The settings-pinned thread
   * wins over the cached one, but either may have gone stale, so each is probed. `prune` drops a
   * dead cached id from storage — only the run path does that; a panel refresh must not mutate
   * state, and an inconclusive probe leaves the id alone so a flaky call cannot churn threads.
   */
  /**
   * Panel snapshots probe every run thread, and the panel refetches on each store write, so a
   * capture run would otherwise cost several thread lookups per item it writes. Snapshots reuse a
   * probe for PROBE_TTL_MS; the run path always probes fresh before it sends.
   */
  const probeCache = new Map<string, { at: number; state: "ok" | "dead" | "unknown" }>();
  const probe = async (id: string, fresh: boolean) => {
    const hit = probeCache.get(id);
    if (!fresh && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.state;
    const state = await probeRunThread(id);
    probeCache.set(id, { at: Date.now(), state });
    return state;
  };
  const resolveRunThread = async (name: RunName, { prune = false } = {}): Promise<string | null> => {
    const pinned = config.threads[name];
    if (pinned && (await probe(pinned, prune)) !== "dead") return pinned;
    const cached = await storedRunThread(name);
    if (!cached) return null;
    const state = await probe(cached, prune);
    if (state !== "dead") return cached;
    if (!prune) return null;
    bb.log.warn(`${name} run thread ${cached} is archived or gone; starting a new one`);
    await forgetRunThread(name);
    return null;
  };

  async function loadAutomations(): Promise<Automation[]> {
    return Promise.all(
      RUN_NAMES.map(async (run) => {
        // Empty while capture lives on the iPhone, so the run menu reports no schedule.
        const cron = config.captureOnMac ? config.cron[run] : "";
        // Only the cron registered at load can fire; a changed one waits for `bb plugin reload`.
        const paused = (await bb.storage.kv.get<boolean>(pausedKey(run))) === true;
        // A schedule changed in settings waits for reload — but only where a schedule exists at all.
        const pendingReload = config.captureOnMac && cron !== loadedCron[run];
        const enabled = !paused && cron !== "" && !pendingReload;
        return {
          run, label: RUN_LABEL[run], threadId: await resolveRunThread(run), schedule: cron || null, enabled, paused, pendingReload,
          nextRunAt: enabled ? nextCronRun(cron)?.toISOString() ?? null : null,
        };
      }),
    );
  }

  const execution = () => ({
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoningLevel ? { reasoningLevel: config.reasoningLevel } : {}),
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
  });

  /** Send a run's prompt to its thread (created on first run). Queues behind a turn already in progress. */
  const runStarting = new Set<RunName>();
  /**
   * A run thread is hidden from bb's thread list. It stays alive and sendable —
   * hidden is not archived, and archiving is exactly what wedged runs before.
   */
  const RUN_THREAD_VISIBILITY = "hidden" as const;
  /**
   * Hide a run thread that predates this default, so an upgraded install does not
   * keep one visible Third Hand row per run. Best-effort: a refusal must not fail a run.
   */
  const hideRunThread = async (name: RunName, threadId: string) => {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.visibility === RUN_THREAD_VISIBILITY) return;
      await bb.sdk.threads.update({ threadId, visibility: RUN_THREAD_VISIBILITY });
      bb.log.info(`${name} run thread ${threadId} is now hidden`);
    } catch (error) {
      bb.log.warn(`could not hide ${name} run thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  /** A 409 from a send that means the thread itself is unusable, not a transient conflict. */
  const deadThread = (cause: unknown) => /thread is archived|environment is unavailable|thread not found/i.test(cause instanceof Error ? cause.message : String(cause));
  async function startRun(name: RunName, trigger: "schedule" | "manual"): Promise<string> {
    if (!config.projectId) throw new Error("Choose a project in Third Hand settings first");
    const stamp = new Date().toLocaleString("en-US", { timeZone: config.timeZone, dateStyle: "medium", timeStyle: "short" });
    const text = `[Third Hand ${trigger === "manual" ? "manual" : "scheduled"} ${name} run · ${stamp}]\n\n${runPrompt(name, promptContext())}`;
    const existing = await resolveRunThread(name, { prune: true });
    if (existing) {
      const sources = Object.fromEntries(Object.keys(execution()).map((k) => [k, "explicit"]));
      try {
        await bb.sdk.threads.send({
          threadId: existing, mode: "queue-if-active",
          input: [{ type: "text", mentions: [], text }],
          ...execution(),
          ...(Object.keys(sources).length ? { executionInputSources: sources } : {}),
        });
        bb.log.info(`${trigger} ${name} run → ${existing}`);
        void hideRunThread(name, existing);
        return existing;
      } catch (cause) {
        // The thread died between the probe above and this send (archived, deleted, or its
        // environment reclaimed). Retrying the same id can only fail again, so drop it and
        // spawn a replacement — otherwise this schedule stays wedged until a human intervenes.
        if (!deadThread(cause)) throw cause;
        bb.log.warn(`${name} run thread ${existing} became unusable (${cause instanceof Error ? cause.message : String(cause)}); starting a new one`);
        await forgetRunThread(name);
      }
    }
    if (runStarting.has(name)) throw new Error(`The ${name} thread is already being created`);
    runStarting.add(name);
    try {
      const sectionId = await sectionIdFor();
      const thread = await bb.sdk.threads.spawn({
        projectId: config.projectId,
        ...(sectionId ? { sectionId } : {}),
        environment: { type: "project-default" },
        title: `Third Hand ${RUN_LABEL[name]}`,
        prompt: text,
        visibility: RUN_THREAD_VISIBILITY,
        ...execution(),
        pluginMetadata: { thirdhandRun: name },
      });
      await rememberRunThread(name, thread.id);
      bb.log.info(`${trigger} ${name} run → new thread ${thread.id}`);
      publish();
      return thread.id;
    } finally {
      runStarting.delete(name);
    }
  }

  // Legacy schedules. iOS captures now, so `captureRuns: "iphone"` (the default)
  // registers nothing. The code stays behind this gate rather than being deleted.
  for (const run of RUN_NAMES) {
    const cron = config.captureOnMac ? config.cron[run] : "";
    if (!cron) continue;
    try {
      bb.background.schedule(`run-${run}`, cron, async () => {
        // The SDK can't unschedule, so a cron changed or cleared in settings leaves this job
        // registered until reload. Skip it rather than run on a cadence the user turned off.
        if (!config.captureOnMac || config.cron[run] !== cron) return;
        if ((await bb.storage.kv.get<boolean>(pausedKey(run))) === true) return;
        await startRun(run, "schedule");
      });
    } catch (error) {
      bb.log.warn(`schedule ${run} ("${cron}"): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- The mirror: the panel's only item source ----
  let current: MirrorRead = mirror.readSnapshot({ dir: config.mirrorDir });

  function lastRunsFrom(runs: ThirdHandRun[]): Record<string, ThirdHandRun> {
    const out: Record<string, ThirdHandRun> = {};
    for (const run of runs) out[run.run] = run;
    return out;
  }

  async function fullSnapshot(): Promise<ThirdHandSnapshot> {
    // A panel fetch is also an opportunity to catch a snapshot change the watcher
    // missed, so the next render is never stale by a whole interval.
    refreshMirror();
    const read = current;
    let actionRecords: Record<string, NonNullable<ThirdHandItem["action"]>> = {};
    try {
      actionRecords = panel.actionsByItem(actions.actionEntries(home));
    } catch (error) {
      bb.log.warn(`could not read agent actions: ${error instanceof Error ? error.message : String(error)}`);
    }
    let pendingRows: unknown[] = [];
    try {
      pendingRows = commands.readPending(config.mirrorDir);
    } catch (error) {
      bb.log.warn(`could not read pending commands: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Items keep their snapshot status and gain a "Sent to iPhone" marker; the
    // iPhone owns content, so the panel never flips a status it only requested.
    const items = panel.projectItems(read.items, {
      actions: actionRecords,
      pending: panel.pendingByItem(pendingRows),
      skillsFor: skillsForItem,
    });
    return {
      home: read.dir,
      generatedAt: read.generatedAt ?? new Date().toISOString(),
      lastViewedAt: read.lastViewedAt,
      items,
      lastRuns: lastRunsFrom(read.runs),
      recentRuns: read.runs.slice(-12).reverse(),
      draft: read.draft,
      automations: await loadAutomations(),
      parentThreadId: null,
      needsProject: !config.projectId,
      mirror: {
        state: read.state,
        dir: read.dir,
        file: read.file,
        schemaVersion: read.schemaVersion,
        generatedAt: read.generatedAt,
        deviceName: read.deviceName,
        message: read.message,
        pendingCount: pendingRows.length,
      },
    };
  }

  // Live updates: reload only when the snapshot's identity moves.
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => bb.realtime.publish(CHANGED, { at: new Date().toISOString() }), 250);
  };
  const poller = mirror.createMirrorPoller({
    dir: config.mirrorDir,
    onChange: (result) => {
      const previous = current;
      current = result;
      if (result.state !== "connected" && previous.state !== result.state) {
        bb.log.info(`thirdhand mirror: ${result.state}${result.message ? ` (${result.message})` : ""}`);
      }
      // The app acknowledged commands: drop them from the pending set, and compact
      // the log when it has grown or every line is acked.
      try {
        const dropped = commands.dropAcked({ dir: config.mirrorDir });
        if (dropped.removed) bb.log.info(`thirdhand mirror: ${dropped.removed} command(s) acked${dropped.compacted ? ", log compacted" : ""}`);
      } catch (error) {
        bb.log.warn(`could not prune acked commands: ${error instanceof Error ? error.message : String(error)}`);
      }
      publish();
    },
  });
  // Seed the poller's identity so the first interval tick does not re-publish.
  poller.poll();

  /** Re-read the snapshot, updating `current` only if its identity changed. */
  const refreshMirror = () => {
    try {
      poller.poll();
    } catch (error) {
      bb.log.warn(`thirdhand mirror read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let watcher: fs.FSWatcher | undefined;
  const watchMirror = () => {
    try {
      watcher = fs.watch(config.mirrorDir, (_event, file) => {
        const name = file ? path.basename(String(file)) : "";
        // This plugin writes the command log itself; only the snapshot and the
        // app's ack file can change what the panel renders.
        if (name && name !== "snapshot.json" && name !== "commands.ack.jsonl") return;
        poller.poll();
      });
    } catch (error) {
      // No mirror directory yet is the normal first-run state: the interval poll
      // picks the snapshot up as soon as the iPhone writes it.
      bb.log.info(`thirdhand mirror not watchable yet (${config.mirrorDir}): ${error instanceof Error ? error.message : String(error)}`);
      watcher = undefined;
    }
  };
  watchMirror();
  const pollTimer = setInterval(() => {
    if (!watcher) watchMirror();
    refreshMirror();
  }, MIRROR_POLL_MS);

  bb.rpc.register(rpcContract, {
    thirdhand_snapshot: () => fullSnapshot(),
    thirdhand_action: async ({ id, action, until }) => {
      // The plugin only asserts transitions; iOS applies them and republishes.
      const result = commands.enqueue({ op: action, itemId: id, until: until ?? null, reason: null }, { dir: config.mirrorDir });
      if (result.queued) bb.log.info(`thirdhand command ${action} ${id} → ${config.mirrorDir}`);
      return fullSnapshot();
    },
    // The iPhone owns lastViewedAt and there is no command for it, so "mark all
    // seen" only clears the panel's own New markers. Nothing is written.
    thirdhand_seen: async () => fullSnapshot(),
    thirdhand_run_now: async ({ run: name }) => ({ threadId: await startRun(name, "manual") }),
    thirdhand_set_run_enabled: async ({ run: name, enabled }) => {
      await bb.storage.kv.set(pausedKey(name), !enabled);
      publish();
      return fullSnapshot();
    },
    thirdhand_start_action: async ({ id }) => {
      const threadId = await startAction(id);
      return { threadId, snapshot: await fullSnapshot() };
    },
    thirdhand_action_seen: async ({ id }) => {
      actions.markActionSeen(home, id);
      return fullSnapshot();
    },
  });

  // ---- Agent actions ----
  const starting = new Set<string>();
  async function startAction(id: string): Promise<string> {
    // Look the item up in the live snapshot, not the legacy store: the iPhone is
    // the only place item content lives now.
    refreshMirror();
    const item = current.items.find((i) => i.id === id);
    if (!item) throw new Error(`No item ${id} in the current snapshot`);
    const existing = actions.actionEntries(home).find(([itemId]) => itemId === id)?.[1];
    if (existing?.status === "running") return existing.threadId;
    if (starting.has(id)) throw new Error("An action for this item is already starting");
    starting.add(id);
    try {
      if (!config.projectId) throw new Error("Choose a project in Third Hand settings first");
      const sectionId = await sectionIdFor();
      const thread = await bb.sdk.threads.spawn({
        projectId: config.projectId,
        ...(sectionId ? { sectionId } : {}),
        environment: { type: "project-default" },
        title: item.title.slice(0, 120),
        prompt: actionPrompt(item, { user: config.user, sources: config.sources, timeZone: config.timeZone, skills: skillsForItem(item) }),
        pluginMetadata: { thirdhandItemId: id },
      });
      try {
        // The item must still be in the snapshot: if the app republished without it
        // while the thread spawned, the record would point at nothing and the
        // thread would work unseen.
        refreshMirror();
        if (!current.items.some((i) => i.id === id)) throw new Error(`item ${id} left the snapshot while its thread started`);
        actions.startAction(home, id, { threadId: thread.id });
      } catch (error) {
        // Unrecorded, the thread would work unseen and the next click would spawn a second one.
        bb.log.warn(`action ${id}: could not record thread ${thread.id}; stopping and archiving it`);
        await bb.sdk.threads.stop({ threadId: thread.id }).catch(() => undefined);
        await bb.sdk.threads.archive({ threadId: thread.id }).catch((e) => bb.log.warn(`archive ${thread.id}: ${e instanceof Error ? e.message : String(e)}`));
        throw new Error(`Couldn't record the agent thread, so it was stopped: ${error instanceof Error ? error.message : String(error)}`);
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
      bb.log.warn(`section "${name}" unavailable: ${error instanceof Error ? error.message : String(error)}`);
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
      bb.log.warn(`push-notifications level for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const itemForThread = (threadId: string) => actions.actionEntries(home).find(([, a]) => a.threadId === threadId);
  const settle = (threadId: string, status: ActionStatus, summary?: string | null) => {
    const entry = itemForThread(threadId);
    if (!entry) return;
    const [itemId, action] = entry;
    if (action.status === status) return;
    actions.setActionStatus(home, itemId, status, { threadId, summary });
    bb.log.info(`action ${itemId} (${threadId}) → ${status}`);
    publish();
  };
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => settle(thread.id, "ready", readySummary(lastAssistantText)));
  bb.events.on("thread.failed", ({ thread, error }) => settle(thread.id, "failed", error ?? "Thread stopped on an error"));
  bb.events.on("thread.active", ({ thread }) => settle(thread.id, "running"));

  // Safety net for events missed while the plugin was reloading: reconcile running actions.
  async function reconcile() {
    for (const [, action] of actions.actionEntries(home, "running")) {
      const threadId = action.threadId;
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
        else bb.log.warn(`reconcile ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  bb.background.service("action-reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        await reconcile();
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, RECONCILE_MS);
          signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
    },
  });

  bb.onDispose(async () => {
    watcher?.close();
    clearInterval(pollTimer);
    if (publishTimer) clearTimeout(publishTimer);
  });
}
