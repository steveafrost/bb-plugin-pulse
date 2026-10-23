## What you get

A panel in bb's nav rail listing what needs you from Slack, Gmail and Calendar, sorted into **Now** (high priority or due today), **Next** (due within three days), **Later** and **Nice to Know** (FYIs that need no action). Filter by source, and anything new since you last looked gets an outline.

The board is a mirror. Pulse on the iPhone captures and owns the data; this plugin renders the snapshot the app publishes and forwards your taps back to it. Section placement follows the app's own rules, so an item appears in the same section on both screens.

- **Your taps reach the phone.** Done, Snooze, Dismiss and Reopen append a command the app applies on its next pass. The row keeps its current status and gains a "Sent to iPhone" marker until the app acknowledges, because the phone owns content: a status flipped here could be wrong twice.
- **Quick actions.** Items arrive with up to three likely resolutions, such as "Decline meeting" or "Reply yes", the message already written. A click copies the text and opens the source. Nothing is ever sent for you.
- **Agent threads.** The robot button starts a Mac thread that does the work up to the point of review, such as drafting the weekly update someone asked for. The card shows Working, then Ready with the thread's one-line summary. These records are Mac-local and never enter the snapshot.

## How it works

Three files in the app's iCloud container, as `docs/DATA-CONTRACT.md` in the iOS repo specifies: the app writes `snapshot.json`, this plugin reads it and appends to `commands.jsonl`, and the app acknowledges in `commands.ack.jsonl`. The plugin watches the directory and polls every 5 seconds, reloading only when the snapshot's `generatedAt` moves, so a still phone costs nothing.

The reader tells four states apart: connected, not connected (no snapshot yet, so an empty board rather than an error), error (unreadable, keeping the last good board on screen), and update (a schema version this plugin predates, which it refuses to guess at).

Commands are fsynced as written and pruned once acknowledged, compacting the log past 5 MB or when every line is acked. An unacknowledged command stays in the pending count so a dropped write is visible rather than silent.

## Requirements

- Pulse on the iPhone, signed in and capturing. The plugin has no connectors of its own.
- The mirror directory: empty to use the app's iCloud container, or a folder you sync yourself.
- Optional: a project for agent threads (and for the legacy Mac schedules), your first name, house rules, and skill rules mapping installed skills to kinds of item.
- Legacy: earlier versions captured on the Mac with hourly, daily and weekly runs and a `pulse` CLI over a local item store. That code is retained behind **Capture runs → This Mac**, off by default, and refuses to write while a mirror is configured.
