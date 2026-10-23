import type { PulseHistoryEntry, PulseItem, PulseRun } from "../types";

const STATUS_CHANGE = /(^|,)(status|resolved|reopened|snooze-expired)(,|$)/;
const USER_STATUS = new Set(["done", "dismissed", "snoozed", "open"]);
const changesStatus = (h: PulseHistoryEntry) => STATUS_CHANGE.test(h.change) || USER_STATUS.has(h.change);

/** Items whose history records this run creating or resolving them, between its previous run and this one. */
export function runEffects(run: PulseRun, runs: PulseRun[], items: PulseItem[]) {
  const prev = runs.find((r) => r.run === run.run && r.finishedAt < run.finishedAt);
  const from = run.startedAt ?? run.previousFinishedAt ?? prev?.finishedAt ?? "";
  const added: PulseItem[] = [];
  const resolved: PulseItem[] = [];
  for (const i of items) {
    const history = i.history ?? [];
    // 0.1.6 and earlier recorded an agent resolve as a plain "status" change. Only count one as a
    // resolve when it is the item's last status change and the item is still resolved, so an older
    // move to waiting isn't credited with a later run's resolve.
    const lastStatusChange = [...history].reverse().find(changesStatus);
    for (const h of history) {
      if (h.by !== run.run || h.at <= from || h.at > run.finishedAt) continue;
      if (h.change === "created") added.push(i);
      else if (/(^|,)resolved(,|$)/.test(h.change)) resolved.push(i);
      else if (/(^|,)status(,|$)/.test(h.change) && i.status === "resolved" && h === lastStatusChange) resolved.push(i);
    }
  }
  return { added: [...new Set(added)], resolved: [...new Set(resolved)] };
}
