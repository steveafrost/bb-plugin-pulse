/**
 * The three Pulse capture prompts. server.ts sends them to the run threads on
 * its own schedules. The shared body is identical for every run so the store
 * rules cannot drift between Hourly, Daily and Weekly. Everything specific to
 * one person (name, how to reach each source, house rules) comes from settings.
 */
export type RunName = "hourly" | "daily" | "weekly";

export interface PromptContext {
  /** Shell command that runs the Pulse CLI, e.g. `node "/path/bin/pulse.mjs"`. */
  cli: string;
  /** Who Pulse works for: a first name, or "the user". */
  user: string;
  /** IANA time zone for dates in the prompt. */
  timeZone: string;
  /** Directory holding one memory file per run. */
  memoryDir: string;
  /** How to reach Slack, Gmail and Calendar on this machine. */
  sources: string;
  /** Extra house rules, appended verbatim. */
  instructions: string;
}

export const DEFAULT_SOURCES =
  "Use whatever Slack, Gmail and Google Calendar tools you have (MCP servers, CLIs or plugins). Read only; never send, post, react or create drafts. If a source is unavailable, skip it and report it with --errors.";

function body(c: PromptContext): string {
  const u = c.user;
  return `
## Pulse item store (source of truth)
State lives in the Pulse store, not in prose. In this prompt \`pulse\` means: \`${c.cli}\`. Use that full command in every shell call (run \`pulse help\` once if unsure). Never edit its JSON files directly.
1. Start: \`pulse list\` (open + waiting items) and \`pulse runs --limit 3\` (what prior runs covered). Read the run memory file listed below for tool tips only.
2. Gather Slack, Gmail and Calendar. ${c.sources.trim()} Window: since the last run with this run name (from \`pulse runs\`), with a small overlap.
3. Write back with one \`pulse upsert --run <name>\` call (JSON array on stdin):
   - New thing that needs ${u} -> new item. IDs must be stable source IDs: \`slack:<channel>/<thread_ts>\`, \`gmail:<threadId>\`, \`calendar:<eventId>\`, \`docs:<fileId>\`, \`github:<owner/repo>#<n>\`.
   - kind: reply | decision | rsvp | conflict | deadline | review | followup | fyi. Use \`fyi\` only for things ${u} needs no action on but would want to know (announcements, decisions made without them, org/project changes, useful context); they show under Nice to Know. For \`fyi\`: \`title\` is one line saying what happened, \`detail\` one short sentence, include \`url\`, no \`due\`/\`priority\`. Set \`due\` (ISO) when there is a real deadline or meeting time; \`priority: high\` only for same-day or blocking items.
   - \`title\` is one short line saying what ${u} must do; \`detail\` is 1-2 sentences of context; always include \`url\` when one exists.
   - Calendar items: set \`url\` to the event's web link (\`htmlLink\`) so ${u} can open it.
   - \`quickActions\` (max 3) on every actionable, non-\`fyi\` item you create or change, and on open items that \`pulse list\` shows without a \`quick:\` line. Each is \`{"label", "text"?, "url"?}\`: clicking copies \`text\` to the clipboard and opens \`url\` (default: the item's url). Nothing is ever sent; ${u} pastes and sends.
     - \`label\`: 2-3 words naming the resolution, e.g. "Decline meeting", "Accept invite", "Send reminder", "Reply yes", "Ask for ETA", "Share notes".
     - \`text\`: the exact message ${u} would paste, in their voice: short, plain, friendly, no greeting fluff, no sign-off, under 300 chars. Omit \`text\` when the action is only opening something (e.g. "Open event" to RSVP), and skip an open-only action that just repeats the item's own link.
     - Pick the 1-3 most likely resolutions for this specific item (e.g. a conflict: "Decline meeting" with a short decline note, plus "Send notes ahead"). Omit \`quickActions\` when there is no obvious one-click resolution.
   - Existing item that cleared -> \`{"id", "status":"resolved", "reason"}\`. Item now waiting on someone else -> \`status: "waiting"\`.
   - ${u}'s done / dismissed / snoozed state is sticky; only send \`reopen: true\` with a \`reason\` if there is genuinely new activity that needs them.
   - Skip pure noise (bots, newsletters, routine sign-in notices, social chatter, things ${u} already saw or replied to) entirely. If unsure whether something is useful context or noise, skip it.
4. Finish: \`pulse log --run <name> --summary "<one line>" --sources slack,gmail,calendar [--errors "..."]\`. Then append one dated line (${c.timeZone}) to the run memory file only if you learned a reusable tool tip or hit a source failure.`;
}

interface RunSpec { header: string; memoryNote?: string; extra?: string; reply?: string }

function runs(c: PromptContext): Record<RunName, RunSpec> {
  const u = c.user;
  return {
    hourly: {
      header: "Hourly Pulse: report only what changed since the previous Hourly Pulse run.",
      reply: `## Reply format (this thread is a log; the Pulse panel shows full state)
- If nothing was created, resolved or materially changed: reply with exactly one line, e.g. "No changes since 14:00." Nothing else.
- Otherwise list only the deltas, max ~8 bullets: **New**, **Resolved**, **Changed** (one line each, with link). Do not restate unchanged open items; end with "N open items" from \`pulse list\`.`,
    },
    daily: {
      header: "Daily Pulse (end of day): close out today and prepare tomorrow.",
      extra: `Extra for this run: look at the whole day (not just since the last Hourly run), reconcile every open item (resolve anything that is stale or already handled), and look ahead at the next working day's calendar: add rsvp/conflict items for unanswered invites and overlaps, and a \`followup\` item only for prep ${u} must do before a meeting.`,
      reply: `## Reply format
1. **Still needs you** (from \`pulse list\` after your upsert, highest priority first, one line each with link).
2. **Closed today** (from \`pulse changes --since <today 00:00 ${c.timeZone}>\` resolved/done).
3. **Tomorrow** (next working day): meetings that matter, conflicts, prep.
Keep it under ~20 lines.`,
    },
    weekly: {
      header: `Weekly Pulse: look back over the past 7 days of email, Slack and calendar activity. Two jobs: (1) catch anything the Hourly and Daily runs missed or let go stale, and (2) post a short summary in this thread of what happened this week.`,
      memoryNote: " (read it for prior-week context and tool tips)",
      extra: `Extra for this run:
- Window is the past 7 days (not just since the last run). Look for threads where someone is still waiting on ${u}, commitments ${u} made ("I'll…", "will do") that have no follow-through, decisions that landed, and upcoming deadlines or meetings next week that need prep. Reconcile open items: resolve ones that have cleared, and add ones that slipped through.
- Then post a summary of the week in this thread: what happened (key conversations, decisions, shipped or merged work), what is still open, and what is coming up next week. Keep it scannable: short headed sections with bullets and links. It is for ${u} only; never offer to send it or create a Slack/Gmail draft.
- Append a short dated context line to the run memory file so next week has continuity.`,
    },
  };
}

export function runPrompt(name: RunName, c: PromptContext): string {
  const r = runs(c)[name];
  const extra = c.instructions.trim();
  return [
    r.header,
    body(c),
    `Run name: ${name}. Run memory file: ${c.memoryDir}/${name}.md${r.memoryNote ?? ""}.`,
    ...(r.extra ? [r.extra] : []),
    ...(extra ? ["", "## House rules", extra] : []),
    ...(r.reply ? ["", r.reply] : []),
  ].join("\n");
}
