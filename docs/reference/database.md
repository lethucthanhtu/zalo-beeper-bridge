# Database schema

The bridge keeps its state in one SQLite file, `bridge.db` (in `/data` in the container). It is opened with [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) in WAL mode by `src/bridge/mapping-store.ts`. The history importer opens the same file. Both set a 5-second `busy_timeout`, so a write that meets the other process's write lock waits for it instead of failing.

The database holds **ids and mappings only**: which Matrix room belongs to which Zalo chat, which ghost belongs to which Zalo user, and which Matrix event belongs to which Zalo message. It does not store message text or media. The one exception is `zalo_file`, which keeps the content-repo address of each uploaded sticker image and, for encrypted uploads, the key that decrypts it.

## Tables

### `portal`

One row per bridged Zalo chat (DM or group).

| Column        | Type    | Notes                                               |
| ------------- | ------- | --------------------------------------------------- |
| `thread_id`   | TEXT PK | Zalo thread id: the peer uid for a DM, the group id |
| `thread_type` | TEXT    | `user` or `group`                                   |
| `room_id`     | TEXT    | Matrix room id, unique                              |
| `name`        | TEXT    | Last known chat name                                |
| `created_at`  | INTEGER | Unix ms                                             |
| `account_id`  | TEXT    | Zalo uid of the account the chat belongs to (v7)    |

### `puppet`

One row per Zalo user that has a Matrix ghost.

| Column               | Type    | Notes                                                     |
| -------------------- | ------- | --------------------------------------------------------- |
| `zalo_uid`           | TEXT PK | Zalo user id                                              |
| `mxid`               | TEXT    | Ghost user id, e.g. `@sh-zalo_<uid>:beeper.local`, unique |
| `display_name`       | TEXT    | Last name set on the ghost                                |
| `updated_at`         | INTEGER | Unix ms                                                   |
| `avatar_url`         | TEXT    | Zalo avatar URL last synced to the ghost (v2)             |
| `profile_checked_at` | INTEGER | Last profile repair lookup (v6)                           |

### `message`

One row per bridged message, in either direction. Used for de-duplication, echo suppression, replies, edits, reactions, recalls and read receipts.

| Column        | Type    | Notes                                                         |
| ------------- | ------- | ------------------------------------------------------------- |
| `zalo_msg_id` | TEXT PK | Zalo message id                                               |
| `room_id`     | TEXT    | Matrix room id                                                |
| `event_id`    | TEXT    | Matrix event id, unique                                       |
| `direction`   | TEXT    | `inbound` (Zalo → Beeper) or `outbound` (Beeper → Zalo)       |
| `ts`          | INTEGER | Unix ms                                                       |
| `quote_json`  | TEXT    | What Zalo needs to quote this message in a reply (v3)         |
| `cli_msg_id`  | TEXT    | Zalo client message id, needed for reactions and recalls (v4) |
| `sender_id`   | TEXT    | Zalo uid of the sender (v5)                                   |
| `msg_type`    | TEXT    | Zalo message type, needed for "seen" events (v5)              |
| `account_id`  | TEXT    | Zalo uid of the account (v7)                                  |

### `account`

