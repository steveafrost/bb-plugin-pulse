// Pulse item store. Shared by the `pulse` CLI (agents) and the bb panel server.
// State lives in $PULSE_HOME (default ~/.config/pulse):
//   items.json   { version, items: { [id]: Item } }
//   runs.jsonl   one line per capture run
//   state.json   { lastViewedAt, runThreads: { [runName]: threadId } }
//   drafts/      weekly status drafts (markdown)
// The user's done / dismiss / snooze is sticky: agent upserts never undo it unless
// the agent passes reopen:true with a reason (real new activity).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SOURCES = ["slack", "gmail", "calendar", "github", "docs", "other"];
export const KINDS = ["reply", "decision", "rsvp", "conflict", "deadline", "review", "followup", "fyi"];
export const STATUSES = ["open", "waiting", "snoozed", "resolved", "done", "dismissed"];
export const PRIORITIES = ["high", "normal", "low"];
const USER_TERMINAL = new Set(["done", "dismissed"]);
const CLOSED = new Set(["resolved", "done", "dismissed"]);
const MUTABLE = ["title", "detail", "url", "due", "priority", "kind", "source", "people", "status", "quickActions"];
const DESCRIPTIVE = ["title", "detail", "url", "due", "people", "quickActions"];

export class PulseError extends Error {}
const fail = (msg) => { throw new PulseError(msg); };
const now = () => new Date().toISOString();

export function pulseHome() {
  return process.env.PULSE_HOME || path.join(os.homedir(), ".config/pulse");
}
function paths(home = pulseHome()) {
  return {
    home, items: path.join(home, "items.json"), runs: path.join(home, "runs.jsonl"),
    state: path.join(home, "state.json"), drafts: path.join(home, "drafts"), lock: path.join(home, ".lock"),
  };
}

function ensureHome(p) { fs.mkdirSync(p.drafts, { recursive: true }); }

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function withLock(p, fn) {
  ensureHome(p);
  const deadline = Date.now() + 15000;
  for (;;) {
    try { fs.mkdirSync(p.lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(p.lock).mtimeMs > 60000) { fs.rmSync(p.lock, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() > deadline) fail("timed out waiting for lock " + p.lock);
      sleep(100);
    }
  }
  try { return fn(); } finally { fs.rmSync(p.lock, { recursive: true, force: true }); }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (e.code === "ENOENT") return fallback;
    fail(`cannot parse ${file}: ${e.message}`);
  }
}
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
const loadDb = (p) => readJson(p.items, { version: 1, items: {} });

export function isoOrNull(v, field) {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail(`${field} is not a valid date: ${v}`);
  return d.toISOString();
}

export function effectiveStatus(item, at = now()) {
  if (item.status === "snoozed" && item.snoozedUntil && item.snoozedUntil <= at) return "open";
  return item.status;
}

function pushHistory(item, entry) {
  item.history = item.history || [];
  item.history.push({ at: now(), ...entry });
  if (item.history.length > 50) item.history = item.history.slice(-50);
}

function validateInput(it, i) {
  const where = `item[${i}]`;
  if (!it || typeof it !== "object") fail(`${where} must be an object`);
  if (typeof it.id !== "string" || !/^[a-z]+:.+/.test(it.id)) fail(`${where}.id must look like "<source>:<stable-id>", got ${JSON.stringify(it.id)}`);
  if (it.source !== undefined && !SOURCES.includes(it.source)) fail(`${where}.source must be one of ${SOURCES.join("|")}`);
  if (it.kind !== undefined && !KINDS.includes(it.kind)) fail(`${where}.kind must be one of ${KINDS.join("|")}`);
  if (it.status !== undefined && !["open", "waiting", "resolved"].includes(it.status)) fail(`${where}.status from an agent must be open|waiting|resolved`);
  if (it.priority !== undefined && !PRIORITIES.includes(it.priority)) fail(`${where}.priority must be one of ${PRIORITIES.join("|")}`);
  if (it.people !== undefined && !Array.isArray(it.people)) fail(`${where}.people must be an array of names`);
  if (it.reopen && !it.reason) fail(`${where}.reopen requires a reason`);
  if (it.quickActions !== undefined) validateQuickActions(it.quickActions, where);
}

/**
 * Quick actions are one-click helpers on a card: copy prepared text and/or open a link.
 * They never send anything; the user pastes and sends.
 */
