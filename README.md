# Pulse

A [bb](https://getbb.app) plugin that keeps a live board of what needs you from Slack, Gmail and
Calendar. Agent runs on a schedule read your sources and write structured items into a small local
store; the panel sorts them into **Now**, **Next**, **Later** and **Nice to Know**.

![Pulse board](screenshots/board.png)

[Watch the 72-second demo](https://github.com/steveafrost/bb-plugin-pulse/releases/download/v0.1.0/pulse-demo.mp4) (made-up data).

- **Plugin-owned schedules.** Hourly, Daily and Weekly capture runs, each in its own thread (created
  on the first run, in a "Pulse" sidebar section). **Run now** and the run menu use the same path;
  each run can be paused.
- **Sticky state.** Done, Dismiss and Snooze stick: a later run never re-raises an item unless it
  sees genuinely new activity and says why.
- **Quick actions.** Runs attach up to three one-click resolutions per item ("Decline meeting",
  "Reply yes"). A click copies the prepared text and opens the source. Nothing is ever sent for you.
- **Agent threads.** The robot button starts a thread that does the work up to the point of review
  ("draft the weekly update for X"), with the skills you map to that kind of item. The card shows
  Working, then Ready with the thread's one-line summary.

## Setup

1. Install, then open **Settings › Plugins › Pulse**.
2. Pick a **project** for the run and agent threads.
3. Say **how agents reach Slack, Gmail and Calendar** on your machine (MCP servers, CLIs or other
   plugins). Pulse has no connectors of its own; it relies on the tools your agents already have.
4. Optional: your first name, house rules, a model, schedules, and skill rules for agent threads
   (`skill-name | why | regex`, one per line).
5. `bb plugin reload pulse`, then press **Run now**.

Runs call the bundled CLI from a shell, so the run thread needs permission to run commands.

## Store and CLI

Items live in `$PULSE_HOME` (default `~/.config/pulse`, or the store directory setting):
`items.json`, `runs.jsonl`, `state.json`. Agents write only through the CLI
(`node bin/pulse.mjs help`); the server and CLI share `lib/store.mjs`, so the same validation
and sticky-state rules apply to both. The panel updates live as runs write.

## Develop

```sh
npm install
npm run typecheck && npm test && bb plugin build
bb plugin install "$PWD"
```

MIT licensed.