One row per Zalo account the bridge has logged in to (v7). Listed by the [`accounts`](../guide/bot-commands#accounts) command.

| Column          | Type    | Notes                                  |
| --------------- | ------- | -------------------------------------- |
| `zalo_uid`      | TEXT PK | Zalo user id of the account            |
| `creds_path`    | TEXT    | Path of its encrypted credentials file |
| `added_at`      | INTEGER | Unix ms                                |
| `last_login_at` | INTEGER | Unix ms                                |

### `reaction`

One row per reaction bridged in either direction (v8), so a reaction removed on one side can be removed on the other.

| Column          | Type    | Notes                              |
| --------------- | ------- | ---------------------------------- |
| `event_id`      | TEXT PK | Matrix reaction event id           |
| `room_id`       | TEXT    | Matrix room id                     |
| `target_msg_id` | TEXT    | Zalo message id the reaction is on |
| `sender_id`     | TEXT    | Zalo uid of the reacting user      |
| `zalo_icon`     | TEXT    | Zalo reaction icon code            |
| `ts`            | INTEGER | Unix ms                            |

Index `reaction_target (target_msg_id, sender_id)`. `message` also has a partial index on rows without an `account_id`, used when those rows are assigned to an account.

### `poll`

One row per bridged group poll (v9): the Zalo poll and the Matrix `poll.start` event that shows it.

| Column         | Type       | Notes                                                                  |
| -------------- | ---------- | ---------------------------------------------------------------------- |
| `poll_id`      | INTEGER PK | Zalo poll id                                                           |
| `room_id`      | TEXT       | Matrix room id                                                         |
| `event_id`     | TEXT       | `poll.start` event id (unique)                                         |
| `creator_id`   | TEXT       | Zalo uid of the creator, null when unknown                             |
| `options_json` | TEXT       | JSON list mapping each Zalo option id to its Matrix answer id and text |
| `multi`        | INTEGER    | 1 when more than one option may be picked                              |
| `closed`       | INTEGER    | 1 once the poll is locked or ended                                     |
| `votes_json`   | TEXT       | JSON of the last bridged vote per voter (Zalo uid → option ids)        |

Index `poll_room (room_id)`.

### `media_failure`

One row per live photo or file that reached Matrix only as a `[Zalo … could not be bridged]` notice (v10). The bot command `media-failures` lists a row only while the `message` row of the same Zalo message still points at the same room and event, so a rebuild that replaces the notice closes it. The media auto-repair closes it too: it points the `message` row at the repaired file and deletes the row.

| Column        | Type    | Notes                                                   |
| ------------- | ------- | ------------------------------------------------------- |
| `zalo_msg_id` | TEXT PK | Zalo message id                                         |
| `room_id`     | TEXT    | Matrix room id                                          |
| `event_id`    | TEXT    | Event id of the notice                                  |
| `kind`        | TEXT    | Media kind: `photo`, `video`, `file`, `voice`, `gif`, … |
| `error`       | TEXT    | Download errors, CDN host only (no signed link)         |
| `ts`          | INTEGER | Time of the failure (ms)                                |
| `account_id`  | TEXT    | Zalo uid of the account, null for older databases       |

Index `media_failure_room (room_id)`. Deleting a room's messages or its portal also deletes its rows.

### `zalo_file`

Reusable uploads of Zalo files, today the sticker images (v11). It has the shape of mautrix-telegram's `telegram_file` table. The same sticker is sent many times, so the bridge and the history importer upload its image once per mode and reuse it in every room, also after a restart. Only an image that passed validation is stored. An encrypted upload is not tied to a room, because each event carries its key, so one row serves every encrypted room, as in mautrix-telegram. Zalo stickers are public images, so sharing the key across rooms reveals nothing new.

| Column            | Type    | Notes                                                                               |
| ----------------- | ------- | ----------------------------------------------------------------------------------- |
| `id`              | TEXT    | Primary key: `sticker-<sticker id>`, plus `-encrypted` for the encrypted upload     |
| `mxc`             | TEXT    | Content-repo address of the upload                                                  |
| `mime_type`       | TEXT    | Mimetype of the image                                                               |
| `size`            | INTEGER | Size of the image in bytes                                                          |
| `width`           | INTEGER | Width in pixels, null when unknown                                                  |
| `height`          | INTEGER | Height in pixels, null when unknown                                                 |
| `timestamp`       | INTEGER | Time of the upload (Unix seconds)                                                   |
| `decryption_info` | TEXT    | For an encrypted upload, the JSON of the `file` object with its key; null otherwise |

Index `zalo_file_mxc_idx (mxc)`. Deleting the rows is safe: the next send of the sticker uploads it again.

## Migrations

The schema version is stored in `PRAGMA user_version`. The current version is **11**.

| Version | Change                                                            |
| ------- | ----------------------------------------------------------------- |
| 1       | `portal`, `puppet`, `message`                                     |
| 2       | `puppet.avatar_url`                                               |
| 3       | `message.quote_json`                                              |
| 4       | `message.cli_msg_id`                                              |
| 5       | `message.sender_id`, `message.msg_type`                           |
| 6       | `puppet.profile_checked_at`                                       |
| 7       | `account` table, `portal.account_id`, `message.account_id`, index |
| 8       | `reaction` table and index                                        |
| 9       | `poll` table and index                                            |
| 10      | `media_failure` table and index                                   |
| 11      | `zalo_file` table and index                                       |

Migrations run at start-up inside one `BEGIN IMMEDIATE` transaction that re-reads the version first. If the bridge and the importer open an old database at the same time, only one of them migrates, and a crash halfway leaves the database at the old version with no partial changes.

Every migration only **adds** tables, columns or indexes. An older bridge version therefore still runs on a newer database, which makes rolling back an image safe (see [Operations](../deployment/operations#rollback)).

## Inspecting it

Stop the bridge or work on a copy, then:

```bash
sqlite3 bridge.db 'PRAGMA user_version;'
sqlite3 bridge.db 'SELECT thread_type, count(*) FROM portal GROUP BY thread_type;'
```

After a Zalo login the bridge logs `[bridge] account <uid>: N portals, N messages assigned` when it tags older rows with the logged-in account.
