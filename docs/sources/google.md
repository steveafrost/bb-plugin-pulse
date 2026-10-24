# Google Workspace (Gmail and Calendar)

Read Gmail and Google Calendar from Third Hand with a `gcloud` Application Default Credentials file, then
call the REST APIs directly.

This recipe exists mostly because the obvious approach **does not work** — see the trap below before
you spend time on it.

## Verification status

Be aware of what has actually been run versus read off documentation, since a recipe that only looks
correct is worse than none.

| Claim | Status |
| --- | --- |
| `gcloud auth login` has no `--scopes` flag; a token from it gets `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` on Gmail/Calendar | Verified |
| `gcloud auth application-default login` accepts `--scopes` and writes a separate ADC credential | Verified via `--help` |
| `calendar.readonly` deprecation for new clients | Reported, not verified here |
| The `curl` endpoints and query parameters below | Standard documented API surface, not run against a live account while writing this |

## Trap — `gcloud auth login` cannot carry Gmail or Calendar scopes

`gcloud auth login` gives you a token with a hardcoded scope set (`CLOUDSDK_SCOPES`) and has no
`--scopes` flag. A token minted that way is rejected by both APIs:

```
HTTP 403  ACCESS_TOKEN_SCOPE_INSUFFICIENT
```

You cannot widen it after the fact. Anything that tells you to "log in with gcloud and call the
Gmail API" is missing this step.

## What works — Application Default Credentials with explicit scopes

```sh
gcloud auth application-default login \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/gmail.readonly
```

This writes a **separate** ADC credential (`~/.config/gcloud/application_default_credentials.json`)
and leaves your existing `gcloud` login untouched, so it cannot break anything else that uses gcloud.

Swap in whichever scopes you need:

| Scope | Covers |
| --- | --- |
| `https://www.googleapis.com/auth/gmail.readonly` | Gmail read |
| `https://www.googleapis.com/auth/calendar.readonly` | Calendar read |

### Note — `calendar.readonly` may be rejected for new OAuth clients

Google maintains a server-side `_DEPRECATED_SCOPES` list, and `calendar.readonly` has been reported
as being on it for newly created OAuth clients. If that applies to you, the login fails and you need
to supply your own OAuth client ID:

```sh
gcloud auth application-default login \
  --client-id-file=/path/to/client_secret.json \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/calendar.readonly
```

`gmail.readonly` was not on that list when this was written, so mail-only is the safer starting
point. Verify the current status in Google's OAuth scope documentation before relying on Calendar.

## Reading with plain HTTP

With ADC in place, get a token and call the API. Neither the Gmail nor the Calendar REST read needs
anything beyond `curl`:

```sh
TOKEN=$(gcloud auth application-default print-access-token)

# Gmail: recent inbox messages
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=in:inbox%20newer_than:2d"

# Calendar: upcoming events
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=$(date -u +%Y-%m-%dT%H:%M:%SZ)&maxResults=15&singleEvents=true&orderBy=startTime"
```

Use the Gmail `threadId` for stable IDs so a re-run updates the existing item rather than adding a
duplicate.

## The `sources` text

```text
Gmail: call the Gmail REST API with an access token from
`gcloud auth application-default print-access-token` (Application Default Credentials, not
`gcloud auth login` — that token lacks Gmail scopes). List recent mail with
`GET https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=in:inbox newer_than:2d`
and read a message by id. Use `gmail:<threadId>` for item IDs. Read only; never send, reply, label,
delete, archive or modify anything.

Google Calendar: same access token, `GET
https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=<now>&maxResults=15&singleEvents=true&orderBy=startTime`.
Use `calendar:<eventId>` for item IDs. Read only; never create, edit, move or delete events.

If a source is unavailable, skip it and report it with --errors.
```

## Notes

- ADC tokens expire after about an hour and refresh automatically **only** when a client library
  refreshes them. A `print-access-token` call mints a fresh one each time, which is fine for a
  scheduled run.
- Do not use `gcloud auth revoke` to "clean up" — it can sign out your primary gcloud login for the
  project. Remove ADC specifically if you need to:
  `rm ~/.config/gcloud/application_default_credentials.json`
