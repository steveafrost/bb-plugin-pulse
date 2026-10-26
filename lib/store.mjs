// Pulse item store. Shared by the `pulse` CLI (agents) and the bb panel server.
// State lives in $PULSE_HOME (default ~/.config/pulse):
//   items.json   { version, items: { [id]: Item } }
//   runs.jsonl   one line per capture run
//   state.json   { lastViewedAt, runThreads: { [runName]: threadId } }
//   *.bak        the previous good copy of items.json / state.json (read when the file is torn)
//   items-archive.jsonl, runs-archive.jsonl   housekeeping moves old records here
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
    state: path.join(home, "state.json"), lock: path.join(home, ".lock"),
    itemsArchive: path.join(home, "items-archive.jsonl"), runsArchive: path.join(home, "runs-archive.jsonl"),
  };
}

function ensureHome(p) { fs.mkdirSync(p.home, { recursive: true }); }

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// ---- Lock ----
// A directory lock (mkdir is atomic) with an owner file naming the holder. A holder that died
// (killed CLI, crashed run) leaves the directory behind; the owner pid lets the next writer break
// it at once instead of waiting out the age threshold. Breaking happens under a second mkdir
// mutex (`.lock.break`) and re-checks that the lock is still the same stale directory (by inode)
// before removing it, so two waiters can never both break it and one delete the other's fresh
// lock. Release removes the lock only while its owner file still carries our token.
const LOCK_WAIT_MS = 15_000;
/** A holder with a live pid is trusted this long: no store write takes more than milliseconds. */
const LOCK_STALE_MS = 60_000;
/** A lock with no owner file: a pre-0.1.14 writer (which holds it for milliseconds) or a crash
 *  between mkdir and writing the owner. Either way it is orphaned after a few seconds. */
const LOCK_OWNERLESS_STALE_MS = 5_000;

// globalThis.crypto and optional fs/os calls keep this module bundleable for the browser demo
// (pulse-demo runs the real store over an in-memory fs).
const randomUUID = () => globalThis.crypto.randomUUID();
const hostname = () => (typeof os.hostname === "function" ? os.hostname() : "");
const ownerFile = (p) => path.join(p.lock, "owner");
function readOwner(p) {
  try { return JSON.parse(fs.readFileSync(ownerFile(p), "utf8")); } catch { return null; }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
/** The lock's inode when it is stale and should be broken, else null. */
function staleLock(p) {
  let st;
  try { st = fs.statSync(p.lock); } catch { return null; }
  const age = Date.now() - st.mtimeMs;
  const owner = readOwner(p);
  if (owner && typeof owner.pid === "number") {
    const sameHost = !owner.host || owner.host === hostname();
    return (sameHost && !pidAlive(owner.pid)) || age > LOCK_STALE_MS ? st.ino : null;
  }
  return age > LOCK_OWNERLESS_STALE_MS ? st.ino : null;
}
/** Remove the lock if it is still the stale directory `ino`. Returns false when another process is breaking it. */
function breakLock(p, ino) {
  const brk = p.lock + ".break";
  try { fs.mkdirSync(brk); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // A breaker that crashed mid-break leaves this behind; it only ever lives for microseconds.
    try { if (Date.now() - fs.statSync(brk).mtimeMs > LOCK_OWNERLESS_STALE_MS) fs.rmSync(brk, { recursive: true, force: true }); } catch { /* gone */ }
    return false;
  }
  try {
    if (staleLock(p) === ino) fs.rmSync(p.lock, { recursive: true, force: true });
    return true;
  } finally { fs.rmSync(brk, { recursive: true, force: true }); }
}

function withLock(p, fn) {
  ensureHome(p);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.mkdirSync(p.lock); } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const ino = staleLock(p);
      if (ino !== null && breakLock(p, ino)) continue;
      if (Date.now() > deadline) fail("timed out waiting for lock " + p.lock);
      sleep(ino !== null ? 2 : 20);
      continue;
    }
    try { fs.writeFileSync(ownerFile(p), JSON.stringify({ pid: process.pid, host: hostname(), token, at: now() })); } catch (e) {
      fs.rmSync(p.lock, { recursive: true, force: true });
      throw e;
    }
    break;
  }
  try { return fn(); } finally {
    if (readOwner(p)?.token === token) fs.rmSync(p.lock, { recursive: true, force: true });
  }
}

