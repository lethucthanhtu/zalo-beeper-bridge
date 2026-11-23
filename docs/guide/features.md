# Features

## Support matrix

| Area                               |                       Zalo → Beeper                        |               Beeper → Zalo                |
| ---------------------------------- | :--------------------------------------------------------: | :----------------------------------------: |
| Text (DM + group)                  |                    ✅ (incl. rich text)                    |                     ✅                     |
| @mentions                          |                         ✅ (pills)                         |                     ✅                     |
| Replies / quotes                   |                             ✅                             |                     ✅                     |
| Photos                             |                             ✅                             |                     ✅                     |
| Stickers                           |  ✅ animated (`m.sticker`, WebP built from Zalo's sprite)  |                     —                      |
| GIFs                               |                             ✅                             |                     —                      |
| Videos                             |                       ✅ (`m.video`)                       |                     ✅                     |
| Files                              |                       ✅ (`m.file`)                        |                     ✅                     |
| Voice messages                     |                 ✅ (`m.audio` voice note)                  | ✅ voice note (ogg/opus re-encoded to AAC) |
| Link cards                         |               ✅ text + Beeper link preview                |      ✅ Zalo builds its own link card      |
| Locations                          | ✅ `m.location` (map preview, opens the device's maps app) |                     —                      |
| Contact cards (danh thiếp)         |       ✅ QR code + name, phone and a `zalo.me` link        |                     —                      |
| Web cards (`chat.webcontent`)      |               ✅ text (title + description)                |                     —                      |
| Call logs (voice / video, missed)  |     ✅ Beeper call tile (`com.beeper.action_message`)      |                     —                      |
| Pinned messages                    |       ✅ pinned in the room (`m.room.pinned_events`)       |                     —                      |
| Polls (groups only)                |              ✅ MSC3381 poll, votes mirrored               |            ✅ create, vote, end            |
| System lines (joins, leaves, ...)  |               ✅ notice from the bridge bot                |                     —                      |
| Reactions                          |                             ✅                             |                     ✅                     |
| Message recall                     |                  ✅ removed in Beeper too                  |                     ✅                     |
| Deleted "for me" on another device |                  ✅ removed in Beeper too                  |                     —                      |
| Read receipts                      |                             ✅                             |   ✅ (follows Beeper's receipt setting)    |
| Typing indicators                  |                             ✅                             |    ✅ (follows Beeper's typing setting)    |
| Own messages sent from the phone   |                    ✅ (double-puppeted)                    |                    n/a                     |
| End-to-end encrypted Zalo chats    |             notice only (cannot be decrypted)              |                     —                      |

Also included:

- Ghost users with real Zalo names and avatars, refreshed in the background.
- Portal rooms created automatically on the first message of a chat.
- The [`sync`](./bot-commands#sync) command for pinned chats and groups.
- Zalo network branding (name and logo) in Beeper.
- Automatic listener reconnect and catch-up of missed messages. See [How it works](./how-it-works).
- Outbound rate limiting to protect the account. See [Configuration](./configuration#zalo).
- Encrypted credential storage. See [Security](../security).
- The [history importer](../history-import/).

## Details

### Photos and captions

Photos without a caption show no caption in either direction; the file name is never used as one. A photo from Beeper iOS (which sends no `filename`) goes to Zalo without a caption. Photos larger than [`bridge.mediaMaxBytes`](./configuration#bridge) are not bridged.

### Videos, files and voice

Videos and files up to 100 MB are bridged. Zalo voice notes arrive as playable M4A voice notes: the bridge repackages Zalo's raw AAC stream without re-encoding. In the other direction, AAC voice notes (Beeper iOS) are sent as they are and ogg/opus (Beeper Android) is re-encoded to AAC with `ffmpeg`.

Zalo's CDN links for photos, videos, files and voice expire about 14 days after sending. The bridge downloads media only from Zalo's CDN hosts, over HTTPS, and checks every redirect. When a download fails, the room gets a notice with the Zalo link instead.

### Links

A Beeper message that contains a link (and no reply or mention) is sent with Zalo's link API, so Zalo shows its own preview card. If Zalo cannot parse the link, it goes out as plain text. A Zalo link message shows in Beeper as the text the sender typed, with the title, description and thumbnail Zalo resolved as the Beeper link preview.

### Rich text

Bold, colours and other formatting from Zalo arrive as plain text with their mentions; the styling is dropped.

### Typing and read receipts

They are sent to Zalo exactly when Beeper sends them. If you turn off typing notifications or read receipts in Beeper's settings, nothing is mirrored: Beeper then sends no typing events and only private receipts, which the bridge ignores.

### Contact cards

A Zalo contact card shows the contact's QR code with name and phone. The `zalo.me/<phone>` link opens the Zalo app on a phone. When the contact hides the number there is no link; scan the QR code instead.

### Call logs

Zalo voice, video and missed calls show as Beeper call tiles, with the direction and duration as the text ("Cuộc gọi video đến · 1:05"). Calls cannot be made or answered from Beeper.

On Beeper mobile, tapping a call tile shows "Couldn't open Self-hosted" instead of opening Zalo. The Beeper app chooses which app to open from the bridge type, and it only knows the official networks. The bridge cannot change this: tests with `external_url` (`https://zalo.me`, `zalo://`) on the event did not help. Open Zalo yourself to call back.

### Polls

Polls work in group chats only (Zalo has no polls in DMs).

- **Zalo to Beeper.** A poll created on Zalo shows as a Matrix poll (MSC3381) from its creator. Each vote is mirrored as a poll response from the voter, and a poll that is locked or deleted on Zalo ends in Beeper. For an anonymous poll Zalo does not say who voted, so the bridge bot posts the running tallies as a notice instead.
- **Beeper to Zalo.** A poll you create in a group chat is created on Zalo with the same question and answers ("allow multiple answers" is kept). Your votes (an empty vote removes it) and ending the poll are sent to Zalo too. In a DM the bridge replies with a notice and sends nothing.
- **Encrypted rooms.** Poll events are encrypted like messages, so polls work in end-to-bridge encrypted rooms.
- **Limits.** Zalo-side options such as "add options" or "pin poll" are not mirrored, and a poll is not editable once created. Only the account owner's own polls can be ended on Zalo.

### Pinned messages and system lines

When someone pins or unpins a message on Zalo, the bridge pins or unpins the same message in the room (the room's `m.room.pinned_events` state), as the person who did it. The other pins in the room are kept. If the pinned message was never bridged (for example it is older than the bridge), the room gets a short notice from the bridge bot instead.

Other system lines from Zalo (someone joined or left a group, and similar) are posted as a notice from the bridge bot, so they never look like something a person wrote. A DM created before encryption was added does not have the bot in it: the bridge invites the bot, and if that fails it posts the line as the other person's ghost, the only other member who can speak there.

Pinning or unpinning in Beeper does not change the pins on Zalo.

### Recall

Only messages you sent from Beeper can be recalled on Zalo, and only within Zalo's recall window. Zalo lets you recall only your own messages.

A message recalled on Zalo (by the sender, or by you on another device) is removed in Beeper too. Messages the bridge never bridged are skipped.

### Unknown message types

A Zalo message type the bridge does not know shows as `[Zalo message type not supported by bridge: <type>]`. The log records the payload's field **names** (never values) so the type can be added. See [Troubleshooting](../troubleshooting#unknown-zalo-message-type).

## Not implemented

- Edit sync from Zalo to Beeper.
- End-to-end encrypted Zalo chats (they cannot be decrypted).
- Live backfill of history from Zalo's servers. Zalo Web serves nothing from before the login. Use the [history importer](../history-import/).
- Several Zalo accounts on one bridge. Run one bridge per account; see [Multiple accounts](./multiple-accounts).
