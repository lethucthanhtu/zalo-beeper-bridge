// Completeness audit before superseded rooms are deleted: every message the thread ever had
// (a baseline such as a pre-migration bridge.db, plus the rows still mapped to the old rooms)
// must be a real event in the new room, or be accounted for. Pure: the importer collects the
// inputs (store rows, the new room's timeline, the old rooms' events) and acts on the result.
import { isMediaKind } from './old-room-media.ts';

/** One message known to have existed in the thread (no content, metadata only). */
export type AuditRow = { msgId: string; eventId: string | null; direction: string; ts: number };

/** What the old room's Matrix event of a message that was not carried over looks like now. */
export type SourceState =
  | { state: 'redacted'; redactedBy?: string; reason?: string; ts?: number }
  | { state: 'present' }
  | { state: 'unreadable'; error: string };

export type AuditInput = {
  newRoom: string;
  /** rooms about to be deleted */
  oldRooms: string[];
  /** every event id in the new room's timeline */
  newTimeline: Set<string>;
  /** messages the thread had before the migration (for example from a bridge.db backup) */
  baseline: AuditRow[];
  /** rows the store still maps to the old rooms */
  oldRows?: AuditRow[];
  /** the store's current mapping of each msgId */
  current: Map<string, { roomId: string; eventId: string | null }>;
  /** the old-room event state of messages still mapped to an old room */
  sources: Map<string, SourceState>;
  /** msgIds the owner confirmed may be missing (for example deleted before the audit existed) */
  accepted: Set<string>;
  /**
   * message kinds (msgtype, see old-room-media.ts) of the old-room and new-room event of
   * messages that moved: a media message that arrived as text lost its media
   */
  kinds?: Map<string, { old: string; new: string }>;
  /**
   * msgIds the Zalo export records as recalled or deleted: their new event is the recall
   * marker, so media that became text there was withdrawn on Zalo, not lost
   */
  recalled?: Set<string>;
  /**
   * msgIds the rebuild posted as text although the export says media, while their old-room
   * event could not be decrypted: the old room may hold media the new room lacks
   */
  unverifiedMedia?: Set<string>;
};

/**
 * carried: a real event in the new room (media still media). redacted: deleted or recalled in the old room (the
 * redaction is recorded), or recalled on Zalo (the export says so) while the old room missed the recall. marker: a row that never had an event (a delete/recall the bridge
 * recorded). accepted: confirmed by the owner. missing: anything else (including media that became
 * text); blocks deletion.
 */
export type Verdict = 'carried' | 'redacted' | 'marker' | 'accepted' | 'missing';

export type AuditEntry = AuditRow & { verdict: Verdict; detail?: string };

export type AuditReport = {
  entries: AuditEntry[];
  counts: Record<Verdict, number>;
  /** msgIds that block deleting the old rooms */
  missing: string[];
};

/**
 * Classifies every baseline and old-room message (deduplicated by msgId, sorted by time).
 */
export function auditCompleteness(input: AuditInput): AuditReport {
  const rows = new Map<string, AuditRow>();
  for (const row of [...input.baseline, ...(input.oldRows ?? [])]) if (!rows.has(row.msgId)) rows.set(row.msgId, row);
  const oldRooms = new Set(input.oldRooms);
  const entries = [...rows.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((row): AuditEntry => ({ ...row, ...classify(row, input, oldRooms) }));
  const counts: Record<Verdict, number> = { carried: 0, redacted: 0, marker: 0, accepted: 0, missing: 0 };
  for (const entry of entries) counts[entry.verdict]++;
  return { entries, counts, missing: entries.filter((entry) => entry.verdict === 'missing').map((e) => e.msgId) };
}

function classify(row: AuditRow, input: AuditInput, oldRooms: Set<string>): { verdict: Verdict; detail?: string } {
  const now = input.current.get(row.msgId);
  if (now?.roomId === input.newRoom) {
    if (!now.eventId || !input.newTimeline.has(now.eventId))
      return { verdict: 'missing', detail: 'event not in the new room timeline' };
    const kind = input.kinds?.get(row.msgId);
    if (kind && isMediaKind(kind.old) && !isMediaKind(kind.new)) {
      if (input.recalled?.has(row.msgId)) return { verdict: 'redacted', detail: 'recalled on Zalo (export)' };
      if (input.accepted.has(row.msgId)) return { verdict: 'accepted' };
      return { verdict: 'missing', detail: `${kind.old} became ${kind.new} in the new room` };
    }
    if (input.unverifiedMedia?.has(row.msgId)) {
      if (input.recalled?.has(row.msgId)) return { verdict: 'redacted', detail: 'recalled on Zalo (export)' };
      if (input.accepted.has(row.msgId)) return { verdict: 'accepted' };
      return { verdict: 'missing', detail: 'media became text; the old-room event could not be decrypted' };
    }
    return { verdict: 'carried' };
  }
  if (!(now ? now.eventId : row.eventId)) return { verdict: 'marker' };
  if (input.accepted.has(row.msgId)) return { verdict: 'accepted' };
  if (!now) return { verdict: 'missing', detail: 'not in the store any more' };
  if (!oldRooms.has(now.roomId)) return { verdict: 'missing', detail: `mapped to ${now.roomId}` };
  const source = input.sources.get(row.msgId);
  if (source?.state === 'redacted') {
    const by = source.redactedBy ? `redacted by ${source.redactedBy}` : 'redacted';
    return { verdict: 'redacted', detail: source.reason ? `${by} (${source.reason})` : by };
  }
  if (source?.state === 'unreadable') return { verdict: 'missing', detail: `old event unreadable: ${source.error}` };
  return { verdict: 'missing', detail: 'still in the old room, not carried over' };
}
