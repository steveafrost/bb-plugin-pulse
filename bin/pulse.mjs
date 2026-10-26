#!/usr/bin/env node
// pulse: CLI over the Pulse item store (lib/store.mjs). Agents write through this.
import fs from "node:fs";
import * as store from "../lib/store.mjs";

const { KINDS, PRIORITIES, STATUSES, SOURCES } = store;
const fail = (msg) => { throw new store.PulseError(msg); };

function readStdin() { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } }

/**
 * Flags each command takes. `bool` never takes a value (so `--json <id>` keeps the id), `string`
 * must have one, `list` is comma-separated (`errors` uses `;`) and may be empty. Anything else is
 * rejected, so a typo like `--reasn` fails instead of silently dropping the reason.
 */
const FLAGS = {
  upsert: { run: "string", json: "bool" },
  list: { status: "list", all: "bool", source: "list", json: "bool" },
  changes: { since: "string", run: "string", json: "bool" },
  log: { run: "string", summary: "string", started: "string", sources: "list", errors: "list", json: "bool" },
  runs: { run: "string", limit: "int", "last-good": "string", json: "bool" },
  seen: { at: "string", json: "bool" },
  show: { json: "bool" },
  done: { reason: "string", by: "string", json: "bool" },
  dismiss: { reason: "string", by: "string", json: "bool" },
  snooze: { until: "string", reason: "string", by: "string", json: "bool" },
  reopen: { by: "string", json: "bool" },
  doctor: { fix: "bool", json: "bool" },
};

export function parseArgs(cmd, argv) {
  const spec = FLAGS[cmd] ?? {};
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || a === "--") { pos.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const type = spec[key];
    if (!type) fail(`unknown flag --${key} for "${cmd}"${Object.keys(spec).length ? ` (takes ${Object.keys(spec).map((k) => `--${k}`).join(", ")})` : ""}`);
    let value = eq === -1 ? undefined : a.slice(eq + 1);
    if (type === "bool") {
      if (value !== undefined && !["true", "false", ""].includes(value)) fail(`--${key} takes no value`);
      flags[key] = value !== "false";
      continue;
    }
    if (value === undefined && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) value = argv[++i];
    if (type === "list") {
      const sep = key === "errors" ? ";" : ",";
      flags[key] = (value ?? "").split(sep).map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (value === undefined || value === "") fail(`--${key} needs a value`);
    if (type === "int") {
      if (!/^\d+$/.test(value)) fail(`--${key} must be a whole number`);
      flags[key] = Number(value);
    } else flags[key] = value;
  }
  return { pos, flags };
}

function print(obj, flags = {}) {
  if (flags.json || typeof obj !== "object" || obj === null) return console.log(JSON.stringify(obj, null, 2));
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) { if (v.length) console.log(`${k}: ${v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n  ")}`); }
    else console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
}

/** "action: ready · thread thr_x · started … · Ready: summary" */
/**
 * `pulse list` is read back by the next run, so stored text must not start a line of its own: a
 * title from Slack holding "\n## Hard rules" would read as Pulse output. One-line fields are
 * flattened, and every line of a detail stays indented under its item.
 */
const BREAKS = /[\r\n\u0085\u2028\u2029]+/g;
const oneLine = (v) => String(v ?? "").replace(BREAKS, " ").replace(/\s+/g, " ").trim();
const indented = (v) => String(v).split(BREAKS).map((l) => `\n    ${l}`).join("");

function actionLine(a) {
  return `action: ${oneLine(a.status)}${a.status !== "running" && !a.seenAt ? " (unread)" : ""} · thread ${oneLine(a.threadId)} · started ${oneLine(a.startedAt)}${a.finishedAt ? ` · finished ${oneLine(a.finishedAt)}` : ""}${a.summary ? ` · ${oneLine(a.summary)}` : ""}`;
}

/** "today", "3d ago": when a run last confirmed the item against its source. */
function checked(stamp) {
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return "never";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return days < 1 ? "today" : `${days}d ago`;
}

