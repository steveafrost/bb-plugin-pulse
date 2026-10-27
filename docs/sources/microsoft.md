# Microsoft 365: Outlook mail and Teams calendar

Read Microsoft 365 mail and the Teams calendar from Pulse with `msteams-mcp`, an MCP server that
also ships a CLI.

Status: the CLI and its command surface are documented here; the **login step was not completed**
while writing this recipe, so treat the command output shapes below as expected rather than verified.
Corrections welcome.

## Install

```sh
npm install -g msteams-mcp@0.30.2
```

This installs `msteams`, which exposes `login`, `status`, `me`, `search`, `thread`, `channel`,
`email`, `meetings` and related reads, plus a set of write tools.

## Log in (interactive, once)

```sh
msteams login
```

SSO fails in headless mode by design, so this opens a **visible** Chrome window for you to sign in
with MFA. Leave it until it prints "Login completed successfully."

Session state lives in `~/.teams-mcp-server/` (`session-state.json`, `token-cache.json`) with a
dedicated browser profile in `~/.teams-mcp-server/browser-profile/`. Neither file exists before the
first login.

## Reads

```sh
msteams status                    # confirm the session is live
msteams me
msteams email    --json           # searches your M365 mailbox
msteams meetings --json           # Teams calendar
msteams search   --json "<query>"
```

## Trap — pre-login reads fail fast, and that is fine

Before you log in, reads exit immediately with `AUTH_REQUIRED`. That is a clean, cheap failure, so a
scheduled Pulse run can safely include this source and simply report the source as unavailable until
you complete the login. It will not hang or burn tokens.

## Trap — token refresh is headless-only

Otherwise, once logged in, the cached token refreshes without a browser. But if the refresh token
itself expires you must run `msteams login` again in a visible browser. For a scheduled board, expect
to redo this occasionally.

## Trap — there is no read-only flag

The CLI exposes roughly fourteen **write** tools (send, reply, react and so on) and gates them only
by prompt. Pulse's prompts forbid sending, but on this source that prohibition is doing more work
than usual. Write the `sources` text accordingly — enumerate the forbidden actions rather than
relying on "read only".

## The `sources` text

```text
Microsoft Teams and M365 mail: use the `msteams` CLI. Check `msteams status` first; if it fails with
AUTH_REQUIRED, skip this source and report it with --errors. Read mail with `msteams email --json`
and the Teams calendar with `msteams meetings --json`. Use `other:<id>` for these items unless you
have the raw message id for a `gmail:`-style prefix. READ ONLY: never send, reply, forward, react,
create drafts, schedule meetings, or call any messaging tool.
```

## Alternative — Graph API

If you would rather not run an MCP server, the Microsoft Graph API covers the same ground with an
app registration in Entra ID:

| Scope | Covers |
| --- | --- |
| `Mail.Read` | Mailbox read |
| `Calendars.Read` | Calendar read |

`GET https://graph.microsoft.com/v1.0/me/messages` and
`GET https://graph.microsoft.com/v1.0/me/events`. Both are read-only scopes, which matches Pulse's
needs better than the CLI's fourteen write tools. Registering the app requires tenant admin consent,
which is exactly the overhead `msteams-mcp` was chosen to avoid.