// ---- Files ----
/** Set when a torn items.json / state.json was read from its .bak copy; the panel shows it. */
let lastRecovery = null;
export function recoveryNotice() { return lastRecovery; }

function readJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return fallback;
    fail(`cannot read ${file}: ${e.message}`);
  }
  try {
    const data = JSON.parse(text);
    if (lastRecovery?.file === file) lastRecovery = null;
    return data;
  } catch (e) {
    // A crash mid-write, a full disk or a hand edit: fall back to the last good copy so the panel
    // and the runs keep working. The next write replaces the torn file.
    try {
      const data = JSON.parse(fs.readFileSync(file + ".bak", "utf8"));
      lastRecovery = { file, at: now(), error: e.message };
      return data;
    } catch {
      fail(`cannot parse ${file}: ${e.message} (no usable ${path.basename(file)}.bak; run \`pulse doctor\`)`);
    }
  }
}
/** Write a file whole or not at all: fsync'd temp file, then rename over the target. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  if (typeof fs.fsyncSync === "function") {
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  fs.renameSync(tmp, file);
}
/** Whether a non-empty file is missing its trailing newline (a torn append). */
function tornTail(file) {
  if (typeof fs.readSync !== "function") {
    try { const t = fs.readFileSync(file, "utf8"); return t.length > 0 && !t.endsWith("\n"); } catch { return false; }
  }
  let fd;
  try { fd = fs.openSync(file, "r"); } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally { fs.closeSync(fd); }
}
/**
 * Our own writes can't tear the file (temp + rename), so a torn items.json comes from outside:
 * a hand edit, a full disk, a sync tool. .bak mirrors the last good write for that case.
 */
function writeJson(file, data) {
  const text = JSON.stringify(data, null, 2) + "\n";
  writeAtomic(file, text);
  writeAtomic(file + ".bak", text);
  if (lastRecovery?.file === file) lastRecovery = null;
}
const loadDb = (p) => readJson(p.items, { version: 1, items: {} });

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_START = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/i;
/**
 * A date field from an agent or the CLI, normalized to ISO. Only ISO-8601 strings are taken
 * (`new Date(true)` or `new Date("5")` would quietly become 1970 or 2001). A date with no time
 * means that day in the server's time zone, at `dayHour` (due: 17:00, the prompt's "end of day").
 */
export function isoOrNull(v, field, { dayHour = 0 } = {}) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !ISO_START.test(v.trim())) fail(`${field} is not a valid date: ${JSON.stringify(v)} (use ISO 8601 with a time and offset, e.g. 2026-10-27T09:00:00-04:00)`);
  const s = v.trim();
  let d;
  if (ISO_DAY.test(s)) {
    const [y, m, day] = s.split("-").map(Number);
    d = new Date(y, m - 1, day, dayHour, 0, 0, 0);
  } else d = new Date(s);
  if (Number.isNaN(d.getTime())) fail(`${field} is not a valid date: ${JSON.stringify(v)}`);
  return d.toISOString();
}
const dueOrNull = (v, field = "due") => isoOrNull(v, field, { dayHour: 17 });


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
  if (typeof it.id !== "string" || !/^[a-z]+:\S{1,200}$/.test(it.id)) fail(`${where}.id must look like "<source>:<stable-id>" with no spaces, got ${JSON.stringify(it.id)}`);
  if (it.source !== undefined && !SOURCES.includes(it.source)) fail(`${where}.source must be one of ${SOURCES.join("|")}`);
  if (it.kind !== undefined && !KINDS.includes(it.kind)) fail(`${where}.kind must be one of ${KINDS.join("|")}`);
  if (it.status !== undefined && !["open", "waiting", "resolved"].includes(it.status)) fail(`${where}.status from an agent must be open|waiting|resolved`);
  if (it.priority !== undefined && !PRIORITIES.includes(it.priority)) fail(`${where}.priority must be one of ${PRIORITIES.join("|")}`);
  if (it.title !== undefined && (typeof it.title !== "string" || !it.title.trim())) fail(`${where}.title must be a non-empty string`);
  if (it.detail !== undefined && it.detail !== null && typeof it.detail !== "string") fail(`${where}.detail must be a string`);
  // The panel turns url into a link, and it comes from other people's content: web links only.
  if (it.url !== undefined && it.url !== null && (typeof it.url !== "string" || !/^https?:\/\//i.test(it.url))) fail(`${where}.url must be an http(s) URL`);
  if (it.people !== undefined && (!Array.isArray(it.people) || it.people.some((n) => typeof n !== "string"))) fail(`${where}.people must be an array of names`);
  if (it.reopen !== undefined && typeof it.reopen !== "boolean") fail(`${where}.reopen must be true or false`);
  if (it.reason !== undefined && it.reason !== null && typeof it.reason !== "string") fail(`${where}.reason must be a string`);
  if (it.due !== undefined && it.due !== null && typeof it.due !== "string") fail(`${where}.due must be an ISO date string`);
  // Parse here, before anything is written, so the error names the item.
  if (it.due) dueOrNull(it.due, `${where}.due`);
  if (it.reopen && !it.reason?.trim()) fail(`${where}.reopen requires a reason`);
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
    const extra = Object.keys(a).filter((k) => !["label", "text", "url"].includes(k));
    if (extra.length) fail(`${w} has unknown fields: ${extra.join(", ")}`);
  });
}

