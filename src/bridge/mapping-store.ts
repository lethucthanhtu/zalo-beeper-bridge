// SQLite persistence: portal rooms, ghost puppets, message dedup/echo keys.
// better-sqlite3 sync API — single-user bridge volume makes async pooling YAGNI.
import Database from 'better-sqlite3';
import type { EncryptedFile } from '@vector-im/matrix-bot-sdk';
import type { ZaloThreadType } from '../zalo/types.ts';
import type { Uploaded } from './media-content.ts';

/** One `portal` row: the Matrix room a Zalo thread (DM or group) is bridged into. */
export type PortalRow = {
  thread_id: string;
  thread_type: ZaloThreadType;
  room_id: string;
  name: string | null;
  /** Zalo uid of the account this portal belongs to (null until that account first logged in) */
  account_id?: string | null;
};

/** Open media failures of one room (see `MappingStore.listOpenMediaFailures`). */
export type OpenMediaFailures = { roomId: string; count: number; lastTs: number; kinds: string[] };

/**
 * A sticker image already in the Matrix content repo, reusable for every later send of the
 * same Zalo sticker. An encrypted entry carries its key; anyone who received the sticker once
 * could already decrypt it, and Zalo stickers are public images.
 */
export type StickerMedia = { uploaded: Uploaded; mimetype: string; size: number; w?: number; h?: number };

/** `zalo_file` id of a sticker image: `sticker-<id>`, plus `-encrypted` for the encrypted upload. */
function stickerFileId(stickerId: number | string, encrypted: boolean): string {
  return `sticker-${stickerId}${encrypted ? '-encrypted' : ''}`;
}

/** One `account` row: a Zalo account this bridge has logged in to. */
export type AccountRow = {
  zalo_uid: string;
  creds_path: string;
  added_at: number;
  last_login_at: number | null;
};

/** Which way a message was bridged: Zalo → Matrix ('inbound') or Matrix → Zalo ('outbound'). */
type MessageDirection = 'inbound' | 'outbound';

/** One bridged reaction: a Matrix m.reaction event ↔ a Zalo reaction on a bridged message. */
export type ReactionRow = {
  event_id: string;
  room_id: string;
  /** Zalo msgId of the message reacted to */
  target_msg_id: string;
  /** Zalo uid of whoever reacted (the account's own uid for the owner) */
  sender_id: string;
  /** Zalo icon code the reaction maps to (emoji outside Zalo's palette map to the nearest one) */
  zalo_icon: string;
};

/** One poll option: the Zalo option id ↔ the MSC3381 answer id used in Matrix poll events. */
type PollOptionMapping = { optionId: number; answerId: string; content: string };

/** One bridged poll: a Zalo group poll ↔ the Matrix `poll.start` event that renders it. */
export type PollRow = {
  pollId: number;
  roomId: string;
  /** event_id of the poll.start event */
  eventId: string;
  /** Zalo uid of the creator (null when unknown) */
  creatorId: string | null;
  options: PollOptionMapping[];
  /** more than one option may be picked (max_selections > 1) */
  multi: boolean;
  closed: boolean;
  /** last bridged vote of each voter (Zalo uid → picked option ids), to diff the next update */
  votes: Record<string, number[]>;
};

type PollDbRow = {
  poll_id: number;
  room_id: string;
  event_id: string;
  creator_id: string | null;
  options_json: string;
  multi: number;
  closed: number;
  votes_json: string;
};

/** Target `PRAGMA user_version`; bump it together with a new step in `migrate()`. */
const SCHEMA_VERSION = 11;

/**
 * Synchronous SQLite-backed store for everything the bridge must remember across
 * restarts: portal rooms (Zalo thread ↔ Matrix room), ghost puppets (Zalo uid ↔
 * MXID + profile sync state) and bridged messages (Zalo msgId ↔ Matrix event_id,
 * used for dedup, echo guards, replies, reactions, recalls and read receipts).
 */
export class MappingStore {
  private readonly db: Database.Database;
  /** Zalo uid of the logged-in account; stamped on new portal / message rows (null before login). */
  private accountId: string | null = null;

  /**
   * Opens (or creates) the database file, switches it to WAL journaling and
   * brings the schema up to date.
   * @param dbPath Path of the SQLite file (created when missing).
   * @throws When the file cannot be opened or a migration fails.
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // The bridge and the history importer share the file: wait for the other writer instead
    // of failing at once with SQLITE_BUSY
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  /** The account new rows are stamped with (see bindAccount), or null before the first login. */
  get currentAccountId(): string | null {
    return this.accountId;
  }

