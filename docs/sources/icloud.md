# iCloud Mail and Calendar

Read iCloud Mail and iCloud Calendar from Pulse on macOS or Linux, using open protocols over the
network. Verified against a live account on 2026-10-19.

## Why this works when local Apple apps don't

iCloud Mail is IMAP (`imap.mail.me.com:993`) and iCloud Calendar is CalDAV
(`caldav.icloud.com:443`). Both are ordinary network services.

That matters on macOS: reading the **local** stores (`~/Library/Mail`, `~/Library/Calendars`,
Group Containers) needs Full Disk Access, and driving Mail.app or Calendar.app over AppleScript
needs an Automation grant that bb's Node process cannot be given, because the Node binary ships
hardened without `com.apple.security.automation.apple-events`. The AppleEvent dies with `-1712`.
The network path needs neither permission, so it sidesteps the problem instead of fighting it.

## 1. Create an app-specific password

Two-factor authentication makes your normal Apple ID password unusable for IMAP and CalDAV. You need
an app-specific password:

1. Go to [appleid.apple.com](https://appleid.apple.com) › **Sign-In and Security** ›
   **App-Specific Passwords** › **Generate**.
2. Label it something recognisable, e.g. `pulse`.
3. Copy the password it shows you. Apple shows it once.

Store it on disk, not in the Pulse settings. For example:

```sh
mkdir -p ~/.config/pulse
chmod 700 ~/.config/pulse
cat > ~/.config/pulse/icloud.env <<'EOF'
ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
EOF
chmod 600 ~/.config/pulse/icloud.env
```

Both tools below read the password through a command at runtime, so the secret never appears in a
config file.

**Use your full Apple ID** (e.g. `you@example.com`), not an alias. CalDAV paths are keyed to the
full ID and aliases fail to resolve.

## 2. Mail — `himalaya`

```sh
brew install himalaya        # or: cargo install himalaya --features imap
```

`~/.config/himalaya/config.toml`:

```toml
[accounts.icloud]
default = true
email = "you@example.com"
display-name = "Your Name"

imap.server = "imaps://imap.mail.me.com:993"
imap.sasl.plain.username = "you@example.com"
imap.sasl.plain.password.command = "sh -c '. $HOME/.config/pulse/icloud.env; printf %s \"$ICLOUD_APP_PASSWORD\"'"

mailbox.alias.inbox = "INBOX"
mailbox.alias.sent = "Sent Messages"
mailbox.alias.drafts = "Drafts"
mailbox.alias.trash = "Deleted Messages"
mailbox.alias.archive = "Archive"
```

Verified reads:

```sh
himalaya envelope list   -m Archive -s 15 --json
himalaya envelope search -m Archive -s 15 --json "after 2026-10-16"
himalaya message read <ID>
```

JSON shape is `{"queued": N, "envelopes": [{id, message-id, flags[], subject, from[{name,email}],
to[], date, size, has-attachment}]}`.

### Trap 1 — flags must come before the query

The search query is a variadic argument. Anything after it is parsed as search text, so this fails:

```sh
himalaya envelope search -m Archive "after 2026-10-16" -s 15 --json   # ✗ parse error
himalaya envelope search -m Archive -s 15 --json "after 2026-10-16"   # ✓
```

### Trap 2 — iCloud auto-archives, so "unread" is a dead signal

If you use iCloud Mail's default behaviour, most mail is filtered into **Archive** and the inbox
stays nearly empty. A real account observed while writing this recipe:

| Folder | Messages | Unread |
| --- | --- | --- |
| INBOX | 1 | 0 |
| Archive | 25,039 | 0 |

A run that asks "what is unread" returns nothing, forever, and looks like a broken source. **Read by
recency instead**: `after <date>` over `Archive`, or a plain `envelope list -m Archive`. Search both
`INBOX` and `Archive`, and do not filter on `flag unseen`.

## 3. Calendar — `vdirsyncer` + `khal`

```sh
brew install vdirsyncer khal
```

`~/.config/vdirsyncer/config`:

```ini
[general]
status_path = "~/.local/share/vdirsyncer/status/"

[pair mypair]
a = "mycloud"
b = "mylocal"
collections = ["from a", "from b"]

[storage mycloud]
type = "caldav"
url = "https://caldav.icloud.com/"
username = "you@example.com"
password.fetch = ["command", "sh", "-c", ". $HOME/.config/pulse/icloud.env; printf %s \"$ICLOUD_APP_PASSWORD\""]

[storage mylocal]
type = "filesystem"
path = "~/.local/share/calendars/"
fileext = ".ics"
```

Then discover the calendars once and sync:

```sh
vdirsyncer discover mypair     # answer y to create the local collections
vdirsyncer -v ERROR sync mypair
```

`~/.config/khal/config`:

```ini
[calendars]
  [[personal]]
    path = ~/.local/share/calendars/<collection-id>/
    type = discover

[locale]
timeformat = %H:%M
dateformat = %Y-%m-%d
firstweekday = 0
```

Verified reads:

```sh
vdirsyncer -v ERROR sync mypair    # incremental, ~1-2s, safe to run before every run
khal list today 14d                # human-readable
khal list today 14d --json         # machine-readable
```

### Trap 3 — vdirsyncer 0.21 uses space-separated section names

Most guides online show dotted names. On 0.21 they are rejected with *"contains invalid
characters"*:

```ini
[storage mycloud]     # ✓ 0.21
[storage.mycloud]     # ✗ "contains invalid characters"
```

### Trap 4 — khal rejects some colour names

`color = dark yellow` fails validation on khal 0.14.1. Omit `color` and let it default to `auto`
(read from the vdir's `color` file) rather than guessing the palette.

## 4. The `sources` text

Paste this into **Settings › Plugins › Pulse › How agents reach Slack, Gmail and Calendar**,
replacing `<YYYY-MM-DD>` usage with a computed date at runtime:

```text
iCloud Mail: use the `himalaya` CLI. Recent mail lives in **Archive**, not INBOX — iCloud
auto-archives everything and there are typically 0 unread, so do NOT filter on unread. Read with
`himalaya envelope search -m Archive -s 15 --json "after <YYYY-MM-DD>"` for the last few days, or
`himalaya envelope list -m Archive -s 15 --json`. Put flags BEFORE the query string or they get
parsed as query text. Use `himalaya message read <ID>` for one body. Read only; never send, reply,
move, delete or flag anything.

iCloud Calendar: run `~/.config/pulse/icloud-cal-sync.sh` first (wrapping
`vdirsyncer -v ERROR sync mypair`; incremental, ~2s), then read with `khal list today 14d` (add
`--json` for machine-readable). Read only; never create, edit or delete events.

Use item IDs of the form `gmail:<root message-id>` for mail, where the root is the first id in the
message's `References` header (else `In-Reply-To`, else its own `Message-ID`), so every reply in a
thread updates the same item. Use `calendar:<event-uid>` for events. The prefixes keep the panel's
source filters meaningful.
```

## Rate limits

iCloud IMAP occasionally rate-limits. If reads suddenly fail while the credential is still valid,
wait and retry before you regenerate the password — and check that you are using the full Apple ID,
not an alias. Those two cause most "bad credentials" reports here.