/** An open-only action (no text, no url) opens the item's own link, stored explicitly. */
function fillQuickActions(qa, itemUrl, where) {
  return qa.map((a, j) => {
    if (a.text !== undefined || a.url !== undefined) return a;
    if (typeof itemUrl === "string" && /^https:\/\//.test(itemUrl)) return { ...a, url: itemUrl };
    return fail(`${where}.quickActions[${j}] only opens a link, so it needs its own https url (the item has none)`);
  });
}

/** Agent write path. Returns a summary of what changed. */
export function upsert(input, run, home) {
  if (typeof run !== "string" || !run.trim()) fail("run name is required");
  if (!Array.isArray(input)) input = [input];
  input.forEach(validateInput);
  const p = paths(home);
  const out = { created: [], updated: [], unchanged: [], resolved: [], keptUserState: [], reopened: [] };
  withLock(p, () => {
    const db = loadDb(p);
    const at = now();
    input.forEach((it, i) => {
      const where = `item[${i}]`;
      const cur = db.items[it.id];
      const source = it.source || it.id.split(":")[0];
      if (!cur) {
        if (!it.title) fail(`new item ${it.id} needs a title`);
        const status = it.status || "open";
        db.items[it.id] = {
          id: it.id, source: SOURCES.includes(source) ? source : "other",
          kind: it.kind || "followup", title: it.title, detail: it.detail || "", url: it.url || null,
          due: dueOrNull(it.due), priority: it.priority || "normal", people: it.people || [],
          quickActions: it.quickActions ? fillQuickActions(it.quickActions, it.url, where) : [],
          status, snoozedUntil: null, resolution: status === "resolved" ? (it.reason || null) : null,
          firstSeenAt: at, lastSeenAt: at, updatedAt: at, resolvedAt: status === "resolved" ? at : null,
          lastChangedBy: run, history: [],
        };
        pushHistory(db.items[it.id], { by: run, change: "created", reason: it.reason });
        out.created.push(it.id);
        return;
      }
      cur.lastSeenAt = at;
      const value = (k) => k === "due" ? dueOrNull(it.due)
        : k === "quickActions" ? fillQuickActions(it.quickActions, it.url !== undefined ? it.url : cur.url, where)
        : it[k];
      // An active snooze means "remind me later", not "this is handled": a resolve still lands, or
      // the item would resurface as open when the snooze ends. Done and dismissed stay locked.
      const snoozedActive = cur.status === "snoozed" && effectiveStatus(cur, at) === "snoozed";
      const userLocked = USER_TERMINAL.has(cur.status) || (snoozedActive && it.status !== "resolved");
      if (userLocked && !it.reopen) {
        for (const k of DESCRIPTIVE) if (it[k] !== undefined) cur[k] = value(k);
        out.keptUserState.push(`${it.id} (${cur.status})`);
        return;
      }
      const changes = [];
      for (const k of MUTABLE) {
        if (it[k] === undefined) continue;
        const next = value(k);
        if (JSON.stringify(cur[k]) !== JSON.stringify(next)) { changes.push(k); cur[k] = next; }
      }
      if (it.reopen) { cur.status = it.status && it.status !== "resolved" ? it.status : "open"; cur.snoozedUntil = null; cur.resolvedAt = null; cur.resolution = null; changes.push("reopened"); out.reopened.push(it.id); }
      if (cur.status === "snoozed" && effectiveStatus(cur, at) === "open") { cur.status = "open"; cur.snoozedUntil = null; changes.push("snooze-expired"); }
      if (changes.includes("status")) {
        if (cur.status === "resolved") {
          cur.resolvedAt = at; cur.resolution = it.reason || cur.resolution; cur.snoozedUntil = null; out.resolved.push(it.id);
          // Name the change so the Run Log can list what this run resolved.
          changes[changes.indexOf("status")] = "resolved";
        }
        else { cur.resolvedAt = null; cur.resolution = null; }
      }
      if (changes.length) {
        cur.updatedAt = at; cur.lastChangedBy = run;
        pushHistory(cur, { by: run, change: changes.join(","), reason: it.reason });
        if (!out.resolved.includes(it.id) && !out.reopened.includes(it.id)) out.updated.push(`${it.id} [${changes.join(",")}]`);
      } else out.unchanged.push(it.id);
    });
    writeJson(p.items, db);
  });
  return out;
}

/** What the user can set from the panel or CLI. `waiting` only comes back through Undo. */
export const USER_STATUSES = ["done", "dismissed", "snoozed", "open", "waiting"];

/** The user's write path: done | dismissed | snoozed | open (| waiting, to undo a close). */
export function userAction(id, status, { until, reason, by = "user" } = {}, home) {
  if (!USER_STATUSES.includes(status)) fail(`unknown action ${status}`);
  if (typeof id !== "string" || !id) fail("an item id is required");
  if (reason !== undefined && reason !== null && typeof reason !== "string") fail("reason must be a string");
  if (until !== undefined && until !== null && typeof until !== "string") fail("until must be an ISO date string");
  if (typeof by !== "string" || !by.trim()) fail("by must be a name");
  const p = paths(home);
  return withLock(p, () => {
    const db = loadDb(p);
    const cur = db.items[id] || fail(`no item ${id}`);
    const at = now();
    const snoozedUntil = status === "snoozed" ? (isoOrNull(until, "until") || fail("snooze needs an until time")) : null;
    cur.status = status;
    cur.snoozedUntil = snoozedUntil;
    // A reopened or snoozed item starts fresh, so a later close can't show the old reason.
    if (!USER_TERMINAL.has(status)) { cur.resolvedAt = null; cur.resolution = null; }
    if (USER_TERMINAL.has(status)) { cur.resolvedAt = at; cur.resolution = reason || cur.resolution || null; }
    cur.updatedAt = at; cur.lastChangedBy = by;
    pushHistory(cur, { by, change: status, reason: reason || undefined, until: cur.snoozedUntil || undefined });
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

/** One item, with an expired snooze shown as open, as everywhere else. */
export function getItem(id, home) {
  const item = loadDb(paths(home)).items[id] || fail(`no item ${id}`);
  return { ...item, status: effectiveStatus(item) };
}

/** Keep only real source names: runs that read nothing used to log "none" (or `true`). */
function cleanSources(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((s) => typeof s === "string").map((s) => s.trim().toLowerCase()).filter((s) => SOURCES.includes(s)))];
}

export function readRuns(home) {
  let text;
  try { text = fs.readFileSync(paths(home).runs, "utf8"); } catch { return []; }
  const runs = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    // Skip records the panel can't render, e.g. ones written before logRun checked types.
    if (!r || typeof r.run !== "string" || typeof r.summary !== "string" || typeof r.finishedAt !== "string") continue;
    runs.push({ ...r, sources: cleanSources(r.sources), errors: Array.isArray(r.errors) ? r.errors.filter((e) => typeof e === "string") : [] });
  }
  return runs;
}

export function logRun({ run, summary, started, sources = [], errors = [], thread = process.env.BB_THREAD_ID || null }, home) {
  if (typeof run !== "string" || !run.trim()) fail("run name is required");
  if (typeof summary !== "string" || !summary.trim()) fail("summary is required");
  if (started !== undefined && started !== null && typeof started !== "string") fail("started must be an ISO date string");
  if (!Array.isArray(sources)) fail("sources must be a list");
  if (!Array.isArray(errors) || errors.some((e) => typeof e !== "string")) fail("errors must be a list of strings");
  const p = paths(home);
  const entry = { run, startedAt: isoOrNull(started, "started"), finishedAt: now(), summary, thread, sources: cleanSources(sources), errors };
  withLock(p, () => {
    // A crash mid-append leaves a line with no newline; start on a fresh line so that torn
    // record doesn't swallow this one too.
    fs.appendFileSync(p.runs, (tornTail(p.runs) ? "\n" : "") + JSON.stringify(entry) + "\n");
  });
  return entry;
}

/** How an error line names a source, for "did this run read X cleanly". */
const SOURCE_WORDS = {
  slack: /slack/i, gmail: /gmail|e-?mail|\bmail|imap|himalaya/i, calendar: /calendar|caldav|khal|\bevents?\b/i,
  github: /github|\bgh\b/i, docs: /\bdocs?\b|drive/i, other: /$^/,
};
/** The latest run, of any name, that read `source` and reported no error naming it. */
export function lastGoodRun(source, home) {
  if (!SOURCES.includes(source)) fail(`source must be one of ${SOURCES.join("|")}`);
  const runs = readRuns(home);
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.sources.includes(source) && !r.errors.some((e) => SOURCE_WORDS[source].test(e))) return r;
  }
  return null;
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

