---
name: pulse
description: Read or update the Pulse item store (what needs the user from Slack, Gmail and Calendar) with the `pulse` CLI. Use when running a Pulse capture run, or when asked what Pulse flagged, to mark a Pulse item done, or to snooze one.
---

# Pulse

The Pulse panel renders an item store on disk (default `~/.config/pulse`, or the store directory
set in the plugin settings). Write only through the CLI; never edit its JSON.

**Running the CLI.** The plugin writes a launcher into its store when it loads, pinned to that
store: `~/.config/pulse/bin/pulse <command>` (with a custom store directory: `<store>/bin/pulse`;
if `$PULSE_HOME` is set, `$PULSE_HOME/bin/pulse`). Capture-run prompts give the exact command
instead. `pulse help` prints the full syntax; `pulse doctor` checks the store files.

- `pulse list`: open + waiting items, each with when a run last checked it. `pulse show <id>`: one
  item with its history. `pulse runs --limit 3`: recent capture runs.
- `pulse done <id> [--reason "…"]`, `pulse dismiss <id>`, `pulse snooze <id> --until <ISO>`,
  `pulse reopen <id>`: what the panel's buttons do. Dates are ISO 8601 with a time and offset.
- `pulse upsert --run <hourly|daily|weekly|manual>` with a JSON array on stdin. IDs are stable
  source IDs: `slack:<channel>/<thread_ts>`, `gmail:<threadId>`, `calendar:<eventId>`,
  `docs:<fileId>`, `github:<owner/repo>#<n>`.
- The panel groups action items into Now / Next / Later. `kind: "fyi"` items (announcements,
  decisions, context the user should know but needs no action on) go to **Nice to Know** and age
  out after 3 days. An item without `kind` defaults to `followup`.
- The user's done / dismissed state is sticky, and a snooze holds against anything but a resolve.
  Reopen only with `reopen: true` + `reason`.
- `quickActions` (max 3, `{label, text?, url?}`) render in the card's sparkle menu: copy `text` to
  the clipboard and open `url` (default: the item's https url). They never send anything.
- `pulse log --run <name> --summary "..." [--started <ISO>] [--sources slack,gmail,calendar]` at
  the end of every capture run; omit `--sources` when nothing was read.
- **Agent threads.** The panel's robot button hands an item to a new thread in the Pulse sidebar
  section. The item records `action: { threadId, status: running|ready|failed, startedAt,
  finishedAt, summary, seenAt }`; `pulse show <id>` prints it. Status follows the thread
  (idle → ready, error → failed); `summary` is its closing `Ready: …` line. Agent threads draft
  only: never send, post, or create Slack/Gmail drafts. Don't change `action` by hand.
