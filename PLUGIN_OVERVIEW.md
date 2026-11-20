## What you get

Pulse is a panel in the bb nav rail. It lists what needs you from Slack, Gmail and Calendar. It sorts items into **Now** (high priority or due today), **Next**, **Later** and **Nice to Know** (FYIs that need no action). You can filter by source. Pulse outlines anything new since you last looked.

- **Done, Snooze and Dismiss stick.** A later run never re-raises an item you handled. The exception is new activity, and the run must record why. Every action has an Undo. Closed items stay one click away from reopening. The board also works from the keyboard, and `?` lists the keys.
- **Quick actions.** Runs attach up to three likely resolutions per item, such as "Decline meeting" or "Reply yes", with the message already written. A click copies the text and opens the source. Pulse never sends anything for you.
- **Agent threads.** The robot button starts a thread that does the work up to the point of review, such as drafting a weekly update that someone asked for. The card shows Working, then Ready with the one-line summary of the thread.

## How it works

Pulse schedules three capture runs, each with its own cron.

- Hourly runs every two hours, 8 AM to 6 PM on weekdays.
- Daily runs at 4:30 PM on weekdays.
- Weekly runs on Friday at 3 PM.

Pulse skips an Hourly slot that is close to a Daily or Weekly run. Pulse catches up a run that was missed while bb was quit. Pulse retries a failed run once, then shows the failure in the run menu.

Each run sends a prompt to its own bb thread. Pulse creates the thread on the first run, in a "Pulse" sidebar section. The agent reads your sources and writes items into a small local store through a bundled CLI. The panel updates live while the run works. **Run now** and the run menu use the same path. You can pause each schedule from the menu.

Items carry stable source IDs, so a run updates an existing item and does not add a duplicate. Agents write only through the CLI. The CLI applies the same validation and sticky-state rules as the panel.

## Requirements

- Your agents need their own access to Slack, Gmail and Google Calendar, through MCP servers, CLIs or other plugins. Pulse has no connectors. Describe the tools in the settings. Every run and agent prompt includes that text.
- Pick a project for the threads in the settings. Runs call the bundled CLI from a shell, so the run thread needs permission to run commands.
- Optional settings: your first name, house rules for runs, a model and reasoning level, cron schedules, a time zone, a store directory, and skill rules that load your installed skills into agent threads.
- Every run is an agent turn on your provider. Each schedule uses your model quota.