const EPOCH = "1970-01-01T00:00:00.000Z";
/**
 * `last-run`: when the last run with this name that actually read a source finished. A run
 * that read nothing (expired token, tool missing) covered no window, so the next one must not
 * start after it.
 */
export function resolveSince(since, { run } = {}, home) {
  if (!since || since === "last-viewed") return getState(home).lastViewedAt || EPOCH;
  if (since === "last-run") {
    const runs = readRuns(home).filter((r) => (!run || r.run === run) && r.sources.length);
    return runs.length ? runs[runs.length - 1].finishedAt : EPOCH;
  }
  return isoOrNull(since, "since");
}

export function changes(since, home) {
  const p = paths(home);
  const out = { since, created: [], resolved: [], updated: [] };
  for (const i of Object.values(loadDb(p).items)) {
    const recent = (i.history || []).filter((h) => h.at > since);
    if (!recent.length) continue;
    const status = effectiveStatus(i);
    const brief = { id: i.id, title: i.title, status, changes: recent.map((h) => `${h.by}:${h.change}`) };
    // Closed wins over created: an item opened and closed in the window was closed in it
    // (Daily's "Closed today" reads `resolved`).
    if (CLOSED.has(status)) out.resolved.push(brief);
    else if (i.firstSeenAt > since) out.created.push(brief);
    else out.updated.push(brief);
  }
  return out;
}

