# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Dates are UTC+7.

This repository is a fork of
[lequocbinh04/zalo-beeper-bridge](https://github.com/lequocbinh04/zalo-beeper-bridge);
1.0.0 is the upstream state the fork started from.

## [Unreleased]

### Added

- Sticker upload cache (database schema v11, table `zalo_file`, modelled on mautrix-telegram's
  `telegram_file`). Each Zalo sticker is uploaded once per mode
  (plain or encrypted) and reused in every room, also after a restart, by both the live
  bridge and the history importer. One encrypted upload now serves every encrypted room
  instead of one upload per room, and an import with the sticker already cached skips the
  download (`sticker:cache` in the import stats). Sticker events carry
  `fi.mau.bridged_sticker` (network and sticker id), as mautrix bridges do. The database also sets
  a 5-second `busy_timeout`, so the bridge and the importer wait for each other's writes.
- Media failure ledger (database schema v10). A photo or file that reaches Matrix only as a
  `[Zalo … could not be bridged]` notice is recorded, and the new bot command `media-failures`
  lists the rooms that still have such notices. A history rebuild with `--media-dir` now also
  re-renders these notices as the real file, which clears them from the list.
- `[media]` log lines name the message, room and CDN host of every media download that fails,
  without the signed link.
- End-to-bridge encryption (`encryption.enabled`). The bridge bot gets its own Matrix crypto
  device, new DM and group portals are created encrypted with the bot joined, and the bot
  encrypts what it sends (messages, media, edits, reactions, redactions, notices, polls, call
  tiles) and decrypts what you send. Inbound media in encrypted rooms is uploaded encrypted.
  Existing plain portals have encryption turned on in place at start-up
  (`encryption.upgradeExisting`, on by default): new messages are encrypted and older history
  stays plain in the same room. Set it to `false` to keep them plain and rebuild them instead.
  The history importer encrypts imported history (media too) with a device of its own
  (`<storePath>-import`), so `--rebuild` moves a plain portal into a new encrypted room with
  its full history in order. Re-running it skips threads whose portal is already encrypted.
  `--include-encrypted` rebuilds those too, for portals that had encryption turned on in place.
  Your own imported and carried-over messages keep `fi.mau.double_puppet_source` outside the
  ciphertext, so Beeper does not mark them "failed to send"; live messages that are encrypted are
  carried over when the importer's device holds their key (it sent them in an earlier rebuild).
  Photos in encrypted rooms get an encrypted JPEG thumbnail (`info.thumbnail_file`, longest side
  800 px, made with ffmpeg), live and imported, so Element and Beeper no longer download and
  decrypt every full-size photo to draw the timeline. Thumbnails render one at a time, so a burst
  of photos (a history import) does not push them all past the ffmpeg timeout.
- History importer completeness audit (`--audit`, `--baseline-db`, `--accept-missing`). Every
  message a chat had in the pre-migration `bridge.db` and in its old rooms must be carried into
  the new room, be a verified redaction, a delete/recall marker, or be accepted by you; the
  evidence (metadata only) is written to `import-evidence/`. `--retire` and `--remove-old` now
  need `--baseline-db` and refuse to delete any room while a message is missing. A media message
  that arrived in the new room as text counts as missing too.
- `--rebuild` takes media that is no longer in `--media-dir` or on the Zalo CDN from the
  message's event in the old room (decrypted when the old room is encrypted), so moving a chat to
  an encrypted room no longer turns expired photos, videos and files into text. Stats show these
  as `<kind>:old-room`. The old event is looked up in the room the store points to and, when an
  earlier rebuild already repointed the store, in the room `--baseline-db` recorded. A message
  the export holds as a link card but the old room holds as media is rebuilt as that media
  (`link:old-room`). Old-room downloads get a 5-minute timeout, so large videos no longer fail
  after 30 seconds.
- Reactions in imported history. `scripts/zalo-pc/export-cdp.mjs` also writes
  `<chat key>.reactions.json` (who reacted with what, from Zalo PC's reaction table) for chats
  that have reactions, and the importer posts them after the messages, from the reactor's
  ghost (yours as your double-puppeted account), encrypted in encrypted rooms. A `--rebuild`
  used to leave every reaction behind with the old room. `--reactions-only` (with `--only`)
  adds the reactions of the export to a chat's current room without touching its messages,
  to repair chats rebuilt before this; reactions already in the room are skipped.
- Zalo group polls, in both directions. A poll created on Zalo shows in Beeper as a Matrix poll
  (MSC3381 `org.matrix.msc3381.poll.start`) from its creator, votes arrive as poll responses from
  the voters (an anonymous poll gets a bot notice with the tallies instead), and a poll that is
  locked or deleted ends. A poll you create in Beeper becomes a Zalo poll, your votes (an empty
  vote removes it) and ending the poll are sent to Zalo, and polls in a DM get a notice because
  Zalo has none. Poll events are encrypted like messages in end-to-bridge encrypted rooms. The
  history importer renders poll rows as a text notice with the question and options.
- Zalo call logs (voice, video, missed) now show as Beeper call tiles instead of notice text.
  They are posted as `m.text` with `com.beeper.action_message` (`type: call`, `call_type:
voice|video`), the same as mautrix-meta does since November 2026; the body ("Cuộc gọi video
  đến · 1:05") stays as the fallback for other clients. The history importer does the same.
  Tapping the tile on Beeper mobile shows "Couldn't open Self-hosted": Beeper opens native apps
  only for its official networks.
- A documentation site in `docs/` (VitePress): guides, deployment, history import,
  troubleshooting, FAQ, security and reference pages. Preview it with `npm run docs:dev`.
  The README now has a Vietnamese version (`README.vi.md`).
- "Delete for me" on another device (`chat.delete`) removes the message in Beeper too. The
  bridge redacts it as the room's creator, never as you, so it is never turned into a recall
  for everyone on Zalo.
- After every reconnect (container start, PC wake, network drop) the bridge fetches everything
  newer than the last message it bridged (up to ~500 per DMs and groups), so messages and calls
  that arrived while it was away are no longer lost. The old catch-up asked Zalo for a feed
  that runs forward from about a week ago, so it never reached recent messages.
- Rich-text messages (bold, colours, or many @mentions) bridge as text instead of "not
  supported".
- Links sent from Beeper show Zalo's own preview card on Zalo.
- Typing notifications and read receipts go to Zalo exactly when Beeper sends them, so Beeper's
  own privacy settings decide.
- Bridge state `BAD_CREDENTIALS` when the Zalo session dies and `LOGGED_OUT` on `logout`.
- Answers hungryserv's provisioning `capabilities` probe; logs any other proxied request.
- `logging.level` now applies to matrix-appservice-bridge (default `warn`).
- `backup-media.mjs` takes export `.ndjson` files (or a folder of them) as a 4th argument, so it
  can prepare `--media-dir` straight from the live Zalo PC folder
  (`<Zalo Data>/media/<uid>/ZaloDownloads`), which has no message database. History whose CDN
  links have expired gets its photos and videos back wherever Zalo PC still has a local copy.
- Media auto-repair. A live photo or file that fails to bridge is retried 2, 15 and 60 minutes
  later; the first retry reuses its links, later ones fetch the message from Zalo again for fresh
  links. A repaired file is posted to the room (at the end of the timeline) and the failure
  notice is redacted. After a restart, failures from the last 7 days are queued again. Zalo only
  serves a group's newest 200 messages and about a week of a DM, so older failures still need a
  rebuild with `--media-dir`. `media-failures` shows how many are still being retried.

### Changed

- The `[Zalo … could not be bridged]` notice no longer contains the media link: it was a signed
  link that expires and should not be stored in the room.
- The Beeper account state is re-posted every minute (was 10). A `bbctl proxy` reconnect wiped
  it, and Beeper Desktop then hid every Zalo chat for up to 10 minutes.
- Zalo link cards show the text the sender typed, with the page title as the preview title.
- Container health checks use the appservice's `/health` endpoint.
- Stricter TypeScript (`noUnused*`, `noImplicitReturns`, `noImplicitOverride`) and type-aware
  lint rules (no floating or misused promises, `unknown` in catch callbacks).
- `scripts/zalo-pc/migrate-all.sh` needs `BASELINE_DB` (a `bridge.db` copy taken before the
  run) and passes it to the importer as `--baseline-db`, so no old room is deleted before its
  messages are audited. It also finds `export-cdp.mjs` on Git Bash for Windows.
- `scripts/zalo-pc/migrate-all.sh` records a chat as `OKMEDIA` instead of `FAIL` when all its
  messages were imported and the only problems are media downloads or live messages that could
  not be carried over, and skips `OKMEDIA` chats on a re-run like `OK` ones.
- Internal cleanup, no behaviour change: the Zalo content → Matrix rendering shared by live
  messages and `--rebuild` lives in one module (`zalo-render.ts`); the loop guard between the
  two directions is one check (`self-bridge.ts`); duplicated helpers and constants (`util.ts`,
  `media-descriptor.ts`, `bridge-id.ts`, the double-puppet key, the media size rule) have one
  home each; `zalo/` and `matrix/` no longer import `bridge/` at runtime; unused wrappers and
  exports are gone. The architecture diagram in the docs shows the new layout.

### Fixed

- Messages from Zalo arrived later in encrypted rooms than in plain ones. Before every
  encrypted message bot-sdk fetched the room's members from the homeserver twice (joined and
  invited), about 0.5 s on a Beeper round trip, and the invited lookup failed on hungryserv's
  `null` member list with a warning each time. Member lists are now cached per room and
  refreshed when a membership event arrives (10-minute safety TTL), and appservice
  transactions that only repeat unchanged one-time key counts no longer take the crypto lock
  that encryption waits for.
- The completeness audit could pass, and `--remove-old` delete the old room, while photos
  had become text in the rebuilt room. The rebuild had already moved every store row out of
  the old room, and a chat missing from `--baseline-db` had no baseline rows, so the audit
  saw "0 messages". A rebuild now writes `import-evidence/<threadId>-rebuild.json` with the
  moved rows, and the audit (also a later `--retire` or `--audit`) checks them, including
  their media kind. Media posted as text because its old-room event could not be decrypted
  is counted as `old-room:undecryptable`, logged as a WARNING, and blocks the deletion.
- The completeness audit no longer reports a photo or other media as missing when the
  Zalo export records it as recalled or deleted. The live bridge had missed the recall, so the
  old room still showed the media, while the rebuilt room correctly shows the recall marker.
  Such messages now count as `redacted` ("recalled on Zalo (export)").
- A sticker whose download is not an image (for example a 5-byte body answered with HTTP 200)
  is no longer sent as a broken `m.sticker` that Beeper cannot display. The live bridge sends
  the `[Zalo sticker]` notice instead; the history importer tries the old room's copy and
  otherwise imports the text line (counted as `sticker:text` in the import report).
- Live photos no longer fall back to a notice when the original link answers HTTP 400 (an
  expired signed link): the bridge tries the HD link and then the thumbnail. Network errors,
  timeouts, HTTP 429 and 5xx answers are retried once on the same link.
- A long history import no longer fails a chat when Beeper resets a request with HTTP/2
  ENHANCE_YOUR_CALM ("slow down"). The importer waits 30 seconds, then 1, 2 and 4 minutes, and
  sends the same request again (batch sends, key shares, uploads, room deletes), so a chat fails
  only after the fifth reset in a row, and a half-built room is still dropped when it does.
- When the crypto engine could not read a room's encryption state, the bridge treated the room
  as unencrypted for 10 minutes and could send plaintext into an encrypted room. The send now
  fails (and is logged), and the state is asked again next time.
- Live photos in encrypted rooms now get the encrypted thumbnail too (only imported ones did),
  and JPEG photos are uploaded as `.jpg`.
- Animated sticker sprite sheets are downloaded with the same size cap as other media.
- `--rebuild` no longer copies the old "[Zalo message type not supported by bridge: …]" notices
  into the new room. When the payload the bridge stored for such a message renders today (photo,
  sticker, file, video, location, call, rich text, system line), the new room gets the real
  message, media uploaded like a fresh import; stats count these as `rerendered:<kind>`. The 🔒
  end-to-end encrypted notice is never touched, and a message that still cannot be rendered, or
  fails to post, keeps its notice. The completeness audit lists carried messages that are still
  such a notice although they would render (`stillUnsupported` in the evidence, not blocking).
- Recalled (msgType 20) and deleted (-27) rows of a Zalo PC export that hold an object instead
  of the usual text placeholder are imported as a recall/delete marker, never with the payload,
  instead of the generic "[Tin nhắn Zalo loại …]" line.
- Zalo system events no longer show up as an ordinary message from a person ("X pinned a
  message" used to appear as a bubble sent by X). A pin or unpin (`group_event` in groups,
  `friend_event` in DMs) now pins or unpins the same message in the room
  (`m.room.pinned_events`), as the person who did it, keeping the other pins; a pin of a
  message that was never bridged becomes a bot notice. Other system lines are posted as
  `m.notice` from the bridge bot, encrypted in encrypted rooms. A plaintext DM without the bot
  gets the bot invited; if that fails the line falls back to the peer's ghost. The system
  bubble Zalo sends alongside a pin is dropped so the pin is not shown twice. The history
  importer attributes pin (-1909) and group system (-4) rows to the bot too.
- The Zalo listener no longer gives up after a long network outage (PC asleep, Wi-Fi or DNS
  down for more than ~30 minutes). Abnormal socket closes (code 1006) now keep retrying every
  5 minutes and the bridge resumes syncing by itself once the network is back, instead of
  stopping until someone sends `login` or restarts the container.
- Reactions you make on the Zalo phone app show in Beeper, and removing a reaction in either
  app removes it in the other. Removing one reaction in Beeper keeps your other reactions on
  that message in Zalo.
- Replies that quote a message bridged before its server id was known (for example someone
  replying to their own message) now show as replies in Beeper. Unresolved quotes are logged.
- Links sent from Beeper reuse Beeper's own preview title and description on Zalo; links
  Zalo cannot preview, or whose preview you removed in Beeper, go as plain text instead of a
  broken card.
- Zalo system cards such as "pinned a message" show their text in Beeper instead of
  "[Zalo message type not supported by bridge: webchat]".
- Voice notes from Beeper Android (ogg/opus) arrived on Zalo as file attachments; they are
  re-encoded to AAC with ffmpeg (now in the container image) and sent as voice messages.
- Beeper iOS photos were sent to Zalo with the file name as a caption.
- GIF photos from Zalo were uploaded as JPEG.
- A sticker that failed to build once stayed a still image until restart.
- `sendLink` could send a message twice after a network error.
- Two Zalo profile lookups per new contact (now one).

### Removed

- Clearing of the legacy bridge-info state key, which rewrote every portal on each start.
- A monkey-patch for ephemeral events that matrix-appservice 4.1 already handles.

### Security

- Removed real thread/registration ids, a captured location and a personal home path from tests
  and launchd templates.

## 2026-10-23 – 2026-10-28 (fork)

### Added

- Docker/Podman deployment (`compose.yaml`, entrypoint running the appservice and `bbctl proxy`
  together).
- History importer from Zalo PC (CDP export and encrypted `.zl.zip` backups) with one-command
  scripts for Windows and macOS.
- Videos, files, voice notes, GIFs, doodles, locations, contact cards and web cards from Zalo.
- Animated stickers built from Zalo's sprite sheets.
- Multi-account groundwork: schema v7 (`account` table, `account_id`), `accounts` command,
  `fi.mau.receiver` in bridge info.
- Rollback procedure for container deploys.

### Changed

- matrix-appservice-bridge 11.2.0 → 12.0.1; non-breaking security updates.
- The ghost prefix is derived from the registration (several bridges per host).

### Fixed

- Adding the Zalo account in Beeper, voice notes, and several import-script options.

## [1.0.0] - 2026-08-10 (upstream)

First version by [lequocbinh04](https://github.com/lequocbinh04): two-way text, replies,
mentions, photos, video/file/audio out, reactions, recall, read receipts, typing, double
puppeting of your own phone messages, network branding, Beeper account state, encrypted
credential storage, owner-only bot commands and a launchd deployment for macOS.

[Unreleased]: https://github.com/lethucthanhtu/zalo-beeper-bridge/commits/main
[1.0.0]: https://github.com/lequocbinh04/zalo-beeper-bridge