  /**
   * Called on every Zalo login: records the account (with the credentials file it uses),
   * makes it the account new rows are stamped with, and assigns every row that has no
   * account yet (everything bridged before accounts were tracked) to it.
   * @returns How many portal and message rows were assigned to the account.
   */
  bindAccount(zaloUid: string, credsPath: string): { portals: number; messages: number } {
    return this.db.transaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO account (zalo_uid, creds_path, added_at, last_login_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(zalo_uid) DO UPDATE SET creds_path = excluded.creds_path, last_login_at = excluded.last_login_at`,
        )
        .run(zaloUid, credsPath, now, now);
      this.accountId = zaloUid;
      return {
        portals: this.db.prepare('UPDATE portal SET account_id = ? WHERE account_id IS NULL').run(zaloUid).changes,
        messages: this.db.prepare('UPDATE message SET account_id = ? WHERE account_id IS NULL').run(zaloUid).changes,
      };
    })();
  }

  /**
   * Stamps new rows with `zaloUid` without recording a login or touching existing rows —
   * for the history importer, which writes on behalf of a known account (`--own-uid`).
   */
  useAccount(zaloUid: string): void {
    this.accountId = zaloUid;
  }

  /** Every Zalo account the bridge has logged in to, oldest first. */
  listAccounts(): AccountRow[] {
    return this.db.prepare('SELECT * FROM account ORDER BY added_at').all() as AccountRow[];
  }

  /**
   * Applies every schema step newer than the stored `user_version`, then stamps
   * `SCHEMA_VERSION`. No-op when the database is already current.
   */
  private migrate(): void {
    /** Schema version stored in the file. */
    const storedVersion = () => (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (storedVersion() >= SCHEMA_VERSION) return;
    // Transactional: a crash mid-migration must not leave ALTERs applied with a
    // stale user_version (re-running an ALTER = duplicate-column crash loop).
    // IMMEDIATE + re-reading the version inside: when the bridge and the history
    // importer open an old database at the same time, only the first one migrates.
    this.db
      .transaction(() => {
        const current = storedVersion();
        if (current >= SCHEMA_VERSION) return;
        if (current < 1) this.migrateV1();
        if (current < 2) this.db.exec('ALTER TABLE puppet ADD COLUMN avatar_url TEXT');
        if (current < 3) this.db.exec('ALTER TABLE message ADD COLUMN quote_json TEXT');
        // cliMsgId is required by Zalo reaction/undo APIs; store per inbound message
        if (current < 4) this.db.exec('ALTER TABLE message ADD COLUMN cli_msg_id TEXT');
        // sender_id + msg_type let us build a Zalo seen event (Beeper read → Zalo "seen")
        if (current < 5) {
          this.db.exec('ALTER TABLE message ADD COLUMN sender_id TEXT');
          this.db.exec('ALTER TABLE message ADD COLUMN msg_type TEXT');
        }
        // when the contact's Zalo profile was last looked up — so a contact without an
        // avatar is not looked up again on every event (avatar_url stays null for them)
        if (current < 6) this.db.exec('ALTER TABLE puppet ADD COLUMN profile_checked_at INTEGER');
        // Multi-account groundwork (additive only — keys and lookups are unchanged): the
        // accounts the bridge logged in to, and which account each portal / message is from
        if (current < 7) {
          this.db.exec(`
          CREATE TABLE IF NOT EXISTS account (
            zalo_uid      TEXT PRIMARY KEY,
            creds_path    TEXT NOT NULL,
            added_at      INTEGER NOT NULL,
            last_login_at INTEGER
          );
          ALTER TABLE portal ADD COLUMN account_id TEXT;
          ALTER TABLE message ADD COLUMN account_id TEXT;
          -- bindAccount runs on every reconnect: find untagged messages without a table scan
          CREATE INDEX message_account_untagged ON message(account_id) WHERE account_id IS NULL;
        `);
        }
        // Bridged reactions, so a removal on either side can be mirrored (redaction ↔ Zalo
        // "remove reaction") and own reactions echoed back by Zalo are recognised
        if (current < 8) {
          this.db.exec(`
          CREATE TABLE IF NOT EXISTS reaction (
            event_id      TEXT PRIMARY KEY,
            room_id       TEXT NOT NULL,
            target_msg_id TEXT NOT NULL,
            sender_id     TEXT NOT NULL,
            zalo_icon     TEXT NOT NULL,
            ts            INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS reaction_target ON reaction(target_msg_id, sender_id);
        `);
        }
        // Bridged group polls: pollId ↔ poll.start event, optionId ↔ answer id, last known votes
        if (current < 9) {
          this.db.exec(`
          CREATE TABLE IF NOT EXISTS poll (
            poll_id      INTEGER PRIMARY KEY,
            room_id      TEXT NOT NULL,
            event_id     TEXT NOT NULL UNIQUE,
            creator_id   TEXT,
            options_json TEXT NOT NULL,
            multi        INTEGER NOT NULL DEFAULT 0,
            closed       INTEGER NOT NULL DEFAULT 0,
            votes_json   TEXT NOT NULL DEFAULT '{}'
          );
          CREATE INDEX IF NOT EXISTS poll_room ON poll(room_id);
        `);
        }
        // Live photos / media that reached Matrix only as a "could not be bridged" notice
        if (current < 10) {
          this.db.exec(`
          CREATE TABLE IF NOT EXISTS media_failure (
            zalo_msg_id TEXT PRIMARY KEY,
            room_id     TEXT NOT NULL,
            event_id    TEXT,
            kind        TEXT NOT NULL,
            error       TEXT,
            ts          INTEGER NOT NULL,
            account_id  TEXT
          );
          CREATE INDEX IF NOT EXISTS media_failure_room ON media_failure(room_id);
        `);
        }
        // Reusable uploads of Zalo files (sticker images), shared by the live bridge and the
        // importer and kept across restarts. Same shape as mautrix-telegram's `telegram_file`:
        // the id names the Zalo file plus `-encrypted` for an encrypted upload, whose key is in
        // decryption_info, so each file is uploaded once per mode instead of once per send
        if (current < 11) {
          this.db.exec(`
          CREATE TABLE IF NOT EXISTS zalo_file (
            id              TEXT PRIMARY KEY,
            mxc             TEXT NOT NULL,
            mime_type       TEXT,
            size            INTEGER,
            width           INTEGER,
            height          INTEGER,
            timestamp       INTEGER,
            decryption_info TEXT
          );
          CREATE INDEX IF NOT EXISTS zalo_file_mxc_idx ON zalo_file(mxc);
        `);
        }
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })
      .immediate();
  }

  /** Schema v1: creates the base `portal`, `puppet` and `message` tables (idempotent). */
  private migrateV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portal (
        thread_id   TEXT PRIMARY KEY,
        thread_type TEXT NOT NULL CHECK (thread_type IN ('user','group')),
        room_id     TEXT NOT NULL UNIQUE,
        name        TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS puppet (
        zalo_uid     TEXT PRIMARY KEY,
        mxid         TEXT NOT NULL UNIQUE,
        display_name TEXT,
        updated_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message (
        zalo_msg_id TEXT PRIMARY KEY,
        room_id     TEXT NOT NULL,
        event_id    TEXT UNIQUE,
        direction   TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        ts          INTEGER NOT NULL
      );
    `);
  }

  /** Stored display name of a ghost, or null when the puppet is unknown or still unnamed. */
  getPuppetDisplayName(zaloUid: string): string | null {
    const row = this.db.prepare('SELECT display_name FROM puppet WHERE zalo_uid = ?').get(zaloUid) as
      { display_name: string | null } | undefined;
    return row?.display_name ?? null;
  }

  /**
   * Zalo avatar URL last synced to the ghost, or null when none was synced yet
   * (PuppetRegistry reads null as "avatar sync still needed").
   */
  getPuppetAvatarUrl(zaloUid: string): string | null {
    const row = this.db.prepare('SELECT avatar_url FROM puppet WHERE zalo_uid = ?').get(zaloUid) as
      { avatar_url: string | null } | undefined;
    return row?.avatar_url ?? null;
  }

  /**
   * Records that the ghost's avatar was synced from `avatarUrl` and bumps
   * `updated_at`. Does nothing when the puppet row does not exist yet.
   */
  setPuppetAvatarUrl(zaloUid: string, avatarUrl: string): void {
    this.db
      .prepare('UPDATE puppet SET avatar_url = ?, updated_at = ? WHERE zalo_uid = ?')
      .run(avatarUrl, Date.now(), zaloUid);
  }

  /** Records that the contact's Zalo profile was just looked up (with or without an avatar). */
  markProfileChecked(zaloUid: string): void {
    this.db.prepare('UPDATE puppet SET profile_checked_at = ? WHERE zalo_uid = ?').run(Date.now(), zaloUid);
  }

  /** True when the contact's profile was looked up within the last `maxAgeMs`. */
  isProfileFresh(zaloUid: string, maxAgeMs: number): boolean {
    const row = this.db.prepare('SELECT profile_checked_at FROM puppet WHERE zalo_uid = ?').get(zaloUid) as
      { profile_checked_at: number | null } | undefined;
    return row?.profile_checked_at != null && Date.now() - row.profile_checked_at < maxAgeMs;
  }

  /**
   * Contacts still missing an avatar or a name whose profile was not looked up within
   * `maxAgeMs` — DM peers first (their avatar is the chat's picture in Beeper).
   */
  getPuppetsMissingProfile(maxAgeMs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT puppet.zalo_uid AS uid FROM puppet
         LEFT JOIN portal ON portal.thread_id = puppet.zalo_uid AND portal.thread_type = 'user'
         WHERE (puppet.avatar_url IS NULL OR puppet.display_name IS NULL)
           AND (puppet.profile_checked_at IS NULL OR puppet.profile_checked_at < ?)
         ORDER BY portal.thread_id IS NULL, puppet.zalo_uid`,
      )
      .all(Date.now() - maxAgeMs) as Array<{ uid: string }>;
    return rows.map((row) => row.uid);
  }

  /** Portal of a Zalo thread, or undefined when the thread has no room yet. */
  getPortalByThread(threadId: string): PortalRow | undefined {
    return this.db
      .prepare('SELECT thread_id, thread_type, room_id, name, account_id FROM portal WHERE thread_id = ?')
      .get(threadId) as PortalRow | undefined;
  }

  /** True when the Matrix room is the current portal of some Zalo thread. */
  isPortalRoom(roomId: string): boolean {
    return this.db.prepare('SELECT 1 FROM portal WHERE room_id = ?').get(roomId) !== undefined;
  }

  /** Portal behind a Matrix room, or undefined when the room is not a portal. */
  getPortalByRoom(roomId: string): PortalRow | undefined {
    return this.db
      .prepare('SELECT thread_id, thread_type, room_id, name, account_id FROM portal WHERE room_id = ?')
      .get(roomId) as PortalRow | undefined;
  }

  /** Every known portal (startup repairs and the history importer iterate over these). */
  getAllPortals(): PortalRow[] {
    return this.db.prepare('SELECT thread_id, thread_type, room_id, name, account_id FROM portal').all() as PortalRow[];
  }

  /** True when the bridge itself posted this Matrix event (echo guard for outbound). */
  hasEventId(eventId: string): boolean {
    return this.db.prepare('SELECT 1 FROM message WHERE event_id = ?').get(eventId) !== undefined;
  }

  /**
   * Persist "this outbound Matrix event was handled" even when the Zalo send
   * returned no msgId, so a redelivery after a restart is not sent again.
   * Stores a synthetic `evt:<eventId>` msgId, which the room listings filter out.
   */
  markOutboundHandled(eventId: string, roomId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO message (zalo_msg_id, room_id, event_id, direction, ts, account_id) VALUES (?, ?, ?, 'outbound', ?, ?)",
      )
      .run(`evt:${eventId}`, roomId, eventId, Date.now(), this.accountId);
  }

  /** Matrix event for a Zalo msgId (read-receipt mapping). */
  getEventIdByMsgId(zaloMsgId: string): string | null {
    const row = this.db.prepare('SELECT event_id FROM message WHERE zalo_msg_id = ?').get(zaloMsgId) as
      { event_id: string | null } | undefined;
    return row?.event_id ?? null;
  }

  /**
   * Newest bridged Zalo msgId of a thread type (msgIds grow over time), or null on a fresh
   * install. Synthetic rows (`evt:…`) and importer shadow ids (`…_0001`) are not msgIds.
   */
  newestMsgId(threadType: ZaloThreadType): string | null {
    const row = this.db
      .prepare(
        `SELECT m.zalo_msg_id AS id FROM message m JOIN portal p ON p.room_id = m.room_id
         WHERE p.thread_type = ? AND m.zalo_msg_id NOT GLOB '*[^0-9]*'
         ORDER BY length(m.zalo_msg_id) DESC, m.zalo_msg_id DESC LIMIT 1`,
      )
      .get(threadType) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** True when the room has any message row (either direction, including outbound "evt:" guards). */
  roomHasMessages(roomId: string): boolean {
    return this.db.prepare('SELECT 1 FROM message WHERE room_id = ? LIMIT 1').get(roomId) !== undefined;
  }

  /** Earliest `ts` of any message row in this room (history import cutoff), or null when it has none. */
  getOldestMessageTs(roomId: string): number | null {
    const row = this.db.prepare('SELECT MIN(ts) AS ts FROM message WHERE room_id = ?').get(roomId) as {
      ts: number | null;
    };
    return row.ts;
  }

  /** Messages bridged into a room in bridging order (outbound "evt:" echo guards excluded). */
  getRoomMessages(roomId: string): Array<{
    msgId: string;
    eventId: string | null;
    direction: MessageDirection;
    cliMsgId: string | null;
    msgType: string | null;
    ts: number;
  }> {
    return this.db
      .prepare(
        "SELECT zalo_msg_id AS msgId, event_id AS eventId, direction, cli_msg_id AS cliMsgId, msg_type AS msgType, ts FROM message WHERE room_id = ? AND zalo_msg_id NOT LIKE 'evt:%' ORDER BY ts, rowid",
      )
      .all(roomId) as Array<{
      msgId: string;
      eventId: string | null;
      direction: MessageDirection;
      cliMsgId: string | null;
      msgType: string | null;
      ts: number;
    }>;
  }

  /**
   * History rebuild: point a thread at a freshly backfilled room in one transaction.
   * Messages already known keep their quote/cliMsgId/sender (replies, recall and seen
   * receipts keep working) but move to the new room's event; new ones are inserted.
   * The portal row is updated (keeping the old name when `row.name` is null), or
   * inserted when the thread had no portal yet.
   * @param row The thread's portal, already pointing at the new room.
   * @param messages Backfilled messages with their event_ids in the new room.
   */
  repointPortal(
    row: PortalRow,
    messages: Array<{
      msgId: string;
      eventId: string;
      direction: MessageDirection;
      cliMsgId: string | null;
      msgType: string | null;
    }>,
  ): void {
    this.db.transaction(() => {
      const updated = this.db
        .prepare('UPDATE portal SET room_id = ?, name = COALESCE(?, name) WHERE thread_id = ?')
        .run(row.room_id, row.name, row.thread_id);
      if (updated.changes === 0) this.insertPortal(row);
      const upsert = this.db.prepare(
        `INSERT INTO message (zalo_msg_id, room_id, event_id, direction, ts, cli_msg_id, msg_type, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(zalo_msg_id) DO UPDATE SET room_id = excluded.room_id, event_id = excluded.event_id`,
      );
      for (const message of messages)
        upsert.run(
          message.msgId,
          row.room_id,
          message.eventId,
          message.direction,
          Date.now(),
          message.cliMsgId,
          message.msgType,
          this.accountId,
        );
    })();
  }

  /**
   * Forgets every message mapping of a removed (no longer portal) room.
   * @returns Number of deleted message rows.
   * @throws When the room is still a live portal (its mappings are in use).
   */
  deleteRoomMessages(roomId: string): number {
    if (this.isPortalRoom(roomId)) throw new Error(`refusing to drop messages of live portal room ${roomId}`);
    this.db.prepare('DELETE FROM reaction WHERE room_id = ?').run(roomId);
    this.db.prepare('DELETE FROM poll WHERE room_id = ?').run(roomId);
    this.db.prepare('DELETE FROM media_failure WHERE room_id = ?').run(roomId);
    return this.db.prepare('DELETE FROM message WHERE room_id = ?').run(roomId).changes;
  }

  /**
   * The stored upload of a sticker for plain or encrypted rooms, or null when it was never
   * uploaded in that mode (or the row is unreadable).
   */
  getStickerMedia(stickerId: number | string, encrypted: boolean): StickerMedia | null {
    const row = this.db
      .prepare('SELECT mxc, mime_type, size, width, height, decryption_info FROM zalo_file WHERE id = ?')
      .get(stickerFileId(stickerId, encrypted)) as
      | {
          mxc: string;
          mime_type: string | null;
          size: number | null;
          width: number | null;
          height: number | null;
          decryption_info: string | null;
        }
      | undefined;
    if (!row) return null;
    let uploaded: Uploaded;
    if (encrypted) {
      // An encrypted entry without a readable key is useless: treat it as never uploaded
      if (!row.decryption_info) return null;
      try {
        uploaded = { file: { ...(JSON.parse(row.decryption_info) as EncryptedFile), url: row.mxc } };
      } catch {
        return null;
      }
    } else {
      uploaded = { url: row.mxc };
    }
    return {
      uploaded,
      mimetype: row.mime_type ?? 'application/octet-stream',
      size: row.size ?? 0,
      ...(row.width ? { w: row.width } : {}),
      ...(row.height ? { h: row.height } : {}),
    };
  }

  /** Remembers a sticker upload (validated image only) for later sends in the same mode. */
  putStickerMedia(stickerId: number | string, encrypted: boolean, media: StickerMedia): void {
    const file = 'file' in media.uploaded ? media.uploaded.file : null;
    // The mode must match the upload: a plain mxc under an `-encrypted` id (or the reverse)
    // would hand an encrypted room an unencrypted file, or a plain room an unreadable one
    if (encrypted !== Boolean(file)) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO zalo_file (id, mxc, mime_type, size, width, height, timestamp, decryption_info)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stickerFileId(stickerId, encrypted),
        file ? file.url : (media.uploaded as { url: string }).url,
        media.mimetype,
        media.size,
        media.w ?? null,
        media.h ?? null,
        Math.floor(Date.now() / 1000),
        file ? JSON.stringify(file) : null,
      );
  }

  /** Forgets a stored sticker upload (e.g. its media was purged), so the next send uploads again. */
  deleteStickerMedia(stickerId: number | string): void {
    this.db
      .prepare('DELETE FROM zalo_file WHERE id IN (?, ?)')
      .run(stickerFileId(stickerId, false), stickerFileId(stickerId, true));
  }

  /**
   * Notes that a live photo / media message reached Matrix only as a failure notice.
   * A later failure of the same message replaces the row.
   *
   * @param zaloMsgId Zalo message id.
   * @param roomId Room the notice was posted in.
   * @param eventId Event id of the notice.
   * @param kind Media kind (photo, video, file, voice, gif, ...).
   * @param error Why the download failed (hosts and errors only, no signed URL).
   */
  recordMediaFailure(zaloMsgId: string, roomId: string, eventId: string, kind: string, error: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO media_failure (zalo_msg_id, room_id, event_id, kind, error, ts, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(zaloMsgId, roomId, eventId, kind, error.slice(0, 500), Date.now(), this.accountId);
  }

  /**
   * Rooms that still show failure notices, newest failure first. A failure counts while its
   * message row still points at the notice event: a rebuild that re-renders the message gives
   * it a new event id (or room) and so closes the failure.
   *
   * @returns One row per room: open failure count, the latest failure time and the kinds seen.
   */
  listOpenMediaFailures(): OpenMediaFailures[] {
    const rows = this.db
      .prepare(
        `SELECT f.room_id AS roomId, COUNT(*) AS count, MAX(f.ts) AS lastTs, GROUP_CONCAT(DISTINCT f.kind) AS kinds
         FROM media_failure f
         JOIN message m ON m.zalo_msg_id = f.zalo_msg_id AND m.event_id = f.event_id AND m.room_id = f.room_id
         GROUP BY f.room_id ORDER BY lastTs DESC`,
      )
      .all() as Array<{ roomId: string; count: number; lastTs: number; kinds: string | null }>;
    return rows.map((row) => ({ ...row, kinds: row.kinds ? row.kinds.split(',') : [] }));
  }

  /**
   * One open media failure (its message row still points at the notice), or null when it
   * is closed or was never recorded.
   */
  getOpenMediaFailure(zaloMsgId: string): { roomId: string; eventId: string; kind: string } | null {
    const row = this.db
      .prepare(
        `SELECT f.room_id AS roomId, f.event_id AS eventId, f.kind AS kind FROM media_failure f
         JOIN message m ON m.zalo_msg_id = f.zalo_msg_id AND m.event_id = f.event_id AND m.room_id = f.room_id
         WHERE f.zalo_msg_id = ?`,
      )
      .get(zaloMsgId) as { roomId: string; eventId: string; kind: string } | undefined;
    return row ?? null;
  }

  /**
   * Open media failures recorded since `sinceTs`, oldest first, with the Zalo thread of their
   * portal: what the media auto-repair queue picks up again after a restart.
   */
  listOpenMediaFailuresSince(
    sinceTs: number,
  ): Array<{ zaloMsgId: string; threadId: string; threadType: ZaloThreadType; ts: number }> {
    return this.db
      .prepare(
        `SELECT f.zalo_msg_id AS zaloMsgId, p.thread_id AS threadId, p.thread_type AS threadType, f.ts AS ts
         FROM media_failure f
         JOIN message m ON m.zalo_msg_id = f.zalo_msg_id AND m.event_id = f.event_id AND m.room_id = f.room_id
         JOIN portal p ON p.room_id = f.room_id
         WHERE f.ts >= ? ORDER BY f.ts`,
      )
      .all(sinceTs) as Array<{ zaloMsgId: string; threadId: string; threadType: ZaloThreadType; ts: number }>;
  }

  /**
   * Points a repaired message at the event that replaced its failure notice and drops the
   * failure row, in one transaction.
   */
  resolveMediaFailure(zaloMsgId: string, newEventId: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE message SET event_id = ? WHERE zalo_msg_id = ?').run(newEventId, zaloMsgId);
      this.db.prepare('DELETE FROM media_failure WHERE zalo_msg_id = ?').run(zaloMsgId);
    })();
  }

  /**
   * Drops a portal and its message mappings in one transaction (used to discard
   * malformed portals). No-op when the thread has no portal.
   */
  deletePortal(threadId: string): void {
    const portal = this.getPortalByThread(threadId);
    if (!portal) return;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM message WHERE room_id = ?').run(portal.room_id);
      this.db.prepare('DELETE FROM reaction WHERE room_id = ?').run(portal.room_id);
      this.db.prepare('DELETE FROM poll WHERE room_id = ?').run(portal.room_id);
      this.db.prepare('DELETE FROM media_failure WHERE room_id = ?').run(portal.room_id);
      this.db.prepare('DELETE FROM portal WHERE thread_id = ?').run(threadId);
    })();
  }

  /**
   * Removes puppets whose Zalo uid is not purely numeric (created from prefixed ids).
   * @returns Number of deleted puppet rows.
   */
  deleteMalformedPuppets(): number {
    return this.db.prepare("DELETE FROM puppet WHERE zalo_uid GLOB '*[^0-9]*'").run().changes;
  }

  /**
   * Records a new portal, stamped with the current time.
   * @throws On a UNIQUE violation when the thread or the room already has a portal.
   */
  insertPortal(row: PortalRow): void {
    this.db
      .prepare(
        'INSERT INTO portal (thread_id, thread_type, room_id, name, created_at, account_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.thread_id, row.thread_type, row.room_id, row.name, Date.now(), row.account_id ?? this.accountId);
  }

  /**
   * Upserts puppet; returns true when the display name changed (profile sync needed).
   * A null `displayName` never overwrites a known name, and a new puppet only
   * counts as changed when it arrives with a name.
   */
  upsertPuppet(zaloUid: string, mxid: string, displayName: string | null): boolean {
    const existing = this.db.prepare('SELECT display_name FROM puppet WHERE zalo_uid = ?').get(zaloUid) as
      { display_name: string | null } | undefined;
    if (!existing) {
      this.db
        .prepare('INSERT INTO puppet (zalo_uid, mxid, display_name, updated_at) VALUES (?, ?, ?, ?)')
        .run(zaloUid, mxid, displayName, Date.now());
      return displayName !== null;
    }
    if (displayName !== null && displayName !== existing.display_name) {
      this.db
        .prepare('UPDATE puppet SET display_name = ?, updated_at = ? WHERE zalo_uid = ?')
        .run(displayName, Date.now(), zaloUid);
      return true;
    }
    return false;
  }

  /**
   * Atomic dedup: returns false when this Zalo msgId was already recorded.
   * On a duplicate it backfills `event_id`, `cli_msg_id` and `quote_json` where
   * the stored value is still null (outbound send vs. selfListen echo race).
   * @param zaloMsgId Zalo message id (primary key).
   * @param roomId Portal room the message was bridged into.
   * @param eventId Matrix event_id, when known.
   * @param direction Which way the message was bridged.
   * @param quoteJson Serialized Zalo quote payload (needed to reply to this message).
   * @param cliMsgId Zalo client msg id (needed for reactions and recall).
   * @param senderId Zalo uid of the author (needed for "seen" events).
   * @param msgType Raw Zalo msg type (needed for "seen" events).
   * @returns True when a new row was inserted.
   */
  recordMessage(
    zaloMsgId: string,
    roomId: string,
    eventId: string | null,
    direction: MessageDirection,
    quoteJson: string | null = null,
    cliMsgId: string | null = null,
    senderId: string | null = null,
    msgType: string | null = null,
  ): boolean {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO message (zalo_msg_id, room_id, event_id, direction, ts, quote_json, cli_msg_id, sender_id, msg_type, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(zaloMsgId, roomId, eventId, direction, Date.now(), quoteJson, cliMsgId, senderId, msgType, this.accountId);
    if (result.changes === 0) {
      // Outbound send and its selfListen echo race to record the same msgId; each
      // carries a different piece (send → event_id, echo → cli_msg_id). Backfill
      // whichever null field the loser supplies so recall/receipts have both (the quote
      // payload of our own sends only arrives with the echo). Stored values always win.
      this.db
        .prepare(
          'UPDATE message SET event_id = COALESCE(event_id, ?), cli_msg_id = COALESCE(cli_msg_id, ?), quote_json = COALESCE(quote_json, ?) WHERE zalo_msg_id = ?',
        )
        .run(eventId, cliMsgId, quoteJson, zaloMsgId);
    }
    return result.changes === 1;
  }

  /** Quote payload for the Zalo message behind a Matrix event (reply mapping). */
  getQuoteJsonByEventId(eventId: string): string | null {
    const row = this.db.prepare('SELECT quote_json FROM message WHERE event_id = ?').get(eventId) as
      { quote_json: string | null } | undefined;
    return row?.quote_json ?? null;
  }

  /** Zalo target ids for a Matrix event — reaction/undo need msgId (+cliMsgId when known). */
  getZaloTargetByEventId(
    eventId: string,
  ): { zaloMsgId: string; cliMsgId: string | null; roomId: string; direction: MessageDirection } | null {
    const row = this.db
      .prepare('SELECT zalo_msg_id, cli_msg_id, room_id, direction FROM message WHERE event_id = ?')
      .get(eventId) as
      { zalo_msg_id: string; cli_msg_id: string | null; room_id: string; direction: MessageDirection } | undefined;
    return row
      ? { zaloMsgId: row.zalo_msg_id, cliMsgId: row.cli_msg_id, roomId: row.room_id, direction: row.direction }
      : null;
  }

  /**
   * Everything needed to send a Zalo "seen" event for a bridged inbound message.
   * Returns null for unknown events and for outbound (own) messages.
   */
  getSeenTargetByEventId(
    eventId: string,
  ): { zaloMsgId: string; cliMsgId: string | null; senderId: string | null; msgType: string | null } | null {
    const row = this.db
      .prepare('SELECT zalo_msg_id, cli_msg_id, sender_id, msg_type, direction FROM message WHERE event_id = ?')
      .get(eventId) as
      | {
          zalo_msg_id: string;
          cli_msg_id: string | null;
          sender_id: string | null;
          msg_type: string | null;
          direction: MessageDirection;
        }
      | undefined;
    if (!row || row.direction !== 'inbound') return null; // only mark the peer's messages seen
    return { zaloMsgId: row.zalo_msg_id, cliMsgId: row.cli_msg_id, senderId: row.sender_id, msgType: row.msg_type };
  }

  /** Matrix event_id (null when unknown) and room of a bridged Zalo msgId, or null when not bridged (reply/reaction mapping). */
  getEventByZaloMsgId(zaloMsgId: string): { eventId: string | null; roomId: string } | null {
    const row = this.db.prepare('SELECT event_id, room_id FROM message WHERE zalo_msg_id = ?').get(zaloMsgId) as
      { event_id: string | null; room_id: string } | undefined;
    return row ? { eventId: row.event_id, roomId: row.room_id } : null;
  }

  /**
   * Matrix event of a bridged message found by its client msgId in a room (reply mapping
   * fallback when the quote's global msgId is unknown). Rows with no recorded sender
   * (owner sends from Beeper) match any sender.
   */
  getEventIdByCliMsgId(roomId: string, cliMsgId: string, senderId: string | null): string | null {
    const row = this.db
      .prepare(
        'SELECT event_id FROM message WHERE room_id = ? AND cli_msg_id = ? AND event_id IS NOT NULL AND (sender_id IS NULL OR ? IS NULL OR sender_id = ?) ORDER BY ts DESC LIMIT 1',
      )
      .get(roomId, cliMsgId, senderId, senderId) as { event_id: string } | undefined;
    return row?.event_id ?? null;
  }

  /** Records a bridged reaction (either direction); a repeated event_id is ignored. */
  recordReaction(row: ReactionRow): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO reaction (event_id, room_id, target_msg_id, sender_id, zalo_icon, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.event_id, row.room_id, row.target_msg_id, row.sender_id, row.zalo_icon, Date.now());
  }

  /** The bridged reaction behind a Matrix m.reaction event, or null. */
  getReactionByEventId(eventId: string): ReactionRow | null {
    return (
      (this.db
        .prepare('SELECT event_id, room_id, target_msg_id, sender_id, zalo_icon FROM reaction WHERE event_id = ?')
        .get(eventId) as ReactionRow | undefined) ?? null
    );
  }

  /** Every bridged reaction one Zalo user has on one message, oldest first. */
  getReactions(targetMsgId: string, senderId: string): ReactionRow[] {
    return this.db
      .prepare(
        'SELECT event_id, room_id, target_msg_id, sender_id, zalo_icon FROM reaction WHERE target_msg_id = ? AND sender_id = ? ORDER BY ts, rowid',
      )
      .all(targetMsgId, senderId) as ReactionRow[];
  }

  /** Forgets one bridged reaction. */
  deleteReaction(eventId: string): void {
    this.db.prepare('DELETE FROM reaction WHERE event_id = ?').run(eventId);
  }

  /** Records a bridged poll (either direction); a repeated poll id or start event is ignored. */
  recordPoll(poll: Pick<PollRow, 'pollId' | 'roomId' | 'eventId' | 'creatorId' | 'options' | 'multi'>): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO poll (poll_id, room_id, event_id, creator_id, options_json, multi) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(poll.pollId, poll.roomId, poll.eventId, poll.creatorId, JSON.stringify(poll.options), poll.multi ? 1 : 0);
  }

  private pollFrom(row: PollDbRow | undefined): PollRow | null {
    if (!row) return null;
    return {
      pollId: row.poll_id,
      roomId: row.room_id,
      eventId: row.event_id,
      creatorId: row.creator_id,
      options: JSON.parse(row.options_json) as PollOptionMapping[],
      multi: row.multi === 1,
      closed: row.closed === 1,
      votes: JSON.parse(row.votes_json) as Record<string, number[]>,
    };
  }

  /** The bridged poll with this Zalo poll id, or null. */
  getPollById(pollId: number): PollRow | null {
    return this.pollFrom(this.db.prepare('SELECT * FROM poll WHERE poll_id = ?').get(pollId) as PollDbRow | undefined);
  }

  /** The bridged poll behind a Matrix poll.start event, or null. */
  getPollByEventId(eventId: string): PollRow | null {
    return this.pollFrom(
      this.db.prepare('SELECT * FROM poll WHERE event_id = ?').get(eventId) as PollDbRow | undefined,
    );
  }

  /** Replaces the last known votes of a poll (Zalo uid → picked option ids). */
  setPollVotes(pollId: number, votes: Record<string, number[]>): void {
    this.db.prepare('UPDATE poll SET votes_json = ? WHERE poll_id = ?').run(JSON.stringify(votes), pollId);
  }

  /** Marks a poll as locked / ended (`closed = false` reopens it, to undo a lock Zalo refused). */
  closePoll(pollId: number, closed = true): void {
    this.db.prepare('UPDATE poll SET closed = ? WHERE poll_id = ?').run(closed ? 1 : 0, pollId);
  }

  /** True when this Zalo msgId was already bridged (either direction). */
  hasMessage(zaloMsgId: string): boolean {
    return this.db.prepare('SELECT 1 FROM message WHERE zalo_msg_id = ?').get(zaloMsgId) !== undefined;
  }

  /** Closes the database handle; the store must not be used afterwards. */
  close(): void {
    this.db.close();
  }
}
