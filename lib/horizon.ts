import type { ThirdHandItem } from "../types";

export type Horizon = "now" | "next" | "later" | "info";

const DAY_MS = 86_400_000;
/** How far ahead counts as `next`. Matches ThirdHandCore's `HorizonDerivation.nextWindowDays`. */
export const NEXT_WINDOW_DAYS = 3;

const CLOSED = new Set(["done", "dismissed", "resolved"]);

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The board's four buckets, matching ThirdHandCore's `HorizonDerivation` — the code
 * the iPhone app runs — so an item sits in the same bucket on both screens.
 *
 * The iPhone is the source of truth for item content, so it is the source of
 * truth for placement too. This deliberately replaced the panel's older rules
 * (`test/fixtures/horizon-cases.json` is the fixture both sides assert):
 *
 *   * `fyi` is always Nice to Know, whatever its due date or priority.
 *   * Now: priority `high`, or `due` on or before today.
 *   * Next: `due` within the next three days (inclusive).
 *   * Later: everything else, including an undated normal-priority item.
 *
 * Closed items have no bucket: `horizonOf` returns null for `done`/`dismissed`/
 * `resolved`. `bucketOf` ignores closed state, which is what the panel uses to
 * place a row it is animating out.
 *
 * A snoozed item stays on the board (the contract keeps it in the snapshot so it
 * can be un-snoozed), and an expired snooze reads back as open.
 */
export function effectiveStatusAt(item: Pick<ThirdHandItem, "status" | "snoozedUntil">, now: Date = new Date()): string {
  const iso = now.toISOString();
  if (item.status === "snoozed" && item.snoozedUntil && item.snoozedUntil <= iso) return "open";
  return item.status;
}

/** Whether the item belongs on the board at all. */
export function isOnBoard(item: Pick<ThirdHandItem, "status" | "snoozedUntil">, now: Date = new Date()): boolean {
  return !CLOSED.has(effectiveStatusAt(item, now));
}

/** The bucket regardless of closed state. */
export function bucketOf(item: Pick<ThirdHandItem, "kind" | "priority" | "due">, now: Date = new Date()): Horizon {
  if (item.kind === "fyi") return "info";
  if (item.priority === "high") return "now";
  if (!item.due) return "later";
  const due = Date.parse(item.due);
  if (!Number.isFinite(due)) return "later";
  const today = startOfDay(now);
  const dueDay = startOfDay(new Date(due));
  if (dueDay <= today) return "now";
  if (dueDay <= today + NEXT_WINDOW_DAYS * DAY_MS) return "next";
  return "later";
}

/** The item's bucket, or null when it is closed. */
export function horizonOf(
  item: Pick<ThirdHandItem, "kind" | "status" | "snoozedUntil" | "priority" | "due">,
  now: Date = new Date(),
): Horizon | null {
  if (!isOnBoard(item, now)) return null;
  return bucketOf(item, now);
}

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

/**
 * Within-bucket order: priority ascending, then `due` ascending with undated
 * items last, then `firstSeenAt`, then `id`. This is `sortItems` in
 * `lib/store.mjs` and `ThirdHandItemSort` in ThirdHandCore, except that the remaining
 * tie is broken by `id` — the JS comparator returns 1 on a tie, which is an
 * inconsistent comparator.
 */
export function sortItems<T extends Pick<ThirdHandItem, "id" | "priority" | "due" | "firstSeenAt">>(list: T[]): T[] {
  return list.sort((a, b) => {
    const byPriority = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
    if (byPriority) return byPriority;
    const da = a.due ? Date.parse(a.due) : NaN;
    const db = b.due ? Date.parse(b.due) : NaN;
    const ha = Number.isFinite(da);
    const hb = Number.isFinite(db);
    if (ha && hb && da !== db) return da - db;
    if (ha !== hb) return ha ? -1 : 1;
    if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt < b.firstSeenAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/** Group items into the four buckets, each sorted. Closed items are skipped. */
export function groupByHorizon(
  items: ThirdHandItem[],
  now: Date = new Date(),
): Record<Horizon, ThirdHandItem[]> {
  const board: Record<Horizon, ThirdHandItem[]> = { now: [], next: [], later: [], info: [] };
  for (const item of items) {
    const horizon = horizonOf(item, now);
    if (horizon) board[horizon].push(item);
  }
  for (const key of Object.keys(board) as Horizon[]) sortItems(board[key]);
  return board;
}
