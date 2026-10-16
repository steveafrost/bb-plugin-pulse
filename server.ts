/**
 * bb-plugin-pulse — server.
 *
 * Reads the Pulse item store (lib/store.mjs, the same module the `pulse` CLI
 * uses), watches its directory and pushes a realtime signal so the panel stays
 * live while runs write. The user's actions (done / dismiss / snooze / reopen)
 * go through the store's user path, so the next run respects them.
 *
 * Pulse owns its capture runs: plugin schedules send the prompts in
 * lib/prompts.ts to one thread per run (created on first run). Run now calls
 * the same function. Everything personal lives in the plugin settings.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
// @ts-ignore -- plain ESM module shared with the CLI
import * as storeModule from "./lib/store.mjs";
import { nextCronRun } from "./lib/cron";
import { DEFAULT_SOURCES, runPrompt, type PromptContext, type RunName } from "./lib/prompts";
import { parseSkillRules, skillsFor, type SkillRef, type SkillRule } from "./lib/skills";
import type { ActionStatus, Automation, ItemAction, PulseItem, PulseSnapshot } from "./types";

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
};

const CHANGED = "pulse-changed";
const RUN_NAMES: RunName[] = ["hourly", "daily", "weekly"];
const RUN_LABEL: Record<RunName, string> = { hourly: "Hourly", daily: "Daily", weekly: "Weekly" };
const DEFAULT_CRON: Record<RunName, string> = { hourly: "0 */2 * * *", daily: "0 16 * * *", weekly: "0 15 * * 5" };
const STATUS_FOR: Record<ItemAction, string> = { done: "done", dismiss: "dismissed", snooze: "snoozed", reopen: "open" };
const RECONCILE_MS = 2 * 60_000;
/** Plugin root (server runs from dist/server.js or ./server.ts). */
const ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist" ? path.dirname(here) : here;
})();

const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface ActionContext { user: string; sources: string; timeZone: string; skills: SkillRef[] }

/** The prompt an action thread starts with: the item's full context plus hard no-send rules. */
export function actionPrompt(item: PulseItem, c: ActionContext): string {
  const { user: u, skills } = c;
  const fmtTime = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-US", { timeZone: c.timeZone, dateStyle: "medium", timeStyle: "short" }) : "none";
  const history = (item.history ?? []).slice(-15)
    .map((h) => `- ${fmtTime(h.at)} · ${h.by}: ${h.change}${h.until ? ` until ${fmtTime(h.until)}` : ""}${h.reason ? ` (${h.reason})` : ""}`)
    .join("\n") || "- (none)";
  return [
    `${u} clicked "Start agent thread" on this Pulse item. Do the work ${u} would otherwise do, up to the point where ${u} only has to review and send.`,
    "",
    "## Item",
    `- Title: ${item.title}`,
    `- Detail: ${item.detail || "(none)"}`,
    `- Kind: ${item.kind} · Source: ${item.source} · Priority: ${item.priority} · Status: ${item.status}`,
    `- Link: ${item.url ?? "(none)"}`,
    `- People: ${item.people.length ? item.people.join(", ") : "(none)"}`,
    `- Due: ${fmtTime(item.due)}`,
    `- Pulse id: ${item.id} (first seen ${fmtTime(item.firstSeenAt)})`,
    "",
    "## History",
    history,
    "",
    "## Skills",
    ...(skills.length
      ? ["Read each of these SKILL.md files before starting and follow them:", ...skills.map((k) => `- ${k.name} (${k.why}): ${k.path}`)]
      : ["- None preselected."]),
    "- If the work turns out to need another installed skill, load it too.",
    "",
    "## How to work",
    "- Read the source first (the link above) so you have the full ask, then gather what the work needs.",
    `- Reaching sources: ${c.sources.trim()}`,
    `- Example: for "send X a weekly sync of what I did", gather the last week of ${u}'s work from Slack, Gmail, Calendar and code hosting, then draft the update here.`,
    "- If the item is marked TEST, do exactly what its detail says and nothing else; use no tools.",
    "",
    "## Hard rules",
    "- NEVER send messages or emails, and never post, comment, react, or reply anywhere.",
    "- NEVER create Slack or Gmail drafts, calendar events, or any other artifact in an external system.",
    "- Do not change Pulse item state (no `pulse done/dismiss/snooze`).",
    `- The result is a draft or answer in THIS thread for ${u} to review. If something blocks you, say what and stop.`,
    "",
    `End your final message with one line: \`Ready: <one-line summary of what is ready for ${u}>\`.`,
  ].join("\n");
}

