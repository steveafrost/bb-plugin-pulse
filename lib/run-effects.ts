import type { PulseItem, PulseRun } from "../types";
// @ts-ignore -- plain ESM module shared with the CLI
import { runEffects as impl } from "./store.mjs";

/**
 * Items whose history records this run creating or resolving them, between its previous run and
 * this one. The store computes this for the Run Log over every item (not just the board's), so the
 * logic lives in lib/store.mjs; this is its typed entry point. `runs` is newest first.
 */
export function runEffects(run: PulseRun, runs: PulseRun[], items: PulseItem[]): { added: PulseItem[]; resolved: PulseItem[] } {
  return impl(run, runs, items);
}
