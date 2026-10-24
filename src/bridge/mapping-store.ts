// SQLite persistence: portal rooms, ghost puppets, message dedup/echo keys.
// better-sqlite3 sync API — single-user bridge volume makes async pooling YAGNI.
import Database from 'better-sqlite3';
import type { ZaloThreadType } from '../zalo/types.ts';

/** One `portal` row: the Matrix room a Zalo thread (DM or group) is bridged into. */
export type PortalRow = {
  thread_id: string;
  thread_type: ZaloThreadType;
  room_id: string;
  name: string | null;
};

/** Which way a message was bridged: Zalo → Matrix ('inbound') or Matrix → Zalo ('outbound'). */
export type MessageDirection = 'inbound' | 'outbound';

/** Target `PRAGMA user_version`; bump it together with a new step in `migrate()`. */
const SCHEMA_VERSION = 6;

/**
 * Synchronous SQLite-backed store for everything the bridge must remember across
 * restarts: portal rooms (Zalo thread ↔ Matrix room), ghost puppets (Zalo uid ↔
 * MXID + profile sync state) and bridged messages (Zalo msgId ↔ Matrix event_id,
 * used for dedup, echo guards, replies, reactions, recalls and read receipts).
 */
export class MappingStore {
  private readonly db: Database.Database;

  /**
   * Opens (or creates) the database file, switches it to WAL journaling and
   * brings the schema up to date.
   * @param dbPath Path of the SQLite file (created when missing).
   * @throws When the file cannot be opened or a migration fails.
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  /**
   * Applies every schema step newer than the stored `user_version`, then stamps
   * `SCHEMA_VERSION`. No-op when the database is already current.
   */
  private migrate(): void {
    const current = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (current >= SCHEMA_VERSION) return;
    // Transactional: a crash mid-migration must not leave ALTERs applied with a
    // stale user_version (re-running an ALTER = duplicate-column crash loop)
    this.db.transaction(() => {
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
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
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
      .prepare('SELECT thread_id, thread_type, room_id, name FROM portal WHERE thread_id = ?')
      .get(threadId) as PortalRow | undefined;
  }

  /** True when the Matrix room is the current portal of some Zalo thread. */
  isPortalRoom(roomId: string): boolean {
    return this.db.prepare('SELECT 1 FROM portal WHERE room_id = ?').get(roomId) !== undefined;
  }

  /** Portal behind a Matrix room, or undefined when the room is not a portal. */
  getPortalByRoom(roomId: string): PortalRow | undefined {
    return this.db.prepare('SELECT thread_id, thread_type, room_id, name FROM portal WHERE room_id = ?').get(roomId) as
      PortalRow | undefined;
  }

  /** Every known portal (startup repairs and the history importer iterate over these). */
  getAllPortals(): PortalRow[] {
    return this.db.prepare('SELECT thread_id, thread_type, room_id, name FROM portal').all() as PortalRow[];
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
        "INSERT OR IGNORE INTO message (zalo_msg_id, room_id, event_id, direction, ts) VALUES (?, ?, ?, 'outbound', ?)",
      )
      .run(`evt:${eventId}`, roomId, eventId, Date.now());
  }

  /** Matrix event for a Zalo msgId (read-receipt mapping). */
  getEventIdByMsgId(zaloMsgId: string): string | null {
    const row = this.db.prepare('SELECT event_id FROM message WHERE zalo_msg_id = ?').get(zaloMsgId) as
      { event_id: string | null } | undefined;
    return row?.event_id ?? null;
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
  }> {
    return this.db
      .prepare(
        "SELECT zalo_msg_id AS msgId, event_id AS eventId, direction, cli_msg_id AS cliMsgId, msg_type AS msgType FROM message WHERE room_id = ? AND zalo_msg_id NOT LIKE 'evt:%' ORDER BY ts, rowid",
      )
      .all(roomId) as Array<{
      msgId: string;
      eventId: string | null;
      direction: MessageDirection;
      cliMsgId: string | null;
      msgType: string | null;
    }>;
  }

  /** Zalo msgIds bridged into a room (outbound "evt:" echo guards excluded). */
  getRoomMessageIds(roomId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT zalo_msg_id FROM message WHERE room_id = ? AND zalo_msg_id NOT LIKE 'evt:%'")
      .all(roomId) as Array<{
      zalo_msg_id: string;
    }>;
    return new Set(rows.map((row) => row.zalo_msg_id));
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
        `INSERT INTO message (zalo_msg_id, room_id, event_id, direction, ts, cli_msg_id, msg_type) VALUES (?, ?, ?, ?, ?, ?, ?)
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
    return this.db.prepare('DELETE FROM message WHERE room_id = ?').run(roomId).changes;
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
      .prepare('INSERT INTO portal (thread_id, thread_type, room_id, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.thread_id, row.thread_type, row.room_id, row.name, Date.now());
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
        'INSERT OR IGNORE INTO message (zalo_msg_id, room_id, event_id, direction, ts, quote_json, cli_msg_id, sender_id, msg_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(zaloMsgId, roomId, eventId, direction, Date.now(), quoteJson, cliMsgId, senderId, msgType);
    if (result.changes === 0) {
      // Outbound send and its selfListen echo race to record the same msgId; each
      // carries a different piece (send → event_id, echo → cli_msg_id). Backfill
      // whichever null field the loser supplies so recall/receipts have both.
      if (eventId)
        this.db
          .prepare('UPDATE message SET event_id = ? WHERE zalo_msg_id = ? AND event_id IS NULL')
          .run(eventId, zaloMsgId);
      if (cliMsgId)
        this.db
          .prepare('UPDATE message SET cli_msg_id = ? WHERE zalo_msg_id = ? AND cli_msg_id IS NULL')
          .run(cliMsgId, zaloMsgId);
      // quote payload for our own sends only arrives with the echo (after outbound recorded it)
      if (quoteJson)
        this.db
          .prepare('UPDATE message SET quote_json = ? WHERE zalo_msg_id = ? AND quote_json IS NULL')
          .run(quoteJson, zaloMsgId);
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

  /** True when this Zalo msgId was already bridged (either direction). */
  hasMessage(zaloMsgId: string): boolean {
    return this.db.prepare('SELECT 1 FROM message WHERE zalo_msg_id = ?').get(zaloMsgId) !== undefined;
  }

  /** Closes the database handle; the store must not be used afterwards. */
  close(): void {
    this.db.close();
  }
}
