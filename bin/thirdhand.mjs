#!/usr/bin/env node
// thirdhand: CLI over the Third Hand item store (lib/store.mjs). Agents write through this.
import fs from "node:fs";
import * as store from "../lib/store.mjs";

const { KINDS, PRIORITIES, STATUSES } = store;

function readStdin() { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } }

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
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
function actionLine(a) {
  return `action: ${a.status}${a.status !== "running" && !a.seenAt ? " (unread)" : ""} · thread ${a.threadId} · started ${a.startedAt}${a.finishedAt ? ` · finished ${a.finishedAt}` : ""}${a.summary ? ` · ${a.summary}` : ""}`;
}

const HELP = `thirdhand — item store for Third Hand   (home: ${store.thirdhandHome()})

Agent commands
  thirdhand list [--status open,waiting] [--all] [--source slack] [--json]
  thirdhand upsert --run <hourly|daily|weekly|manual>      < JSON array on stdin
      item: { id:"<source>:<stable id>", title, detail?, url?, kind?, source?, due?, priority?,
              people?, status?: open|waiting|resolved, reason?, reopen?: true,
              quickActions?: [{ label, text?, url? }] }   (max 3; copy text and/or open https url)
      kinds: ${KINDS.join("|")}   priorities: ${PRIORITIES.join("|")}
      kind "fyi" = informational, no action needed; shown under Nice to Know. Default kind: followup.
      Items the user marked done/dismissed/snoozed keep their status unless reopen:true + reason.
  thirdhand changes [--since <ISO>|last-viewed|last-run] [--run hourly] [--json]
  thirdhand log --run <name> --summary "<one line>" [--sources slack,gmail,calendar] [--errors "a; b"]
  thirdhand runs [--run <name>] [--limit 5]
  thirdhand draft --kind weekly < markdown       |  thirdhand draft latest [--kind weekly]

User commands (panel)
  thirdhand done|dismiss <id> [--reason ...]    thirdhand snooze <id> --until <ISO>    thirdhand reopen <id>
  thirdhand seen [--at <ISO>]    thirdhand show <id>   (first line: agent action status/thread when one was started)
  The panel's robot button starts an agent thread for an item in the Third Hand project and
  records item.action = { threadId, status: running|ready|failed, startedAt, finishedAt, summary, seenAt }.
`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const need = (v, msg) => v || (() => { throw new store.ThirdHandError(msg); })();
  switch (cmd) {
    case "upsert": {
      const raw = readStdin().trim() || need("", "upsert expects a JSON array of items on stdin");
      let input;
      try { input = JSON.parse(raw); } catch (e) { throw new store.ThirdHandError(`stdin is not valid JSON: ${e.message}`); }
      return print(store.upsert(input, need(flags.run, "--run <hourly|daily|weekly|manual> is required")), flags);
    }
    case "list": {
      const statuses = flags.status ? String(flags.status).split(",") : flags.all ? STATUSES : undefined;
      const list = store.listItems({ statuses, sources: flags.source ? String(flags.source).split(",") : undefined });
      if (flags.json) return print(list, { json: true });
      if (!list.length) return console.log("(no items)");
      for (const i of list) {
        const due = i.due ? ` due ${i.due}` : "";
        console.log(`- [${i.status}${i.priority !== "normal" ? "/" + i.priority : ""}] ${i.id} (${i.kind})${due}\n    ${i.title}${i.detail ? "\n    " + i.detail.replace(/\n/g, "\n    ") : ""}${i.url ? "\n    " + i.url : ""}`);
        if (i.quickActions?.length) console.log(`    quick: ${i.quickActions.map((a) => a.label).join(" | ")}`);
        if (i.action) console.log(`    ${actionLine(i.action)}`);
      }
      return;
    }
    case "changes": return print(store.changes(store.resolveSince(flags.since, { run: flags.run })), flags);
    case "log":
      return print(store.logRun({
        run: flags.run, summary: flags.summary, started: flags.started,
        sources: flags.sources ? String(flags.sources).split(",") : [],
        errors: flags.errors ? String(flags.errors).split(";").map((s) => s.trim()).filter(Boolean) : [],
      }), flags);
    case "runs": {
      let runs = store.readRuns();
      if (flags.run) runs = runs.filter((r) => r.run === flags.run);
      return print(runs.slice(-(Number(flags.limit) || 5)), { json: true });
    }
    case "draft": {
      const kind = flags.kind || "weekly";
      if (pos[0] === "latest") { const d = store.latestDraft(kind); return d ? process.stdout.write(d.body) : console.log("(no drafts)"); }
      return print(store.saveDraft(readStdin(), { kind, date: flags.date }), flags);
    }
    case "seen": return print(store.markSeen(flags.at), flags);
    case "show": {
      const item = store.getItem(need(pos[0], "show <id> is required"));
      if (!flags.json && item.action) console.log(actionLine(item.action));
      return print(item, { json: true });
    }
    case "done": case "dismiss": case "snooze": case "reopen": {
      const status = { done: "done", dismiss: "dismissed", snooze: "snoozed", reopen: "open" }[cmd];
      const it = store.userAction(need(pos[0], `${cmd} <id> is required`), status, { until: flags.until, reason: flags.reason, by: flags.by || "user" });
      return print({ id: it.id, status: it.status, snoozedUntil: it.snoozedUntil }, flags);
    }
    case undefined: case "help": case "--help": case "-h": return process.stdout.write(HELP);
    default: throw new store.ThirdHandError(`unknown command ${cmd}\n\n${HELP}`);
  }
}

try { main(); } catch (e) {
  if (e instanceof store.ThirdHandError) { process.stderr.write(`thirdhand: ${e.message}\n`); process.exit(1); }
  throw e;
}
