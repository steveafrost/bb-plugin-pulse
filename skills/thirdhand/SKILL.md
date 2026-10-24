---
name: thirdhand
description: Read or update the Third Hand item store (what needs the user from Slack, Gmail and Calendar) with the `thirdhand` CLI. Use when running a Third Hand capture run, or when asked what Third Hand flagged, to mark a Third Hand item done, or to snooze one.
---

# Third Hand

The Third Hand panel renders an item store on disk (`$THIRDHAND_HOME`, default `~/.config/thirdhand`, or the
store directory set in the plugin settings). Write only through the CLI; never edit its JSON.

The CLI ships with the plugin at `../../bin/thirdhand.mjs` relative to this file. Run it as
`node <that path> <command>` (capture-run prompts give the exact command, including `THIRDHAND_HOME`).
`thirdhand help` prints the full syntax.

- `thirdhand list`: open + waiting items. `thirdhand runs --limit 3`: recent capture runs.
- `thirdhand upsert --run <hourly|daily|weekly|manual>` with a JSON array on stdin. IDs are stable
  source IDs: `slack:<channel>/<thread_ts>`, `gmail:<threadId>`, `calendar:<eventId>`,
  `docs:<fileId>`, `github:<owner/repo>#<n>`.
- The panel groups action items into Now / Next / Later. `kind: "fyi"` items (announcements,
  decisions, context the user should know but needs no action on) go to **Nice to Know**:
  one-line title, short detail, url. Skip pure noise. An item without `kind` defaults to `followup`.
- The user's done / dismissed / snoozed state is sticky. Reopen only with `reopen: true` + `reason`.
- `quickActions` (max 3, `{label, text?, url?}`) render in the card's sparkle menu: copy `text` to
  the clipboard and open `url` (default: item url). They never send anything. `url` must be https.
- `thirdhand log --run <name> --summary "..."` at the end of every capture run.
- **Agent threads.** The panel's robot button hands an item to a new thread in the Third Hand sidebar
  section. The item records `action: { threadId, status: running|ready|failed, startedAt,
  finishedAt, summary, seenAt }`; `thirdhand show <id>` prints it. Status follows the thread
  (idle → ready, error → failed); `summary` is its closing `Ready: …` line. Agent threads draft
  only: never send, post, or create Slack/Gmail drafts. Don't change `action` by hand.
