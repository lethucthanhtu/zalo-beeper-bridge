# Bot commands

The bridge bot (`@sh-zalobot:beeper.local` for a bridge registered as `sh-zalo`) is how you control the bridge. Start a chat with it in Beeper; it joins as soon as **you** (the configured `owner`) invite it and replies with its command list:

```
sh-zalo bridge bot ready. Commands: ping | login | logout | status | sync | accounts | media-failures
```

Commands are case-insensitive. Messages from anyone other than the owner are ignored.

| Command                             | What it does                                                               |
| ----------------------------------- | -------------------------------------------------------------------------- |
| [`ping`](#ping)                     | Health check. Answers `pong!` with the uptime.                             |
| [`login`](#login)                   | Starts a QR login to Zalo.                                                 |
| [`logout`](#logout)                 | Logs out of Zalo and deletes the saved session.                            |
| [`status`](#status)                 | Shows uptime, Zalo login state and listener state.                         |
| [`sync`](#sync)                     | Creates rooms for pinned chats and every group and fills empty rooms.      |
| [`accounts`](#accounts)             | Lists the Zalo accounts this bridge has logged in to. Read-only.           |
| [`media-failures`](#media-failures) | Lists rooms with photos or files that arrived only as a notice. Read-only. |

## `ping`

```
pong! uptime 76h 12m 5s
```

Use it to check that Beeper, `bbctl proxy` and the appservice are all connected. No answer means one of them is down; see [Troubleshooting](../troubleshooting).

## `login`

1. The bot posts `Generating Zalo QR — scan it with the Zalo app, then confirm on your phone.` followed by the QR image.
2. Scan it in the Zalo phone app and confirm.
3. On success: `✓ Logged in to Zalo (uid …), listener started.` On failure the bot posts `Zalo login failed: <reason>`.

If a session is already active the bot refuses with `Already logged in to Zalo … Use 'logout' first to switch.` The session is saved encrypted, so after a restart the bridge logs in again by itself (`[zalo] re-logged in from saved credentials`). You only need `login` again when the session expires or Zalo ends it.

## `logout`

Stops the listener, ends the session on Zalo's servers and deletes the saved session file. Beeper then shows the account as logged out. Existing rooms and the database stay; log in again with `login`.

If Zalo does not confirm the logout within 15 seconds (for example, the network is down), the bridge still logs out locally and says so in its reply. The session may then still be listed under logged-in devices in the Zalo app; remove it there.

## `status`

```
bridge uptime: 76h 12m 5s
zalo: logged in (uid 1111111111111111111)
listener: connected
```

`listener` is `connected`, `reconnecting`, `dead` or `stopped`. `dead` means the listener gave up after repeated failures; send `login` again (see [How it works](./how-it-works#listener-and-reconnects)).

## `sync`

Creates a portal room for every **pinned** chat and every **group** you are in, invites and joins you to them, and fills rooms that are still empty with the recent history Zalo gives this session. It ends with a summary like:

```
Sync done: 52/52 pinned/group conversations ensured (4 pinned, 48 groups).
```

- It is paced (1.5 s between steps) to avoid bursts of API calls on your account: about 50 groups take 2 minutes.
- History is limited to what Zalo serves a web session, which is nothing from before the login. Use the [history importer](../history-import/) for older messages.
- Old messages are never inserted into a room that already has messages, so `sync` is safe to run again.
- DMs that are not pinned get their room when the first message arrives.

## `accounts`

Lists every Zalo account this bridge has logged in to, with the last login time (UTC), and marks the current one:

```
Zalo accounts:
● 1111111111111111111 — last login 2026-11-01 08:30 UTC (logged in, listener connected)
○ 2222222222222222222 — last login 2026-10-20 14:05 UTC
```

It is read-only. One bridge serves one Zalo account at a time; see [Multiple accounts](./multiple-accounts).

## `media-failures`

When the bridge cannot download a photo or file, even after trying the photo's HD and thumbnail links and retrying network errors once, it posts `[Zalo photo could not be bridged: …]` in the room and records the message. This command lists the rooms that still have such notices:

```
Media that reached Matrix only as a notice (3 in 2 room(s)):
• Family — 2 photo, last 2026-11-20 09:14 UTC (thread 1234567890)
• Work — 1 file, last 2026-11-21 16:02 UTC (thread 9876543210)
1 of them are still being retried automatically (up to about an hour).
To repair the rest: rebuild the chat with the history importer and --media-dir ...
```

The bridge first retries each failure on its own, 2, 15 and 60 minutes after it happened (the later tries fetch the message from Zalo again for fresh links). A repaired file is posted at the end of the room's timeline and the notice is removed. After a restart, failures from the last 7 days are retried again. Zalo only serves a group's newest 200 messages and about a week of a DM, so older failures stay on the list.

To repair a room by hand, rebuild it with the [history importer](../history-import/manual) and `--media-dir` pointing at the Zalo PC media folder: the rebuild replaces each notice with the real file. A room leaves the list once it is rebuilt or deleted. It is read-only.