function validateQuickActions(qa, where) {
  if (!Array.isArray(qa)) fail(`${where}.quickActions must be an array`);
  if (qa.length > 3) fail(`${where}.quickActions allows at most 3 actions`);
  qa.forEach((a, j) => {
    const w = `${where}.quickActions[${j}]`;
    if (!a || typeof a !== "object") fail(`${w} must be an object`);
    if (typeof a.label !== "string" || !a.label.trim() || a.label.length > 32) fail(`${w}.label must be a short string (1-32 chars)`);
    if (a.text !== undefined && (typeof a.text !== "string" || !a.text.trim() || a.text.length > 1500)) fail(`${w}.text must be a non-empty string up to 1500 chars`);
    if (a.url !== undefined && (typeof a.url !== "string" || !/^https:\/\//.test(a.url))) fail(`${w}.url must be an https URL`);
    if (a.text === undefined && a.url === undefined) fail(`${w} needs text to copy, a url to open, or both`);
    const extra = Object.keys(a).filter((k) => !["label", "text", "url"].includes(k));
    if (extra.length) fail(`${w} has unknown fields: ${extra.join(", ")}`);
  });
}

/** Agent write path. Returns a summary of what changed. */
export function upsert(input, run, home) {
  if (!run) fail("run name is required");
  if (!Array.isArray(input)) input = [input];
  input.forEach(validateInput);
  const p = paths(home);
  const out = { created: [], updated: [], unchanged: [], resolved: [], keptUserState: [], reopened: [] };
  withLock(p, () => {
    const db = loadDb(p);
    const at = now();
    for (const it of input) {
      const cur = db.items[it.id];
      const source = it.source || it.id.split(":")[0];
      if (!cur) {
        if (!it.title) fail(`new item ${it.id} needs a title`);
        const status = it.status || "open";
        db.items[it.id] = {
          id: it.id, source: SOURCES.includes(source) ? source : "other",
          kind: it.kind || "followup", title: it.title, detail: it.detail || "", url: it.url || null,
          due: isoOrNull(it.due, "due"), priority: it.priority || "normal", people: it.people || [], quickActions: it.quickActions || [],
          status, snoozedUntil: null, resolution: status === "resolved" ? (it.reason || null) : null,
          firstSeenAt: at, lastSeenAt: at, updatedAt: at, resolvedAt: status === "resolved" ? at : null,
          lastChangedBy: run, history: [],
        };
        pushHistory(db.items[it.id], { by: run, change: "created", reason: it.reason });
        out.created.push(it.id);
        continue;
      }
      cur.lastSeenAt = at;
      const userLocked = USER_TERMINAL.has(cur.status) || (cur.status === "snoozed" && effectiveStatus(cur, at) === "snoozed");
      if (userLocked && !it.reopen) {
        for (const k of DESCRIPTIVE) if (it[k] !== undefined) cur[k] = k === "due" ? isoOrNull(it.due, "due") : it[k];
        out.keptUserState.push(`${it.id} (${cur.status})`);
        continue;
      }
      const changes = [];
      for (const k of MUTABLE) {
        if (it[k] === undefined) continue;
        const next = k === "due" ? isoOrNull(it[k], "due") : it[k];
        if (JSON.stringify(cur[k]) !== JSON.stringify(next)) { changes.push(k); cur[k] = next; }
      }
      if (it.reopen) { cur.status = it.status && it.status !== "resolved" ? it.status : "open"; cur.snoozedUntil = null; cur.resolvedAt = null; changes.push("reopened"); out.reopened.push(it.id); }
      if (cur.status === "snoozed" && effectiveStatus(cur, at) === "open") { cur.status = "open"; cur.snoozedUntil = null; changes.push("snooze-expired"); }
      if (changes.includes("status")) {
        if (cur.status === "resolved") { cur.resolvedAt = at; cur.resolution = it.reason || cur.resolution; out.resolved.push(it.id); }
        else cur.resolvedAt = null;
      }
      if (changes.length) {
        cur.updatedAt = at; cur.lastChangedBy = run;
        pushHistory(cur, { by: run, change: changes.join(","), reason: it.reason });
        if (!out.resolved.includes(it.id) && !out.reopened.includes(it.id)) out.updated.push(`${it.id} [${changes.join(",")}]`);
      } else out.unchanged.push(it.id);
    }
    writeJson(p.items, db);
  });
  return out;
}

/** The user's write path: done | dismissed | snoozed | open. */
export function userAction(id, status, { until, reason, by = "user" } = {}, home) {
  if (!["done", "dismissed", "snoozed", "open"].includes(status)) fail(`unknown action ${status}`);
  const p = paths(home);
  return withLock(p, () => {
    const db = loadDb(p);
    const cur = db.items[id] || fail(`no item ${id}`);
    const at = now();
    cur.status = status;
    cur.snoozedUntil = status === "snoozed" ? (isoOrNull(until, "until") || fail("snooze needs an until time")) : null;
    if (status === "open") cur.resolvedAt = null;
    if (USER_TERMINAL.has(status)) { cur.resolvedAt = at; cur.resolution = reason || cur.resolution || null; }
    cur.updatedAt = at; cur.lastChangedBy = by;
    pushHistory(cur, { by, change: status, reason, until: cur.snoozedUntil || undefined });
    writeJson(p.items, db);
    return { ...cur, status: effectiveStatus(cur, at) };
  });
}

// ---- Agent actions: the user hands an item to an agent thread from the panel ----
// item.action = { threadId, status: running|ready|failed, startedAt, finishedAt, summary, seenAt }
export const ACTION_STATUSES = ["running", "ready", "failed"];

/** Record a newly started action thread. Refuses while another action on the item is running. */
export function startAction(id, { threadId, by = "user" } = {}, home) {
  if (!threadId) fail("startAction needs a threadId");
  const p = paths(home);
  return withLock(p, () => {
    const db = loadDb(p);
    const cur = db.items[id] || fail(`no item ${id}`);
    if (cur.action?.status === "running") fail(`item ${id} already has a running action (${cur.action.threadId})`);
    const at = now();
    cur.action = { threadId, status: "running", startedAt: at, finishedAt: null, summary: null, seenAt: null };
    cur.updatedAt = at; cur.lastChangedBy = by;
    pushHistory(cur, { by, change: "action-started", reason: threadId });
    writeJson(p.items, db);
    return cur;
  });
}

/** Move an action to running | ready | failed. No-op (returns null) when the thread is not this item's action. */
export function setActionStatus(id, status, { threadId, summary, by = "pulse" } = {}, home) {
  if (!ACTION_STATUSES.includes(status)) fail(`action status must be one of ${ACTION_STATUSES.join("|")}`);
  const p = paths(home);
  return withLock(p, () => {
    const db = loadDb(p);
    const cur = db.items[id];
    if (!cur?.action || (threadId && cur.action.threadId !== threadId)) return null;
    if (cur.action.status === status) return cur;
    const at = now();
    cur.action.status = status;
    cur.action.finishedAt = status === "running" ? null : at;
    if (summary !== undefined) cur.action.summary = summary || null;
    if (status !== "running") cur.action.seenAt = null;
    cur.updatedAt = at; cur.lastChangedBy = by;
    pushHistory(cur, { by, change: `action-${status}`, reason: status === "running" ? undefined : (summary || undefined) });
    writeJson(p.items, db);
    return cur;
  });
}

/** The user opened the finished action's thread: clears the unread Ready marker. */
export function markActionSeen(id, home) {
  const p = paths(home);
  return withLock(p, () => {
    const db = loadDb(p);
    const cur = db.items[id] || fail(`no item ${id}`);
    if (!cur.action || cur.action.seenAt) return cur;
    cur.action.seenAt = now();
    writeJson(p.items, db);
    return cur;
  });
}

/** Items whose action is in a given status (default running). */
export function actionItems(status = "running", home) {
  return Object.values(loadDb(paths(home)).items).filter((i) => i.action && (!status || i.action.status === status));
}

const PR = { high: 0, normal: 1, low: 2 };
export function sortItems(list) {
  const d = (i) => i.due || "9999";
  return list.sort((a, b) => (PR[a.priority] - PR[b.priority]) || (d(a) < d(b) ? -1 : d(a) > d(b) ? 1 : 0) || (a.firstSeenAt < b.firstSeenAt ? -1 : 1));
}

export function listItems({ statuses = ["open", "waiting"], sources, withHistory = false } = {}, home) {
  const p = paths(home);
  const at = now();
  let list = Object.values(loadDb(p).items).map((i) => ({ ...i, status: effectiveStatus(i, at) }));
  list = list.filter((i) => statuses.includes(i.status));
  if (sources) list = list.filter((i) => sources.includes(i.source));
  if (!withHistory) list = list.map(({ history, ...rest }) => rest);
  return sortItems(list);
}

export function getItem(id, home) {
  return loadDb(paths(home)).items[id] || fail(`no item ${id}`);
}

export function readRuns(home) {
  try { return fs.readFileSync(paths(home).runs, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

export function logRun({ run, summary, started, sources = [], errors = [], thread = process.env.BB_THREAD_ID || null }, home) {
  if (!run) fail("run name is required");
  if (!summary) fail("summary is required");
  const p = paths(home);
  const entry = { run, startedAt: isoOrNull(started, "started"), finishedAt: now(), summary, thread, sources, errors };
  withLock(p, () => fs.appendFileSync(p.runs, JSON.stringify(entry) + "\n"));
  return entry;
}

export function getState(home) { return readJson(paths(home).state, {}); }

/**
 * Thread ids for capture runs, kept beside the store instead of in plugin kv.
 * `bb plugin remove` deletes kv, so a reinstall would otherwise spawn a fresh
 * thread for every run; this directory survives removal and its thread ids keep
 * working because bb threads outlive the plugin that made them.
 */
export function getRunThreads(home) {
  const threads = getState(home).runThreads;
  return threads && typeof threads === "object" ? threads : {};
}

export function setRunThread(name, threadId, home) {
  if (!name) fail("run name is required");
  const p = paths(home);
  return withLock(p, () => {
    const state = readJson(p.state, {});
    const threads = state.runThreads && typeof state.runThreads === "object" ? state.runThreads : {};
    if (threadId) threads[name] = threadId;
    else delete threads[name];
    state.runThreads = threads;
    writeJson(p.state, state);
    return threads;
  });
}

export function markSeen(at, home) {
  const p = paths(home);
  return withLock(p, () => {
    const state = readJson(p.state, {});
    state.lastViewedAt = isoOrNull(at, "at") || now();
    writeJson(p.state, state);
    return state;
  });
}

export function resolveSince(since, { run } = {}, home) {
  if (!since || since === "last-viewed") return getState(home).lastViewedAt || "1970-01-01T00:00:00.000Z";
  if (since === "last-run") {
    const runs = readRuns(home).filter((r) => !run || r.run === run);
    return runs.length ? runs[runs.length - 1].finishedAt : "1970-01-01T00:00:00.000Z";
  }
  return isoOrNull(since, "since");
}

export function changes(since, home) {
  const p = paths(home);
  const out = { since, created: [], resolved: [], updated: [] };
  for (const i of Object.values(loadDb(p).items)) {
    const recent = (i.history || []).filter((h) => h.at > since);
    if (!recent.length) continue;
    const brief = { id: i.id, title: i.title, status: effectiveStatus(i), changes: recent.map((h) => `${h.by}:${h.change}`) };
    if (i.firstSeenAt > since) out.created.push(brief);
    else if (CLOSED.has(i.status)) out.resolved.push(brief);
    else out.updated.push(brief);
  }
  return out;
}

export function saveDraft(body, { kind = "weekly", date } = {}, home) {
  if (!body || !body.trim()) fail("draft body is empty");
  const p = paths(home);
  ensureHome(p);
  const day = date || new Date().toLocaleDateString("en-CA");
  const file = path.join(p.drafts, `${kind}-${day}.md`);
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n");
  return { saved: file };
}

export function latestDraft(kind = "weekly", home) {
  const p = paths(home);
  const files = fs.existsSync(p.drafts) ? fs.readdirSync(p.drafts).filter((f) => f.startsWith(kind + "-") && f.endsWith(".md")).sort() : [];
  if (!files.length) return null;
  const file = path.join(p.drafts, files.at(-1));
  return { kind, date: files.at(-1).slice(kind.length + 1, -3), file, body: fs.readFileSync(file, "utf8"), modifiedAt: fs.statSync(file).mtime.toISOString() };
}

/** Everything the panel renders, in one read. */
export function snapshot(home) {
  const at = now();
  const all = listItems({ statuses: STATUSES, withHistory: true }, home);
  const cutoff = new Date(Date.now() - 3 * 86400_000).toISOString();
  const runs = readRuns(home);
  const lastRuns = {};
  for (const r of runs) lastRuns[r.run] = r;
  return {
    home: paths(home).home,
    generatedAt: at,
    lastViewedAt: getState(home).lastViewedAt || null,
    items: all.filter((i) => !CLOSED.has(i.status) || (i.resolvedAt || i.updatedAt) > cutoff),
    lastRuns,
    recentRuns: runs.slice(-12).reverse(),
    draft: latestDraft("weekly", home),
  };
}
