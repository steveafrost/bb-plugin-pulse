import type { PulseItem } from "../types";

export type Horizon = "now" | "next" | "later" | "info";

const DAY_MS = 86_400_000;
/** Undated low-priority items climb from Later to Next after this long, so they are not parked forever. */
export const LOW_PRIORITY_AGING_DAYS = 3;

/** Local midnight `days` after `d`'s day. Calendar arithmetic, so 23- and 25-hour DST days are right. */
function midnightAfter(d: Date, days: number): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/**
 * Nice to Know: kind "fyi" — informational, no action needed.
 * Now: high priority, overdue, or due by end of today.
 * Next: due by end of tomorrow, normal priority with no date, or undated low priority open for a few days.
 * Later: low priority, due after tomorrow, waiting on others, or snoozed.
 */
export function horizonOf(item: Pick<PulseItem, "kind" | "status" | "priority" | "due" | "firstSeenAt">, now = new Date()): Horizon {
  if (item.kind === "fyi") return "info";
  if (item.status === "waiting" || item.status === "snoozed") return "later";
  const endToday = midnightAfter(now, 1);
  const endTomorrow = midnightAfter(now, 2);
  const due = item.due ? Date.parse(item.due) : NaN;
  if (item.priority === "high" || (Number.isFinite(due) && due < endToday)) return "now";
  if (Number.isFinite(due)) return due < endTomorrow ? "next" : "later";
  if (item.priority !== "low") return "next";
  const seen = Date.parse(item.firstSeenAt);
  return Number.isFinite(seen) && now.getTime() - seen >= LOW_PRIORITY_AGING_DAYS * DAY_MS ? "next" : "later";
}
