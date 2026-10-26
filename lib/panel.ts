/**
 * Panel logic with no React or bb in it, so it can be tested: how the board reads a snapshot
 * (expired snoozes, optimistic overlays, stale snapshots), counts, run health and snooze choices.
 */
import type { Automation, MissedRun, PulseItem, PulseRun, PulseSnapshot } from "../types";

/** An expired snooze is open, whether or not the server has written that yet. */
export function effectiveItem<T extends Pick<PulseItem, "status" | "snoozedUntil">>(item: T, now = Date.now()): T {
  if (item.status === "snoozed" && item.snoozedUntil && Date.parse(item.snoozedUntil) <= now) return { ...item, status: "open", snoozedUntil: null };
  return item;
}

/** On the board (open, waiting or snoozed), as opposed to closed. */
export const isActive = (i: Pick<PulseItem, "status">) => i.status === "open" || i.status === "waiting" || i.status === "snoozed";

/** Apply optimistic changes (a click not yet confirmed by the server) on top of the snapshot. */
export function withOverlay(items: PulseItem[], overlay: Record<string, Partial<PulseItem>>): PulseItem[] {
  return items.map((i) => (overlay[i.id] ? { ...i, ...overlay[i.id] } : i));
}

/**
 * Whether `next` may replace the snapshot on screen. Responses can arrive out of order (a slow
 * refetch started before a click lands after the click's own response), and the store stamps
 * `generatedAt` when it reads the files, so an older read never overwrites a newer one.
 */
export function isNewer(current: Pick<PulseSnapshot, "generatedAt"> | null, next: Pick<PulseSnapshot, "generatedAt"> | null | undefined): boolean {
  if (!next) return false;
  if (!current) return true;
  return next.generatedAt >= current.generatedAt;
}

export function isNew(item: PulseItem, lastViewedAt: string | null): boolean {
  if (!lastViewedAt) return true;
  return item.lastChangedBy !== "user" && item.updatedAt > lastViewedAt;
}

/** Filter-chip counts and badges, over every item the board shows (snoozed ones too). */
export function boardSummary(items: PulseItem[], seenRef: string | null) {
  const counts: Record<string, number> = { all: 0 };
  for (const i of items) if (isActive(i)) { counts.all!++; counts[i.source] = (counts[i.source] ?? 0) + 1; }
  return {
    counts,
    fresh: items.filter((i) => (i.status === "open" || i.status === "waiting") && isNew(i, seenRef)).length,
    // Closed items render no action chip, so their unread action could never be cleared.
    ready: items.filter((i) => isActive(i) && i.action?.status === "ready" && !i.action.seenAt).length,
    working: items.filter((i) => i.action?.status === "running").length,
  };
}

/** A later run that read sources with no errors: it shows an earlier failure is behind us. */
export function fixedLater(run: PulseRun, runs: PulseRun[]): PulseRun | undefined {
  return runs.find((r) => r.finishedAt > run.finishedAt && r.errors.length === 0 && r.sources.length > 0);
}

export type RunProblem =
  | { kind: "schedule"; label: string; error: string }
  | { kind: "failed"; label: string; at: string; error: string; retryAt?: string }
  | { kind: "overdue"; label: string; at: string }
  | { kind: "errors"; label: string; at: string; count: number; run: PulseRun };

/**
 * The one problem worth a warning in the title bar, named by run and age, or null. A run's errors
 * stop counting once a later run reads sources cleanly, so an old Daily failure doesn't keep the
 * board looking broken all day.
 */
export function runProblem(snapshot: Pick<PulseSnapshot, "recentRuns" | "automations">): RunProblem | null {
  for (const a of snapshot.automations) {
    if (a.scheduleError) return { kind: "schedule", label: a.label, error: a.scheduleError };
  }
  const failed = snapshot.automations.filter((a) => a.failure).sort((a, b) => (a.failure!.at < b.failure!.at ? 1 : -1))[0];
  if (failed?.failure) return { kind: "failed", label: failed.label, at: failed.failure.at, error: failed.failure.error, ...(failed.failure.retryAt ? { retryAt: failed.failure.retryAt } : {}) };
  const overdue = snapshot.automations.find((a) => a.overdue && a.lastDispatchAt);
  if (overdue) return { kind: "overdue", label: overdue.label, at: overdue.lastDispatchAt! };
  const runs = snapshot.recentRuns;
  const bad = runs.find((r) => r.errors.length > 0);
  if (bad && !fixedLater(bad, runs)) {
    const label = snapshot.automations.find((a) => a.run === bad.run)?.label ?? bad.run;
    return { kind: "errors", label, at: bad.finishedAt, count: bad.errors.length, run: bad };
  }
  return null;
}

/** Run Log rows: logged runs and runs that were sent but never logged, newest first. */
export type LogRow = { kind: "run"; key: string; at: string; run: PulseRun } | { kind: "missed"; key: string; at: string; missed: MissedRun };
export function logRows(runs: PulseRun[], missed: MissedRun[] = [], { errorsOnly = false } = {}): LogRow[] {
  const rows: LogRow[] = [
    ...runs.filter((r) => !errorsOnly || r.errors.length > 0 || r.sources.length === 0).map((r) => ({ kind: "run" as const, key: `${r.run}-${r.finishedAt}`, at: r.finishedAt, run: r })),
    ...missed.map((m) => ({ kind: "missed" as const, key: `missed-${m.run}-${m.at}`, at: m.at, missed: m })),
  ];
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** The soonest scheduled run, for "All clear · next run …". */
export function nextRun(automations: Automation[]): string | null {
  const times = automations.map((a) => a.nextRunAt).filter((t): t is string => !!t).sort();
  return times[0] ?? null;
}

/**
 * Snooze presets for `now`: short delays, the rest of today when it is still ahead, tomorrow
 * morning (this morning, before 5 AM), and next week. A preset within 45 minutes of an earlier
 * one is dropped.
 */
export function snoozeOptions(now = new Date()): { label: string; until: string }[] {
  const at = (dayOffset: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const opts: { label: string; until: Date }[] = [
    { label: "1 hour", until: new Date(now.getTime() + 3_600_000) },
    { label: "3 hours", until: new Date(now.getTime() + 3 * 3_600_000) },
  ];
  const ahead = (d: Date) => d.getTime() - now.getTime() > 30 * 60_000;
  if (ahead(at(0, 14))) opts.push({ label: "This afternoon (2 PM)", until: at(0, 14) });
  if (ahead(at(0, 18))) opts.push({ label: "This evening (6 PM)", until: at(0, 18) });
  if (now.getHours() < 5) opts.push({ label: "This morning (9 AM)", until: at(0, 9) });
  else opts.push({ label: "Tomorrow 9 AM", until: at(1, 9) });
  const monday = at(1, 9);
  while (monday.getDay() !== 1) monday.setDate(monday.getDate() + 1);
  opts.push({ label: "Next week (Mon 9 AM)", until: monday });
  const kept: typeof opts = [];
  for (const o of opts) if (!kept.some((k) => Math.abs(k.until.getTime() - o.until.getTime()) < 45 * 60_000)) kept.push(o);
  return kept.map((o) => ({ label: o.label, until: o.until.toISOString() }));
}
