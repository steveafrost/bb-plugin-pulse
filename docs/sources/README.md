# Source recipes

Pulse has **no connectors**. Each capture run hands the agent whatever text you put in
**Settings › Plugins › Pulse › How agents reach Slack, Gmail and Calendar**, and the agent uses the
CLIs, MCP servers and plugins already installed on your machine.

That text is the whole integration. These recipes are tested, copy-pasteable versions of it for
specific providers, so you don't have to work out the tooling and the traps yourself.

| Recipe | Mail | Calendar |
| --- | --- | --- |
| [iCloud](icloud.md) | IMAP via `himalaya` | CalDAV via `vdirsyncer` + `khal` |
| Google Workspace | `gcloud auth application-default login --scopes=…` | same token | 
| Microsoft 365 / Teams | `msteams-mcp` | Teams calendar via the same CLI |

Contributions welcome — see [Contributing a recipe](#contributing-a-recipe).

## Rules every `sources` text should follow

These apply no matter which tools you name.

1. **Say "read only" explicitly, and list the verbs.** Pulse is a triage board; nothing should ever
   be sent, posted, reacted to, flagged, moved or deleted. Name the forbidden verbs rather than
   trusting a generic "read only".
2. **Tell the agent what to do when a source is down.** The standard tail is:
   `If a source is unavailable, skip it and report it with --errors.` Without it, a run tends to
   invent plausible items instead of reporting the failure.
3. **Describe the window to read**, in the tool's own terms. Pulse already tells the agent to use
   "since the last run of this name, with a small overlap", but tool-specific hints help — especially
   when the obvious query doesn't work (see iCloud's auto-archive trap below).
4. **Use the source ID prefixes the panel expects.** Item IDs must look like `<source>:<stable-id>`
   and the prefix decides the `source` filter chip:

   | Prefix | Panel chip | Use for |
   | --- | --- | --- |
   | `slack:` | Slack | Slack messages and threads |
   | `gmail:` | Gmail | **Any** email, including non-Google providers |
   | `calendar:` | Calendar | Any event, any provider |
   | `github:` | GitHub | Issues and PRs |
   | `docs:` | Docs | Documents |
   | `<anything else>:` | Other | Everything else |

   Any prefix outside the list still validates, but the item lands under **Other**. That is why
   iCloud mail below uses `gmail:` even though it is not Gmail: it keeps the chip meaningful.
5. **Give the stable ID, not a random one.** Stability is what stops a run from re-raising an item
   you already handled. Use the provider's own identifier — an IMAP `message-id`, a CalDAV event
   `UID`, a Slack `thread_ts`, not a hash of the subject line.

## Contributing a recipe

A recipe is one Markdown file under `docs/sources/` plus a row in the table above. Include:

- what you installed and where the credential lives **on disk** (never the credential itself);
- the exact read commands you verified, with real flags;
- the traps — every recipe here has at least one thing that fails silently or confusingly;
- a ready-to-paste `sources` text at the end.

Verify each command actually returns data before submitting. A recipe that only looks correct is
worse than none.