// ---- Run Log effects ----
const STATUS_CHANGE = /(^|,)(status|resolved|reopened|snooze-expired)(,|$)/;
const USER_STATUS = new Set(["done", "dismissed", "snoozed", "open", "waiting"]);
const changesStatus = (h) => STATUS_CHANGE.test(h.change) || USER_STATUS.has(h.change);

/**
 * Items whose history records this run creating or resolving them, between its previous run
 * and this one. `runs` is newest first.
 */
export function runEffects(run, runs, items) {
  const prev = runs.find((r) => r.run === run.run && r.finishedAt < run.finishedAt);
  const from = run.startedAt ?? run.previousFinishedAt ?? prev?.finishedAt ?? "";
  const added = [];
  const resolved = [];
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

// ---- Housekeeping ----
/** An open FYI nobody touched for this long has served its purpose. */
export const FYI_TTL_DAYS = 3;
/** Closed items older than this move to items-archive.jsonl. */
export const ARCHIVE_AFTER_DAYS = 90;
/** runs.jsonl keeps this many records; older ones move to runs-archive.jsonl. */
export const MAX_RUNS = 5000;
const DAY = 86_400_000;

function housekeepPlan(db, at) {
  const atMs = Date.parse(at);
  const fyiCutoff = new Date(atMs - FYI_TTL_DAYS * DAY).toISOString();
  const archiveCutoff = new Date(atMs - ARCHIVE_AFTER_DAYS * DAY).toISOString();
  const plan = { snoozes: [], fyis: [], archive: [] };
  for (const i of Object.values(db.items)) {
    if (i.status === "snoozed" && i.snoozedUntil && i.snoozedUntil <= at) plan.snoozes.push(i.id);
    else if (i.kind === "fyi" && i.status === "open" && (i.updatedAt || i.firstSeenAt) < fyiCutoff) plan.fyis.push(i.id);
    else if (CLOSED.has(i.status) && (i.resolvedAt || i.updatedAt) < archiveCutoff) plan.archive.push(i.id);
  }
  return plan;
}

/**
 * Store upkeep the server runs on load and every few minutes. Writes only when there is work:
 * - an expired snooze becomes open, with a `snooze-expired` history entry, so the item comes
 *   back on time and its history says why;
 * - an open FYI untouched for FYI_TTL_DAYS is resolved as "aged out";
 * - closed items older than ARCHIVE_AFTER_DAYS move to items-archive.jsonl;
 * - runs.jsonl beyond MAX_RUNS records moves its oldest lines to runs-archive.jsonl.
 */
export function housekeep(home, at = now()) {
  const p = paths(home);
  const out = { snoozesExpired: [], fyisExpired: [], archivedItems: 0, archivedRuns: 0 };
  let db;
  try { db = loadDb(p); } catch { return out; }
  const peek = housekeepPlan(db, at);
  if (peek.snoozes.length || peek.fyis.length || peek.archive.length) {
    withLock(p, () => {
      const fresh = loadDb(p);
      const plan = housekeepPlan(fresh, at);
      for (const id of plan.snoozes) {
        const i = fresh.items[id];
        i.status = "open"; i.snoozedUntil = null; i.updatedAt = at; i.lastChangedBy = "pulse";
        pushHistory(i, { by: "pulse", change: "snooze-expired" });
        out.snoozesExpired.push(id);
      }
      for (const id of plan.fyis) {
        const i = fresh.items[id];
        i.status = "resolved"; i.resolvedAt = at; i.resolution = "aged out"; i.updatedAt = at; i.lastChangedBy = "pulse";
        pushHistory(i, { by: "pulse", change: "resolved", reason: `aged out after ${FYI_TTL_DAYS} days` });
        out.fyisExpired.push(id);
      }
      if (plan.archive.length) {
        fs.appendFileSync(p.itemsArchive, plan.archive.map((id) => JSON.stringify(fresh.items[id])).join("\n") + "\n");
        for (const id of plan.archive) delete fresh.items[id];
        out.archivedItems = plan.archive.length;
      }
      writeJson(p.items, fresh);
    });
  }
  let size = 0;
  try { size = fs.statSync(p.runs).size; } catch { /* no runs yet */ }
  // ~150 bytes a record: only count lines once the file could be over the cap.
  if (size > MAX_RUNS * 100) {
    withLock(p, () => {
      const lines = fs.readFileSync(p.runs, "utf8").split("\n").filter(Boolean);
      if (lines.length <= MAX_RUNS) return;
      const old = lines.slice(0, lines.length - MAX_RUNS);
      fs.appendFileSync(p.runsArchive, old.join("\n") + "\n");
      const tmp = `${p.runs}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, lines.slice(-MAX_RUNS).join("\n") + "\n");
      fs.renameSync(tmp, p.runs);
      out.archivedRuns = old.length;
    });
  }
  return out;
}

/**
 * Check the store files, and with `fix` repair what can be repaired: restore a torn items.json
 * or state.json from its .bak, drop a stale lock, and remove leftover temp files.
 */
export function doctor({ fix = false } = {}, home) {
  const p = paths(home);
  const report = { home: p.home, ok: true, checks: [], fixed: [] };
  const note = (ok, msg) => { report.checks.push(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) report.ok = false; };
  for (const file of [p.items, p.state]) {
    const name = path.basename(file);
    if (!fs.existsSync(file)) { note(true, `${name}: not created yet`); continue; }
    try { JSON.parse(fs.readFileSync(file, "utf8")); note(true, `${name}: parses`); continue; } catch (e) {
      let bakOk = false;
      try { JSON.parse(fs.readFileSync(file + ".bak", "utf8")); bakOk = true; } catch { /* none */ }
      note(false, `${name}: cannot parse (${e.message}); ${bakOk ? `${name}.bak is usable` : "no usable .bak"}`);
      if (fix && bakOk) { fs.copyFileSync(file + ".bak", file); report.fixed.push(`restored ${name} from ${name}.bak`); }
    }
  }
  try {
    const bad = fs.readFileSync(p.runs, "utf8").split("\n").filter((l) => { if (!l) return false; try { JSON.parse(l); return false; } catch { return true; } }).length;
    note(bad === 0, `runs.jsonl: ${bad ? `${bad} unreadable line(s), skipped when read` : "all lines parse"}`);
  } catch { note(true, "runs.jsonl: not created yet"); }
  if (fs.existsSync(p.lock)) {
    const ino = staleLock(p);
    note(ino === null, `.lock: ${ino === null ? "held by a live writer" : "stale"}`);
    if (fix && ino !== null && breakLock(p, ino)) report.fixed.push("removed a stale .lock");
  }
  const tmps = fs.existsSync(p.home) ? fs.readdirSync(p.home).filter((f) => f.endsWith(".tmp") || f === ".lock.break") : [];
  if (tmps.length) {
    note(false, `${tmps.length} leftover temp file(s)`);
    if (fix) {
      for (const f of tmps) {
        const full = path.join(p.home, f);
        try { if (Date.now() - fs.statSync(full).mtimeMs > 60_000) { fs.rmSync(full, { recursive: true, force: true }); report.fixed.push(`removed ${f}`); } } catch { /* gone */ }
      }
    }
  }
  return report;
}

/** How many Run Log rows the panel can page through. */
export const RECENT_RUNS = 50;

/** Everything the panel renders, in one read. */
export function snapshot(home) {
  const at = now();
  const all = listItems({ statuses: STATUSES, withHistory: true }, home);
  const cutoff = new Date(Date.now() - 3 * 86400_000).toISOString();
  const runs = readRuns(home);
  const lastRuns = {};
  // Each run carries when the previous same-name run finished, taken from the
  // full history, so the Run Log can scope a run's effects even when that
  // previous run is older than the recent slice.
  const withSince = runs.map((r) => {
    const out = { ...r, previousFinishedAt: lastRuns[r.run]?.finishedAt ?? null };
    lastRuns[r.run] = r;
    return out;
  });
  const items = all.filter((i) => !CLOSED.has(i.status) || (i.resolvedAt || i.updatedAt) > cutoff);
  const shown = new Set(items.map((i) => i.id));
  // Effects come from every item, not just the ones the board shows, so a run's row still lists
  // what it resolved after that item left the 3-day Closed window.
  const recent = withSince.slice(-RECENT_RUNS).reverse();
  const runItems = {};
  const recentRuns = recent.map((r) => {
    const { added, resolved } = runEffects(r, recent, all);
    for (const i of [...added, ...resolved]) if (!shown.has(i.id)) runItems[i.id] = { id: i.id, title: i.title, status: i.status };
    return { ...r, added: added.map((i) => i.id), resolved: resolved.map((i) => i.id) };
  });
  return {
    home: paths(home).home,
    generatedAt: at,
    lastViewedAt: getState(home).lastViewedAt || null,
    items,
    lastRuns,
    recentRuns,
    runItems,
    recovered: lastRecovery,
  };
}
