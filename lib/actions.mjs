// Local record of agent-thread actions started from the panel.
//
// The item content lives on the iPhone, so this is deliberately Mac-local state:
// it never goes into snapshot.json (the plugin must not author items) and it
// never goes into the iCloud container. It lives beside the plugin's own state
// directory (`$PULSE_HOME`), keyed by item id, and is merged into the snapshot
// items when the panel renders.
//
// Shape, identical to `item.action` in types.ts:
//   { threadId, status: running|ready|failed, startedAt, finishedAt, summary, seenAt }

import fs from "node:fs";
import path from "node:path";

export const ACTION_STATUSES = ["running", "ready", "failed"];

export function actionsPath(home) {
  return path.join(home, "actions.json");
}

export function readActions(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(actionsPath(home), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function write(home, map) {
  fs.mkdirSync(home, { recursive: true });
  const file = actionsPath(home);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Record a freshly started action. Refuses while another one on the item runs. */
export function startAction(home, id, { threadId, at = new Date().toISOString() } = {}) {
  if (!threadId) throw new Error("startAction needs a threadId");
  const map = readActions(home);
  if (map[id]?.status === "running") throw new Error(`item ${id} already has a running action (${map[id].threadId})`);
  map[id] = { threadId, status: "running", startedAt: at, finishedAt: null, summary: null, seenAt: null };
  write(home, map);
  return map[id];
}

/** Move an action to running | ready | failed. Returns null for a foreign thread. */
export function setActionStatus(home, id, status, { threadId, summary = null, at = new Date().toISOString() } = {}) {
  if (!ACTION_STATUSES.includes(status)) throw new Error(`action status must be one of ${ACTION_STATUSES.join("|")}`);
  const map = readActions(home);
  const cur = map[id];
  if (!cur || (threadId && cur.threadId !== threadId)) return null;
  if (cur.status === status) return cur;
  map[id] = {
    ...cur,
    status,
    finishedAt: status === "running" ? null : at,
    ...(summary !== null ? { summary: summary || null } : {}),
    seenAt: status === "running" ? cur.seenAt ?? null : null,
  };
  write(home, map);
  return map[id];
}

/** The user opened a finished action's thread: clear its unread Ready marker. */
export function markActionSeen(home, id, at = new Date().toISOString()) {
  const map = readActions(home);
  const cur = map[id];
  if (!cur || cur.seenAt) return cur ?? null;
  map[id] = { ...cur, seenAt: at };
  write(home, map);
  return map[id];
}

/** `[itemId, action]` pairs, optionally filtered by status. */
export function actionEntries(home, status = null) {
  return Object.entries(readActions(home)).filter(([, action]) => !status || action.status === status);
}
