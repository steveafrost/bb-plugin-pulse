// Shapes produced by lib/store.mjs, shared by server.ts and app.tsx.

export type Source = "slack" | "gmail" | "calendar" | "github" | "docs" | "other";
export type Kind = "reply" | "decision" | "rsvp" | "conflict" | "deadline" | "review" | "followup" | "fyi";
export type Status = "open" | "waiting" | "snoozed" | "resolved" | "done" | "dismissed";
export type Priority = "high" | "normal" | "low";

export interface PulseItem {
  id: string;
  source: Source;
  kind: Kind;
  title: string;
  detail: string;
  url: string | null;
  due: string | null;
  priority: Priority;
  people: string[];
  status: Status;
  snoozedUntil: string | null;
  resolution: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  lastChangedBy: string;
  history?: PulseHistoryEntry[];
  /** One-click helpers written by the capture runs: copy prepared text and/or open a link. */
  quickActions?: QuickAction[];
  /** Server-computed: skills an agent thread for this item would load (open/waiting items only). */
  agentSkills?: string[];
  /** Set when the user handed the item to an agent thread from the panel. */
  action?: PulseItemAction | null;
}

export interface QuickAction {
  label: string;
  /** Copied to the clipboard on click (e.g. a reminder or decline note). */
  text?: string;
  /** Opened on click; falls back to the item's url when only text is given. */
  url?: string;
}

export type ActionStatus = "running" | "ready" | "failed";

export interface PulseItemAction {
  threadId: string;
  status: ActionStatus;
  startedAt: string;
  finishedAt: string | null;
  /** The thread's closing "Ready: …" line (or failure message). */
  summary: string | null;
  /** When the user opened the finished thread from the panel; null = unread. */
  seenAt: string | null;
}

export interface PulseHistoryEntry {
  at: string;
  by: string;
  change: string;
  reason?: string;
  until?: string;
}

export interface PulseRun {
  run: string;
  startedAt: string | null;
  finishedAt: string;
  /** When the previous run with this name finished, from the full history. */
  previousFinishedAt?: string | null;
  summary: string;
  thread: string | null;
  sources: string[];
  errors: string[];
  /** Server-computed over every item: ids this run created and resolved (snapshot.recentRuns only). */
  added?: string[];
  resolved?: string[];
}

/** A torn items.json / state.json was read from its .bak copy. */
export interface PulseRecovery {
  file: string;
  at: string;
  error: string;
}

export interface Automation {
  run: string;
  label: string;
  /** Null until the first run creates the thread. */
  threadId: string | null;
  schedule: string | null;
  nextRunAt: string | null;
  enabled: boolean | null;
  /** Paused from the panel (kv flag), independent of the schedule setting. */
  paused?: boolean;
  /** The schedule setting changed since load; only `bb plugin reload` applies it. */
  pendingReload?: boolean;
  /** bb refused the loaded cron, so nothing runs (the reason bb gave). */
  scheduleError?: string | null;
  /** The changed, not yet loaded cron will be refused on reload (why). */
  pendingError?: string | null;
  /** The latest failure since this run's last logged run, if any. */
  failure?: RunFailure | null;
  /** A prompt was sent more than 45 minutes ago and no run has logged since. */
  overdue?: boolean;
  lastDispatchAt?: string | null;
  /** The "Existing thread for … runs" setting: null when empty; dead = archived/gone; skipped = its send failed for good. */
  /** `shared`: another run already pins that thread, so this run uses its own. */
  pinState?: "ok" | "dead" | "skipped" | "shared" | null;
}

/** A prompt Pulse sent to a run thread. */
export interface RunDispatch {
  at: string;
  threadId: string;
  trigger: "schedule" | "manual" | "catch-up";
}

export interface RunFailure {
  at: string;
  error: string;
  threadId: string | null;
  /** When the one automatic retry is due. */
  retryAt?: string;
}

/** A dispatched run that never logged: its turn died, or a later prompt superseded it. */
export interface MissedRun extends RunDispatch {
  run: string;
  label: string;
}

export interface PulseSnapshot {
  home: string;
  generatedAt: string;
  lastViewedAt: string | null;
  items: PulseItem[];
  lastRuns: Record<string, PulseRun>;
  recentRuns: PulseRun[];
  /** Titles for Run Log ids that are no longer on the board (closed more than 3 days ago). */
  runItems?: Record<string, { id: string; title: string; status: Status }>;
  recovered?: PulseRecovery | null;
  automations: Automation[];
  /** Newest first, last 3 days. */
  missedRuns?: MissedRun[];
  parentThreadId: string | null;
  /** No project is set in the plugin settings yet. */
  needsProject?: boolean;
  /** Loaded without a project and one was set since: runs work, bb may still list "needs configuration". */
  projectSetLive?: boolean;
  /** The store directory setting changed; the panel keeps showing the loaded store until reload. */
  homePending?: boolean;
}

export type ItemAction = "done" | "dismiss" | "snooze" | "reopen";
