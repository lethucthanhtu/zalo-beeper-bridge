# Importer CLI

`src/tools/import-zalo-export.ts` runs next to the live bridge with the same config, registration and `bridge.db`. It only sets up the appservice intents: it never listens to Zalo and makes no Zalo API calls, so the live bridge and `bbctl proxy` are not affected. Names come from the export.

Run it inside the container from `/data`:

```bash
podman exec -u node -w /data zalo-beeper-bridge \
  node /app/src/tools/import-zalo-export.ts <exportDir> [options]
```

`<exportDir>` holds one `<chat key>.ndjson` file per chat, as written by `scripts/zalo-pc/export-cdp.mjs`. A chat with reactions also gets a `<chat key>.reactions.json` sidecar (see [Reactions](#reactions)).

## Options

| Option                       | Meaning                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--only k1,k2`               | Limit to these chat keys. Required for `--rebuild`.                                                                                    |
| `--dry-run [--probe]`        | Print per-chat counts by kind. `--probe` also tries every download (no upload).                                                        |
| `--rebuild`                  | Build a new room per chat with the full ordered history, carry over live-only messages, then point the chat at it.                     |
| `--remove-old`               | With `--rebuild`: verify and audit the new room, then delete the room it replaces. Needs `--baseline-db`.                              |
| `--include-encrypted`        | With `--rebuild`: also rebuild a chat whose portal is already encrypted (see [Encrypted rooms](#encrypted-rooms)).                     |
| `--carry-from !r1,!r2`       | With `--rebuild`: also keep live-only messages from these earlier rooms of the chat (repeatable).                                      |
| `--reactions-only`           | With `--only`: post only the [reactions](#reactions) of the export into the chat's current room.                                       |
| `--verify`                   | Read-only check: every exported message is mapped to the chat's room, and every mapped message is a real event in its Beeper timeline. |
| `--retire !old1,!old2`       | Verify and audit exactly one `--only` chat, then delete these superseded rooms. Needs `--baseline-db`.                                 |
| `--audit !old1,!old2`        | Read-only [completeness audit](#completeness-audit) of one `--only` chat against these old rooms (`--audit ''`: baseline only).        |
| `--baseline-db FILE`         | The `bridge.db` from before the migration: every message the chat had there must be accounted for.                                     |
| `--accept-missing id1,id2`   | Zalo message ids you confirm may be missing (for example deleted on Zalo before the audit existed).                                    |
| `--media-dir DIR`            | Backup media prepared by `backup-media.mjs`.                                                                                           |
| `--own-uid UID`              | Your Zalo uid, so mentions of you become pills for your account.                                                                       |
| `--batch N` / `--delay-ms N` | Batch size (default `100`) and pause between batches (default `1500` ms).                                                              |
| `--media-days N`             | Try expiring CDN links only for messages younger than N days (default `16`).                                                           |

## Modes

**Prepend (default).** Without `--rebuild`, the importer only adds history older than the room's first bridged message, newest chunk first, so live messages stay at the bottom. Beeper's batch-send API can insert only before the oldest or after the newest event, never in the middle.

**Rebuild.** Use `--rebuild` whenever messages are missing between ones already in Beeper. The new room gets the full history oldest-first. Messages the live bridge posted that the export lacks (Zalo PC missed them, or they arrived during the run) are replayed from the old room's events in timeline order. When a message's media is neither in `--media-dir` nor on the Zalo CDN any more (expired link), the importer takes it from the message's event in the old room, the copy the bridge uploaded when the message was first bridged, instead of posting the message as text; these show up as `<kind>:old-room` in the stats. If an earlier rebuild already moved the chat, the event is also looked up in the room `--baseline-db` recorded for it. A message the export holds as a link card but the old room holds as media (a photo or video shared with a link) is rebuilt as that media and counted as `link:old-room`. A message the live bridge could not render when it arrived (its event is the "[Zalo message type not supported by bridge: …]" notice) is rendered again from the Zalo payload the bridge stored for it, so the new room gets the photo, sticker, file, location or call instead of the notice; these show up as `rerendered:<kind>`. The 🔒 notice of an end-to-end encrypted Zalo message is never re-rendered, and a message that still cannot be rendered keeps its notice. The old room stays untouched until `--remove-old` (or a later `--retire`) has verified and audited the new one.

## Encrypted rooms

With `encryption.enabled` in the config, the importer creates new rooms encrypted and encrypts everything it sends into an encrypted room, media included. It uses a crypto device of its own (store `<storePath>-import`, display name "Zalo bridge (history import)"), never the live bridge's, so it can run while the bridge runs.

This makes `--rebuild` the way to move an existing plain chat to encryption: the new room is encrypted, gets the full history in order, and the chat is pointed at it. A chat whose portal is already encrypted is skipped with "already encrypted", so a migration over many chats can be re-run after a failure. A portal that had encryption turned on in place still holds its old history in plain text; pass `--include-encrypted` to rebuild it as well. Encrypted events in the old room cannot be read by the importer's device; they are left behind and counted in the "could not be carried over" warning.

## Reactions

`export-cdp.mjs` reads Zalo PC's reaction table and writes `<chat key>.reactions.json` next to the chat's `.ndjson` (only when the chat has reactions): for each reacted message its ids and who reacted with which reaction type. After a chat's messages are in, the importer posts each reaction on its message as an `m.reaction`, from the reactor's ghost, or from your own account (double puppet) for your reactions, encrypted when the room is encrypted. Reactions already in the room are skipped, and a reaction on a message that is not in the room is counted and left out. The log line `[import] <key>: N reactions posted, S already there or skipped, U on messages not in the room` sums it up.

A chat rebuilt before reactions were imported lost them with its old room. To add them back, export the chat again and run the importer with `--only <key> --reactions-only`: it posts only the reactions into the chat's current room and changes nothing else.

## Examples

```bash
# What would be imported for two chats, and can their media still be downloaded?
… import-zalo-export.ts /data/import-export --only g1111111111,2222222222 --dry-run --probe

# Rebuild one group with backup media and delete the old room after verification
… import-zalo-export.ts /data/import-export --only g1111111111 --rebuild --remove-old \
    --media-dir /data/import-media --own-uid 1111111111111111111

# Check an imported chat
… import-zalo-export.ts /data/import-export --only g1111111111 --verify
```

## Completeness audit

Before an old room is deleted, `--retire` and `--remove-old` run an audit, and `--audit` runs it alone without deleting anything. Every message of the chat in `--baseline-db` and every row still mapped to the old rooms gets a verdict:

| Verdict    | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| `carried`  | A real event in the new room's timeline.                                                 |
| `redacted` | Deleted or recalled in the old room; the redaction (who, why, when) is read back as you. |
| `marker`   | A row that never had an event: a delete or recall the bridge recorded.                   |
| `accepted` | Listed in `--accept-missing`.                                                            |
| `missing`  | Anything else. Any missing message blocks the deletion.                                  |

A message must also keep its kind: when its old event is media (image, video, audio, file or sticker) and its new event is not, it is `missing` ("m.image became m.text in the new room") unless listed in `--accept-missing`. The exception is a message the export records as recalled or deleted on Zalo: the live bridge missed the recall, so the old room still shows the media while the new room has the "[Tin nhắn đã thu hồi]" marker, which matches Zalo. It counts as `redacted` ("recalled on Zalo (export)"). Encrypted events are decrypted with the importer's device; a new event it cannot read counts as not media, so the check fails safe.

The same applies the other way round. When a rebuild posts a media message as text because neither `--media-dir` nor the CDN had the file, and the importer could not decrypt the message's old-room event either, it cannot tell whether the old room still holds the media. The message is counted as `old-room:undecryptable` in the stats, the run logs a WARNING, and the audit marks it `missing` ("media became text; the old-room event could not be decrypted") until the file is supplied with `--media-dir` and the chat is rebuilt, or the message is listed in `--accept-missing`.

A rebuild moves the store rows of the old room to the new one, so after it nothing is mapped to the old room any more. Before the move it writes `import-evidence/<threadId>-rebuild.json` (the new room, the moved rows as metadata only, and the messages above). `--remove-old`, and a later `--retire` or `--audit` of that new room, read it and audit the moved rows as old-room rows, including their media kind. A chat that is missing from `--baseline-db` is therefore audited too.

The evidence (metadata only: ids, times, directions, verdicts; no message content) is written to `import-evidence/<threadId>-<time>.json`, and an `[audit]` line sums it up. The evidence also lists, under `stillUnsupported`, carried messages whose event is still the "not supported" notice although their stored payload renders today; they do not block the deletion, and a new `--rebuild` replaces them with the real message.

```bash
# Audit the current room of a chat against the pre-migration database, deleting nothing
… import-zalo-export.ts /data/import-export --only 2222222222 --audit '' \
    --baseline-db /data/bridge.db.bak-pre-e2ee
```

Its log lines start with `[import]` (`[audit]` for the audit, `[retire]` when rooms are deleted). See [Logs](../reference/logs).
