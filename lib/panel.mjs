// What the panel renders, assembled from the mirror read plus Mac-local state.
//
// Kept out of server.ts so the merge is testable without a bb host: server.ts
// supplies the snapshot items, the agent-action records (lib/actions.mjs) and the
// pending commands (lib/commands.mjs) and gets back the item list app.tsx draws.
//
// Deliberate choice on pending transitions: an item keeps the *snapshot's*
// status and gains `pending: [op, ...]`, so the panel can say "Sent to iPhone".
// It is not flipped optimistically — the iPhone owns item content, and a flip it
// then refuses (a stale `at`, per the conflict rule) would make the board wrong
// twice. The marker clears when `commands.ack.jsonl` names the command.

/** `Map<itemId, ItemAction[]>` from a pending-command list. */
export function pendingByItem(pending = []) {
  const map = new Map();
  for (const row of pending) {
    const list = map.get(row.itemId) ?? [];
    list.push(row.op);
    map.set(row.itemId, list);
  }
  return map;
}

/** `Record<itemId, action>` from `[itemId, action]` pairs. */
export function actionsByItem(entries = []) {
  return Object.fromEntries(entries.filter(([, action]) => action));
}

/**
 * Merge the mirror items with agent-action records and pending markers, and add
 * the computed `agentSkills` hint for open items.
 *
 * `skillsFor(item)` returns the skill refs an agent thread for that item would
 * load; server.ts passes `skillsForItem`, tests can pass a stub.
 */
export function projectItems(items, { actions = {}, pending = new Map(), skillsFor = null } = {}) {
  return items.map((item) => {
    const next = { ...item };
    const action = actions[item.id];
    if (action) next.action = action;
    const ops = pending.get(item.id);
    if (ops?.length) next.pending = [...new Set(ops)];
    if (skillsFor && (next.status === "open" || next.status === "waiting")) {
      next.agentSkills = skillsFor(next).map((ref) => ref.name);
    }
    return next;
  });
}