/** The thread's closing "Ready: …" line, else the first line of its last message. */
function readySummary(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^[*_`>\s]*Ready:?[*_`]*\s*(.+?)[*_`]*$/i.exec(lines[i]!);
    if (m) return m[1]!.slice(0, 240);
  }
  return lines[0] ? lines[0].slice(0, 240) : null;
}

export const rpcContract = defineRpcContract({
  pulse_snapshot: { input: z.null(), output: z.any() },
  pulse_action: {
    input: z.object({
      id: z.string().min(3).max(400),
      action: z.enum(["done", "dismiss", "snooze", "reopen"]),
      until: z.string().datetime().optional(),
    }),
    output: z.any(),
  },
  pulse_seen: { input: z.null(), output: z.any() },
  pulse_run_now: { input: z.object({ run: z.enum(["hourly", "daily", "weekly"]) }), output: z.object({ threadId: z.string() }) },
  pulse_set_run_enabled: { input: z.object({ run: z.enum(["hourly", "daily", "weekly"]), enabled: z.boolean() }), output: z.any() },
  pulse_start_action: { input: z.object({ id: z.string().min(3).max(400) }), output: z.any() },
  pulse_action_seen: { input: z.object({ id: z.string().min(3).max(400) }), output: z.any() },
});

export default async function plugin(bb: BbPluginApi) {
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
    model: { type: "string", label: "Model for capture runs (empty = thread default)", default: "" },
    reasoningLevel: { type: "select", label: "Reasoning level for capture runs", options: ["default", "low", "medium", "high"], experimental_optionLabels: { default: "Thread default" }, default: "default" },
    permissionMode: {
      type: "select", label: "Permission mode for capture runs", options: ["default", "accept-edits", "auto", "full"],
      experimental_optionLabels: { default: "Thread default" }, default: "default",
      description: "Runs call the Pulse CLI from a shell, so they need permission to run commands.",
    },
    hourlyCron: { type: "string", label: "Hourly schedule (cron, server time; empty = off)", default: DEFAULT_CRON.hourly },
    dailyCron: { type: "string", label: "Daily schedule (cron, server time; empty = off)", default: DEFAULT_CRON.daily },
    weeklyCron: { type: "string", label: "Weekly schedule (cron, server time; empty = off)", default: DEFAULT_CRON.weekly },
    section: { type: "string", label: "Sidebar section for Pulse threads (created if missing; empty = none)", default: "Pulse" },
    timeZone: { type: "string", label: "Time zone (IANA; empty = server time zone)", default: "" },
    storeDir: { type: "string", label: "Store directory (empty = $PULSE_HOME or ~/.config/pulse)", default: "" },
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
      home: v.storeDir.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~") || store.pulseHome(),
      threads: { hourly: v.hourlyThread.trim(), daily: v.dailyThread.trim(), weekly: v.weeklyThread.trim() } as Record<RunName, string>,
    };
  };
  let config = readConfig(await settings.get());
  const home = config.home;
  settings.onChange((next) => {
    const prev = config;
    config = readConfig(next);
    if (config.home !== prev.home || RUN_NAMES.some((r) => config.cron[r] !== prev.cron[r])) {
      bb.log.info("store directory or schedules changed; run `bb plugin reload` to apply");
    }
    publish();
  });
  fs.mkdirSync(home, { recursive: true });
  if (!config.projectId) bb.status.needsConfiguration("Choose a project in Pulse settings, then reload the plugin.");

  const cliCommand = () => `PULSE_HOME=${shellQuote(home)} node ${shellQuote(path.join(ROOT, "bin/pulse.mjs"))}`;
  const promptContext = (): PromptContext => ({
    cli: cliCommand(), user: config.user, timeZone: config.timeZone, memoryDir: path.join(home, "memory"),
    sources: config.sources, instructions: config.instructions,
  });
  const skillsForItem = (item: PulseItem) => skillsFor(item, config.skillRules);

  // ---- Capture runs (plugin-owned schedules) ----
  const pausedKey = (name: RunName) => `paused:${name}`;
  const threadKey = (name: RunName) => `thread:${name}`;
  const runThreadId = async (name: RunName) => config.threads[name] || (await bb.storage.kv.get<string>(threadKey(name))) || null;

  async function loadAutomations(): Promise<Automation[]> {
    return Promise.all(
      RUN_NAMES.map(async (run) => {
        const cron = config.cron[run];
        const enabled = (await bb.storage.kv.get<boolean>(pausedKey(run))) !== true && cron !== "";
        return { run, label: RUN_LABEL[run], threadId: await runThreadId(run), schedule: cron || null, enabled, nextRunAt: enabled ? nextCronRun(cron)?.toISOString() ?? null : null };
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
  async function startRun(name: RunName, trigger: "schedule" | "manual"): Promise<string> {
    if (!config.projectId) throw new Error("Choose a project in Pulse settings first");
    const stamp = new Date().toLocaleString("en-US", { timeZone: config.timeZone, dateStyle: "medium", timeStyle: "short" });
    const text = `[Pulse ${trigger === "manual" ? "manual" : "scheduled"} ${name} run · ${stamp}]\n\n${runPrompt(name, promptContext())}`;
    const existing = await runThreadId(name);
    if (existing) {
      const sources = Object.fromEntries(Object.keys(execution()).map((k) => [k, "explicit"]));
      await bb.sdk.threads.send({
        threadId: existing, mode: "queue-if-active",
        input: [{ type: "text", mentions: [], text }],
        ...execution(),
        ...(Object.keys(sources).length ? { executionInputSources: sources } : {}),
      });
      bb.log.info(`${trigger} ${name} run → ${existing}`);
      return existing;
    }
    if (runStarting.has(name)) throw new Error(`The ${name} thread is already being created`);
    runStarting.add(name);
    try {
      const sectionId = await sectionIdFor();
      const thread = await bb.sdk.threads.spawn({
        projectId: config.projectId,
        ...(sectionId ? { sectionId } : {}),
        environment: { type: "project-default" },
        title: `Pulse ${RUN_LABEL[name]}`,
        prompt: text,
        ...execution(),
        pluginMetadata: { pulseRun: name },
      });
      await bb.storage.kv.set(threadKey(name), thread.id);
      bb.log.info(`${trigger} ${name} run → new thread ${thread.id}`);
      publish();
      return thread.id;
    } finally {
      runStarting.delete(name);
    }
  }

  for (const run of RUN_NAMES) {
    const cron = config.cron[run];
    if (!cron) continue;
    try {
      bb.background.schedule(`run-${run}`, cron, async () => {
        if ((await bb.storage.kv.get<boolean>(pausedKey(run))) === true) return;
        await startRun(run, "schedule");
      });
    } catch (error) {
      bb.log.warn(`schedule ${run} ("${cron}"): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function fullSnapshot(): Promise<PulseSnapshot> {
    const snap = store.snapshot(home);
    // Tell the panel which skills an agent thread would load, for the robot button's tooltip.
    const items = snap.items.map((i) => (i.status === "open" || i.status === "waiting" ? { ...i, agentSkills: skillsForItem(i).map((k) => k.name) } : i));
    return { ...snap, items, automations: await loadAutomations(), parentThreadId: null, needsProject: !config.projectId };
  }

  // Live updates: any write to the store dir (CLI or panel) nudges the panel.
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => bb.realtime.publish(CHANGED, { at: new Date().toISOString() }), 250);
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(home, { recursive: true }, (_event, file) => {
      if (file && (String(file).endsWith(".tmp") || String(file).startsWith(".lock"))) return;
      publish();
    });
  } catch (error) {
    bb.log.warn(`cannot watch ${home}: ${error instanceof Error ? error.message : String(error)}`);
  }

  bb.rpc.register(rpcContract, {
    pulse_snapshot: () => fullSnapshot(),
    pulse_action: async ({ id, action, until }) => {
      store.userAction(id, STATUS_FOR[action], { until, by: "user" }, home);
      return fullSnapshot();
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

  // ---- Agent actions ----
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
        prompt: actionPrompt(item, { user: config.user, sources: config.sources, timeZone: config.timeZone, skills: skillsForItem(item) }),
        pluginMetadata: { pulseItemId: id },
      });
      store.startAction(id, { threadId: thread.id, by: "user" }, home);
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

  const itemForThread = (threadId: string) => store.actionItems(null, home).find((i) => i.action?.threadId === threadId);
  const settle = (threadId: string, status: ActionStatus, summary?: string | null) => {
    const item = itemForThread(threadId);
    if (!item || item.action?.status === status) return;
    store.setActionStatus(item.id, status, { threadId, summary, by: "pulse" }, home);
    bb.log.info(`action ${item.id} (${threadId}) → ${status}`);
    publish();
  };
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => settle(thread.id, "ready", readySummary(lastAssistantText)));
  bb.events.on("thread.failed", ({ thread, error }) => settle(thread.id, "failed", error ?? "Thread stopped on an error"));
  bb.events.on("thread.active", ({ thread }) => settle(thread.id, "running"));

  // Safety net for events missed while the plugin was reloading: reconcile running actions.
  async function reconcile() {
    for (const item of store.actionItems("running", home)) {
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
        bb.log.warn(`reconcile ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
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
    if (publishTimer) clearTimeout(publishTimer);
  });
}