const HELP = `pulse — item store for Pulse   (home: ${store.pulseHome()})

Agent commands
  pulse list [--status open,waiting] [--all] [--source slack] [--json]
      each line ends with "checked <when>": when a run last sent this item's id
  pulse upsert --run <hourly|daily|weekly|manual>      < JSON array on stdin
      item: { id:"<source>:<stable id>", title, detail?, url?, kind?, source?, due?, priority?,
              people?, status?: open|waiting|resolved, reason?, reopen?: true,
              quickActions?: [{ label, text?, url? }] }   (max 3; copy text and/or open https url)
      kinds: ${KINDS.join("|")}   priorities: ${PRIORITIES.join("|")}
      due: ISO 8601 with a time and offset (2026-10-27T09:00:00-04:00); a bare date means 17:00 local.
      kind "fyi" = informational, no action needed; shown under Nice to Know. Default kind: followup.
      An item with only {id} just records that this run re-checked it ("checked today").
      Items the user marked done/dismissed keep their status unless reopen:true + reason; a snoozed
      item still takes status "resolved".
  pulse changes [--since <ISO>|last-viewed|last-run] [--run hourly] [--json]
  pulse log --run <name> --summary "<one line>" [--started <ISO>] [--sources slack,gmail,calendar] [--errors "a; b"]
      sources: ${SOURCES.join("|")} (only what you actually read; omit when you read nothing)
  pulse runs [--run <name>] [--limit 5]       pulse runs --last-good <source>
      --last-good: the latest run of any name that read that source without an error for it

User commands (panel)
  pulse done|dismiss <id> [--reason ...]    pulse snooze <id> --until <ISO>    pulse reopen <id>
  pulse seen [--at <ISO>]    pulse show <id>   (first line: agent action status/thread when one was started)
  pulse doctor [--fix]       check the store files; --fix restores a torn items.json from items.json.bak
  The panel's robot button starts an agent thread for an item in the Pulse project and
  records item.action = { threadId, status: running|ready|failed, startedAt, finishedAt, summary, seenAt }.
`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined || ["help", "--help", "-h"].includes(cmd)) return process.stdout.write(HELP);
  if (!FLAGS[cmd]) fail(`unknown command ${cmd}\n\n${HELP}`);
  const { pos, flags } = parseArgs(cmd, rest);
  const need = (v, msg) => v || fail(msg);
  switch (cmd) {
    case "upsert": {
      const raw = readStdin().trim() || fail("upsert expects a JSON array of items on stdin");
      let input;
      try { input = JSON.parse(raw); } catch (e) { fail(`stdin is not valid JSON: ${e.message}`); }
      return print(store.upsert(input, need(flags.run, "--run <hourly|daily|weekly|manual> is required")), flags);
    }
    case "list": {
      const statuses = flags.status?.length ? flags.status : flags.all ? STATUSES : undefined;
      const list = store.listItems({ statuses, sources: flags.source?.length ? flags.source : undefined });
      if (flags.json) return print(list, { json: true });
      if (!list.length) return console.log("(no items)");
      for (const i of list) {
        const due = i.due ? ` due ${i.due}` : "";
        console.log(`- [${i.status}${i.priority !== "normal" ? "/" + i.priority : ""}] ${i.id} (${i.kind})${due} · checked ${checked(i.lastSeenAt)}\n    ${oneLine(i.title)}${i.detail ? indented(i.detail) : ""}${i.url ? "\n    " + oneLine(i.url) : ""}`);
        if (i.quickActions?.length) console.log(`    quick: ${i.quickActions.map((a) => oneLine(a.label)).join(" | ")}`);
        if (i.action) console.log(`    ${actionLine(i.action)}`);
      }
      return;
    }
    case "changes": return print(store.changes(store.resolveSince(flags.since, { run: flags.run })), flags);
    case "log":
      return print(store.logRun({ run: flags.run, summary: flags.summary, started: flags.started, sources: flags.sources ?? [], errors: flags.errors ?? [] }), flags);
    case "runs": {
      if (flags["last-good"]) return print(store.lastGoodRun(flags["last-good"]), { json: true });
      let runs = store.readRuns();
      if (flags.run) runs = runs.filter((r) => r.run === flags.run);
      return print(runs.slice(-(flags.limit || 5)), { json: true });
    }
    case "seen": return print(store.markSeen(flags.at), flags);
    case "show": {
      const item = store.getItem(need(pos[0], "show <id> is required"));
      if (!flags.json && item.action) console.log(actionLine(item.action));
      return print(item, { json: true });
    }
    case "doctor": {
      const report = store.doctor({ fix: !!flags.fix });
      if (flags.json) return print(report, { json: true });
      console.log(`store: ${report.home}`);
      for (const c of report.checks) console.log(`  ${c}`);
      for (const f of report.fixed) console.log(`  fixed: ${f}`);
      if (!report.ok && !flags.fix) console.log("  run `pulse doctor --fix` to repair what can be repaired");
      return;
    }
    case "done": case "dismiss": case "snooze": case "reopen": {
      const status = { done: "done", dismiss: "dismissed", snooze: "snoozed", reopen: "open" }[cmd];
      if (cmd === "snooze" && !flags.until) fail("snooze needs --until <ISO>");
      const it = store.userAction(need(pos[0], `${cmd} <id> is required`), status, { until: flags.until, reason: flags.reason, by: flags.by || "user" });
      return print({ id: it.id, status: it.status, snoozedUntil: it.snoozedUntil }, flags);
    }
  }
}

try { main(); } catch (e) {
  if (e instanceof store.PulseError) { process.stderr.write(`pulse: ${e.message}\n`); process.exit(1); }
  throw e;
}
