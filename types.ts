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
}

export interface PulseDraft {
  kind: string;
  date: string;
  file: string;
  body: string;
  modifiedAt: string;
}

export interface Automation {
  run: string;
  label: string;
  /** Null until the first run creates the thread. */
  threadId: string | null;
  schedule: string | null;
  nextRunAt: string | null;
  enabled: boolean | null;
}

export interface PulseSnapshot {
  home: string;
  generatedAt: string;
  lastViewedAt: string | null;
  items: PulseItem[];
  lastRuns: Record<string, PulseRun>;
  recentRuns: PulseRun[];
  draft: PulseDraft | null;
  automations: Automation[];
  parentThreadId: string | null;
  /** No project is set in the plugin settings yet. */
  needsProject?: boolean;
}

export type ItemAction = "done" | "dismiss" | "snooze" | "reopen";
