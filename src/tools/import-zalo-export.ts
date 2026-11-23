// One-off history import: Zalo PC export (zexport out/ dir) → Beeper portal rooms,
// with original timestamps, via Beeper's batch-send backfill API
// (POST /_matrix/client/unstable/com.beeper.backfill/rooms/{roomId}/batch_send).
//
// Runs as a separate process next to the live bridge (same config, registration and
// bridge.db) — it only initialises the appservice intents, never listens, so the live
// bridge and bbctl proxy are untouched. No Zalo API calls: names come from the export.
//
// Usage (from the bridge's data dir, e.g. /data inside the container):
//   node /app/src/tools/import-zalo-export.ts <exportDir> [--only k1,k2] [--dry-run [--probe]]
//        [--rebuild [--carry-from !room1,!room2] [--remove-old] [--include-encrypted]]
//        [--retire !old1,!old2] [--verify] [--audit !old1,!old2]
//        [--baseline-db FILE] [--accept-missing id1,id2] [--reactions-only]
//        [--media-dir DIR] [--own-uid UID]
//        [--batch 100] [--delay-ms 1500] [--media-days 16]
//
// Messages render like the live bridge: photos/GIFs → m.image, stickers → m.sticker,
// videos → m.video, files → m.file, voice → m.audio, @mentions → pills, Zalo quotes →
// Matrix replies. Media comes from --media-dir (backup copies: <dir>/media-index.json
// {msgId: {file, mimetype, size, w?, h?, name?}}) or the Zalo CDN; when neither has
// it the message is posted as a readable text line.
//
// Default mode inserts BEFORE the room's oldest message (forward:false), newest chunk
// first, so live traffic stays at the bottom. --rebuild (requires --only) instead
// builds a NEW room per conversation with the full history oldest-first, then
// repoints the thread to it in bridge.db; the old room is left untouched. Messages the
// live bridge posted that the export lacks (Zalo PC missed them, or they arrived during
// the run) are replayed from the old room's Matrix events in timeline order.
// --remove-old then verifies the new room (every mapped message is a real event in its
// Beeper timeline) and only then deletes the superseded room(s); --retire does the same
// verify-then-delete for a thread rebuilt earlier. Before any delete, a completeness audit
// (also on its own: --audit, read-only) classifies every message the thread ever had, from
// --baseline-db (the pre-migration bridge.db, required for a delete) and the old rooms'
// mappings: carried (a real event in the new room), redacted (deleted/recalled in the old
// room, redaction verified), marker (a delete/recall row without an event), accepted
// (--accept-missing) or missing. Any missing message blocks the delete. The result is
// written as evidence (msgIds, times, verdicts; no content) to import-evidence/.
//
// Reactions: when the export has <key>.reactions.json (export-cdp.mjs), each reaction is
// posted after the messages as an m.reaction from the reactor's ghost (the owner's own as
// the owner), recorded in bridge.db like a live one, and skipped on a re-run.
// --reactions-only (with --only) posts just these into the current portal, to restore
// reactions a rebuild without the sidecar dropped.
//
// Encryption (config encryption.enabled): new rooms are created encrypted, and history
// into an encrypted room is encrypted (media too) by the importer's own bot device, whose
// store is `<encryption.storePath>-import` (never the live bridge's). --rebuild then
// migrates a plain portal to an encrypted room; a thread whose portal is already
// encrypted is skipped, so a migration can be re-run; --include-encrypted rebuilds it anyway
// (a room encrypted in place still holds plain history). Encrypted live events in the old
// room cannot be read by the importer and are reported as not carried over.
//
// Safety: send_notification=false and mark_read_by=owner keep it silent; every event
// carries SELF_BRIDGE_MARKER so the live bridge never sends imported owner messages
// back to Zalo; msgIds are recorded, so a re-run skips what was already imported.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { Bridge } from 'matrix-appservice-bridge';
import { loadConfig } from '../config.ts';
import {
  dropShadowCopies,
  parseReactionSidecar,
  parseThreadKey,
  quoteFallback,
  renderExportRow,
  type ExportRow,
  type ImportEvent,
} from '../bridge/history-import.ts';
import { animatedSticker } from '../bridge/animated-sticker.ts';
import { MappingStore, type StickerMedia } from '../bridge/mapping-store.ts';
import { ownerIntent } from '../bridge/owner-intent.ts';
import {
  buildLinkPreview,
  buildMediaEvent,
  fetchFirstMedia,
  LARGE_MEDIA_MAX_BYTES,
  mediaMaxBytesFor,
  roomUploader,
  stickerContent,
} from '../bridge/media-content.ts';
import { downloadMatrixMedia, sniffMimetype } from '../bridge/media-fetch.ts';
import { buildInboundMentions } from '../bridge/mentions.ts';
import { SELF_BRIDGE_MARKER } from '../bridge/self-bridge.ts';
import { PortalManager } from '../bridge/portal-manager.ts';
import { PuppetRegistry } from '../bridge/puppet-registry.ts';
import { bridgeIdFor } from '../matrix/bridge-id.ts';
import { installCalmRetry } from '../matrix/calm-retry.ts';
import { loadRegistration } from '../matrix/appservice.ts';
import { decryptAttachment, initBotCrypto } from '../matrix/crypto.ts';
import {
  DOUBLE_PUPPET_SOURCE_KEY,
  encryptHistoryBatch,
  historyCryptoEngine,
  type BatchEvent,
} from '../matrix/history-encryption.ts';
import { bridgeBranding } from '../matrix/network-branding.ts';
import { zaloRTypeToIcon, zaloToEmoji } from '../zalo/reaction-map.ts';
import { errorMessage } from '../error-message.ts';
import { sleep } from '../util.ts';
import { auditCompleteness, type AuditRow, type SourceState } from './completeness-audit.ts';
import { isMediaKind, mediaKindOf, mediaRef, messageKind, type RebuiltMediaKind } from './old-room-media.ts';
import {
  findStillUnsupported,
  isFailedMediaNotice,
  rerenderStored,
  unsupportedNoticeType,
  type Rerendered,
} from './rerender-unsupported.ts';

// ---------------------------------------------------------------------------
// Constants, CLI parsing and small helpers
// ---------------------------------------------------------------------------

/** Content key tagging every imported event (alongside SELF_BRIDGE_MARKER). */
const IMPORT_MARKER = 'com.zalo-bridge.history_import';
/** History media is mostly expired: fail fast instead of the live 30 s timeout */
const IMPORT_FETCH_TIMEOUT_MS = 10_000;
/** Old-room media sits on our own homeserver and is often a large video: allow minutes */
const OLD_ROOM_FETCH_TIMEOUT_MS = 5 * 60_000;
/** Messages of one batch whose media/previews are prepared concurrently */
const PREPARE_CONCURRENCY = 6;
/** CDN hosts that keep media long-term (Zalo Cloud, resources, GIFs, stickers) */
const PERMANENT_HOST = /(zpcloud|zfcloud|res-zalo|zalo-gif|zgif|zalo-api)\./;

/**
 * Parses the command line (see the usage in the header comment) with node:util parseArgs:
 * the one positional argument is the export directory.
 *
 * @param argv the arguments after `node <script>`
 * @returns the parsed options, defaults filled in
 * @throws on an unknown/extra argument, a flag missing its value, a missing export dir,
 *   `--rebuild` without `--only`, `--include-encrypted` without `--rebuild`, `--retire`/`--audit` without exactly
 *   one `--only` conversation, `--retire`/`--remove-old` without `--baseline-db`, a missing baseline file,
 *   or `--reactions-only` without `--only` or with `--rebuild`/`--verify`/`--retire`/`--audit`
 */
function parseCommandLine(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      only: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      probe: { type: 'boolean', default: false },
      rebuild: { type: 'boolean', default: false },
      'media-dir': { type: 'string' },
      'own-uid': { type: 'string' },
      'carry-from': { type: 'string', multiple: true },
      'remove-old': { type: 'boolean', default: false },
      'include-encrypted': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      retire: { type: 'string' },
      batch: { type: 'string' },
      'delay-ms': { type: 'string' },
      'media-days': { type: 'string' },
      audit: { type: 'string' },
      'baseline-db': { type: 'string' },
      'accept-missing': { type: 'string' },
      'reactions-only': { type: 'boolean', default: false },
    },
  });
  /** A flag's value as a whole number ≥ min (NaN or fractions would break batching/pacing). */
  const integerOf = (flag: 'batch' | 'delay-ms' | 'media-days', fallback: number, min: number): number => {
    if (values[flag] === undefined) return fallback;
    const value = Number(values[flag]);
    if (!Number.isInteger(value) || value < min) throw new Error(`--${flag} needs a whole number ≥ ${min}`);
    return value;
  };
  const [dir, extra] = positionals;
  if (!dir) {
    throw new Error(
      'usage: import-zalo-export.ts <exportDir> [--only k1,k2] [--dry-run] [--rebuild] [--verify] [--audit !old1,!old2] [--retire !old1,!old2] [--baseline-db FILE] [--accept-missing id1,id2] [--reactions-only] [--media-dir DIR] [--own-uid UID] [--batch N] [--delay-ms N] [--media-days N]',
    );
  }
  if (extra !== undefined) throw new Error(`unknown argument ${extra}`);
  const parsed = {
    dir,
    only: values.only ? new Set(values.only.split(',')) : null,
    dryRun: values['dry-run'],
    probe: values.probe,
    rebuild: values.rebuild,
    mediaDir: values['media-dir'] ?? null,
    ownUid: values['own-uid'] ?? null,
    /** extra earlier rooms of the same thread whose live-only messages must be kept */
    carryFrom: values['carry-from']?.flatMap((rooms) => rooms.split(',')) ?? [],
    /** after a verified rebuild, delete the superseded room(s) */
    removeOld: values['remove-old'],
    /** also rebuild a thread whose portal is already encrypted (encryption turned on in place) */
    includeEncrypted: values['include-encrypted'],
    /** read-only: check each --only thread's portal room against the export + timeline */
    verify: values.verify,
    /** verify the current portal of the (single) --only thread, then remove these rooms */
    retire: values.retire?.split(',') ?? null,
    /** read-only: audit the (single) --only thread's completeness against these old rooms ('' = baseline only) */
    audit: values.audit === undefined ? null : values.audit.split(',').filter(Boolean),
    /** bridge.db from before the migration: every message it maps for the thread is audited */
    baselineDb: values['baseline-db'] ?? null,
    /** msgIds the owner confirmed may be missing (not carried, not provably redacted) */
    acceptMissing: new Set(values['accept-missing']?.split(',').filter(Boolean) ?? []),
    /** only post the <key>.reactions.json reactions into the current portal (messages already imported) */
    reactionsOnly: values['reactions-only'],
    batch: integerOf('batch', 100, 1),
    delayMs: integerOf('delay-ms', 1500, 0),
    mediaDays: integerOf('media-days', 16, 0),
  };
  if (parsed.rebuild && !parsed.only) throw new Error('--rebuild needs an explicit --only list of conversations');
  if (parsed.includeEncrypted && !parsed.rebuild) throw new Error('--include-encrypted only applies to --rebuild');
  if (parsed.retire && parsed.only?.size !== 1) throw new Error('--retire needs exactly one --only conversation');
  if (parsed.audit && parsed.only?.size !== 1) throw new Error('--audit needs exactly one --only conversation');
  if (parsed.audit?.length === 0 && !parsed.baselineDb)
    throw new Error("--audit '' (no old rooms: the current portal against the baseline) needs --baseline-db");
  if ((parsed.retire || parsed.removeOld) && !parsed.baselineDb)
    throw new Error(
      '--retire and --remove-old need --baseline-db (the pre-migration bridge.db) for the completeness audit',
    );
  if (parsed.reactionsOnly && !parsed.only) throw new Error('--reactions-only needs an explicit --only list');
  if (parsed.reactionsOnly && (parsed.rebuild || parsed.verify || parsed.retire || parsed.audit))
    throw new Error('--reactions-only cannot be combined with --rebuild, --verify, --retire or --audit');
  if (parsed.baselineDb && !fs.existsSync(parsed.baselineDb))
    throw new Error(`--baseline-db ${parsed.baselineDb} not found`);
  return parsed;
}

/**
 * Order-preserving map with at most `limit` calls in flight.
 * A rejection of `fn` rejects the whole map (remaining workers keep draining items).
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  /** Pulls the next unclaimed item until none are left; results land at the item's index. */
  const runWorker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return results;
}

/** Resolves after `ms` milliseconds (pacing between batch_send calls). */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** conversations.json of the export: thread list, group names (gmap) and friend names (fmap). */
type ExportMeta = {
  convs: Array<{ key: string; isGroup: boolean }>;
  gmap: Record<string, string | null>;
  fmap: Record<string, string | null>;
};

/** One media-index.json entry of a --media-dir backup (file is relative to the dir). */
type LocalMedia = {
  file: string;
  mimetype: string;
  size: number;
  w?: number;
  h?: number;
  name?: string;
};

/** Resolved media bytes plus where they came from (counted in the per-thread stats). */
type Media = {
  buffer: Buffer;
  mimetype: string;
  width?: number;
  height?: number;
  source: 'local' | 'cdn' | 'animated' | 'old-room';
};

/** Where a message's event sits in the room a rebuild replaces. */
type OldEvent = { roomId: string; eventId: string };

/** A message mapped to its event in the new room, as stored by MappingStore.repointPortal. */
type RepointRow = {
  msgId: string;
  eventId: string;
  direction: 'inbound' | 'outbound';
  cliMsgId: string | null;
  msgType: string | null;
};

/** A Matrix event as returned by GET /rooms/{roomId}/event/{eventId}. */
type RawEvent = {
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
};

/** A live-bridged message the export lacks, to be replayed from its Matrix event. */
type LiveItem = {
  kind: 'live';
  ts: number;
  row: ReturnType<MappingStore['getRoomMessages']>[number];
  raw: RawEvent;
  /** Zalo msgId the live event replied to (for chunk ordering + remap) */
  replyToMsgId?: string;
  /** a "not supported" notice whose stored Zalo payload renders today: post this instead */
  rerender?: Rerendered;
};

/** One entry of a rebuild timeline: an export message or a live-only message. */
type Item = { kind: 'export'; ev: ImportEvent; ts: number } | LiveItem;

// ---------------------------------------------------------------------------
// Startup: config, export files, name index
// ---------------------------------------------------------------------------

// Beeper resets streams with ENHANCE_YOUR_CALM during a long import: wait and send the request
// again (batch sends, key shares, uploads, room deletes) instead of failing the chat.
installCalmRetry((retry, delayMs) =>
  console.warn(`[import] Beeper asked to slow down (ENHANCE_YOUR_CALM), retry ${retry} in ${delayMs / 1000}s`),
);

const cliOptions = parseCommandLine(process.argv.slice(2));
const config = loadConfig();
const registration = loadRegistration(config.matrix.registrationPath);
const bridgeAppId = bridgeIdFor(registration.getSenderLocalpart() ?? undefined);
const branding = bridgeBranding(config, {
  id: registration.getId(),
  sender_localpart: registration.getSenderLocalpart(),
});
const owner = config.matrix.owner;

const exportMeta = JSON.parse(fs.readFileSync(path.join(cliOptions.dir, 'conversations.json'), 'utf8')) as ExportMeta;
const threadKeys = fs
  .readdirSync(cliOptions.dir)
  .filter((fileName) => fileName.endsWith('.ndjson'))
  .map((fileName) => fileName.slice(0, -'.ndjson'.length))
  .filter((key) => !cliOptions.only || cliOptions.only.has(key));
const localMedia: Record<string, LocalMedia> = cliOptions.mediaDir
  ? (JSON.parse(fs.readFileSync(path.join(cliOptions.mediaDir, 'media-index.json'), 'utf8')) as Record<
      string,
      LocalMedia
    >)
  : {};

/** Every msgId in the export file, shadow copies included (they are known, just not posted). */
const exportedIds = new Map<string, Set<string>>();

/** msgIds with an old-room event this run could not decrypt (key only on the live bridge's device). */
const undecryptableMsgIds = new Set<string>();
/**
 * msgIds a rebuild posted as text although the export says media (or a link) while their old-room
 * event could not be decrypted: the old room may hold media the new room lacks, so deleting it
 * could lose data. The completeness audit reports them as missing.
 */
const unverifiedMedia = new Set<string>();

/** Where a rebuild records what it moved out of the old rooms, for an audit run later (metadata only). */
function rebuildRecordFile(threadId: string): string {
  return path.resolve('import-evidence', `${threadId}-rebuild.json`);
}

/** What a rebuild moved out of its source rooms: the audit's view of the old rooms after the repoint. */
type RebuildRecord = {
  newRoom: string;
  moved: Array<AuditRow & { roomId: string }>;
  unverifiedMedia: string[];
};

/**
 * Reads `<exportDir>/<key>.ndjson` (synchronous file read), records every msgId in
 * `exportedIds`, and returns the rows without the owner's shadow copies.
 *
 * @throws when the file is missing or a line is not valid JSON
 */
function readRows(key: string): ExportRow[] {
  const text = fs.readFileSync(path.join(cliOptions.dir, `${key}.ndjson`), 'utf8');
  const rows = text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ExportRow);
  exportedIds.set(key, new Set(rows.map((row) => String(row.msgId))));
  return dropShadowCopies(rows);
}

/** Best-known display name per Zalo uid: friend list first, then the latest dName seen. */
function nameIndex(rowsByKey: Map<string, ExportRow[]>): Map<string, string> {
  const names = new Map<string, string>();
  for (const rows of rowsByKey.values())
    for (const row of rows) if (row.fromUid && row.fromUid !== '0' && row.dName) names.set(row.fromUid, row.dName);
  for (const [uid, name] of Object.entries(exportMeta.fmap)) if (name) names.set(uid, name);
  return names;
}

const rowsByKey = new Map(threadKeys.map((key) => [key, readRows(key)] as const));
const names = nameIndex(rowsByKey);

/**
 * The renderable messages of one conversation, oldest first (ties broken by msgId so
 * the order is stable across runs). Rows with nothing to show are dropped.
 */
function eventsFor(key: string): ImportEvent[] {
  const { threadId, threadType } = parseThreadKey(key);
  return rowsByKey
    .get(key)!
    .map((row) => renderExportRow(row, threadType, threadId))
    .filter((event): event is ImportEvent => event !== null)
    .sort((a, b) => a.timestamp - b.timestamp || (a.msgId < b.msgId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Media resolution and Matrix event building
// ---------------------------------------------------------------------------

/**
 * Whether a CDN URL may still serve the media: permanent hosts always, other hosts only
 * for messages younger than --media-days (Zalo CDN links expire), to avoid slow misses.
 */
const cdnWorthTrying = (url: string, ts: number) =>
  PERMANENT_HOST.test(url) || Date.now() - ts <= cliOptions.mediaDays * 86_400_000;

// Stickers repeat a lot — fetch (and upload) each id once per run
const stickerCache = new Map<number, Promise<Media | null>>();

/**
 * Backup copy first, then the CDN candidates; null when no copy is reachable.
 * Stickers are built as animated WebP from the sprite strip (falling back to the still
 * image) and cached per sticker id. Side effects: file reads and network downloads.
 */
async function resolveMedia(event: ImportEvent): Promise<Media | null> {
  const media = event.media;
  if (!media) return null;
  const local = localMedia[event.msgId];
  if (local && cliOptions.mediaDir) {
    try {
      const buffer = fs.readFileSync(path.join(cliOptions.mediaDir, local.file));
      return {
        buffer,
        mimetype: sniffMimetype(buffer, local.mimetype),
        width: local.w,
        height: local.h,
        source: 'local',
      };
    } catch {
      // fall through to the CDN
    }
  }
  if (media.kind === 'sticker' && media.stickerId) {
    const id = media.stickerId;
    let cached = stickerCache.get(id);
    if (!cached) {
      // Animated WebP built from the sprite strip; still PNG/GIF for single-frame stickers
      cached = animatedSticker(id).then(async (animated) =>
        animated
          ? {
              buffer: animated.buffer,
              mimetype: animated.mimetype,
              width: animated.width,
              height: animated.height,
              source: 'animated' as const,
            }
          : fromCdn(fetchFirstMedia(media.urls, config.bridge.mediaMaxBytes, IMPORT_FETCH_TIMEOUT_MS)),
      );
      stickerCache.set(id, cached);
    }
    return cached;
  }
  return fromCdn(
    fetchFirstMedia(
      media.urls.filter((url) => cdnWorthTrying(url, event.timestamp)),
      mediaMaxBytesFor(media.kind, config.bridge.mediaMaxBytes),
      IMPORT_FETCH_TIMEOUT_MS,
    ),
  );
}

/** Tags a CDN download as `source: 'cdn'` (the import report counts media by source). */
async function fromCdn(pending: ReturnType<typeof fetchFirstMedia>): Promise<Media | null> {
  const found = await pending;
  return found ? { ...found, source: 'cdn' } : null;
}

/**
 * The media of a message's event in the room a rebuild replaces: the bytes the bridge uploaded
 * when the message was first bridged, still on the homeserver after the Zalo CDN link expired.
 * The event is read as the owner (decrypted with the importer's device when encrypted), the
 * media downloaded with the appservice token and decrypted when it was uploaded encrypted.
 *
 * The candidates are tried in order (the room the store points at, then the --baseline-db room);
 * the first one that holds media wins.
 *
 * @returns the media tagged `source: 'old-room'` with its kind, or null (logged when a download
 *   failed) when no candidate is media (redacted, already text, undecryptable) or every
 *   download fails
 */
async function oldRoomMedia(
  candidates: OldEvent[],
  msgId: string,
): Promise<{ media: Media; kind: RebuiltMediaKind } | null> {
  let lastError: unknown;
  for (const oldEvent of candidates) {
    try {
      const wire = (await ownerIntent(bridge, owner).matrixClient.getRawEvent(
        oldEvent.roomId,
        oldEvent.eventId,
      )) as RawEvent;
      if (isRedacted(wire)) continue;
      const raw = wire.type === 'm.room.encrypted' ? await decryptLive(wire, oldEvent.roomId, msgId) : wire;
      const ref = raw ? mediaRef(raw) : null;
      const kind = raw ? mediaKindOf(messageKind(raw)) : null;
      if (!ref || !kind) continue;
      const downloaded = await downloadMatrixMedia(
        config.matrix.homeserverUrl,
        registration.getAppServiceToken()!,
        ref.mxc,
        Math.max(config.bridge.mediaMaxBytes, LARGE_MEDIA_MAX_BYTES),
        OLD_ROOM_FETCH_TIMEOUT_MS,
      );
      const buffer = ref.file === undefined ? downloaded.buffer : decryptAttachment(downloaded.buffer, ref.file);
      return {
        kind,
        media: {
          buffer,
          mimetype: sniffMimetype(buffer, ref.mimetype ?? downloaded.mimetype),
          width: ref.width,
          height: ref.height,
          source: 'old-room',
        },
      };
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError !== undefined)
    console.warn(`[import] media of ${msgId} not in the old room either:`, errorMessage(lastError));
  return null;
}

/**
 * Drops a sticker whose bytes are not an image (a few-byte non-image body from the CDN, or a
 * broken copy in the old room): Beeper cannot display it, so the next source or the text line
 * is used instead. Other kinds pass unchanged.
 *
 * @returns `found`, or null when it is a sticker that is not an image (logged)
 */
function usableMedia(kind: string, found: Media | null, msgId: string): Media | null {
  if (!found || kind !== 'sticker' || found.mimetype.startsWith('image/')) return found;
  console.warn(
    `[import] sticker of ${msgId} from ${found.source} is not an image (${found.buffer.byteLength} bytes, ${found.mimetype}), skipped`,
  );
  return null;
}

/** Content-repo uploaders as the bridge bot (`bot` is assigned before the first call). */
const uploaders = {
  plain: roomUploader((buffer, uploadOptions) => bot.uploadContent(buffer, uploadOptions), false),
  /** For encrypted rooms: uploads ciphertext, the key goes into the event's `file`. */
  encrypted: roomUploader((buffer, uploadOptions) => bot.uploadContent(buffer, uploadOptions), true),
};

// Uploaded sticker images per room mode and sticker id (stickerCache dedupes the download, this
// the upload). Backed by the store's zalo_file table, shared with the live bridge.
const stickerMxc = new Map<string, StickerMedia>();

/** An earlier upload of this sticker in this mode (this run, an earlier run or the live bridge), or null. */
function cachedSticker(stickerId: number, encrypted: boolean): StickerMedia | null {
  const key = `${encrypted ? 'encrypted' : 'plain'}:${stickerId}`;
  const hit = stickerMxc.get(key) ?? store.getStickerMedia(stickerId, encrypted);
  if (hit) stickerMxc.set(key, hit);
  return hit;
}

/**
 * Matrix event (type + content) for an import event, shaped like the live bridge's
 * posts. Media is uploaded here; unreachable media falls back to the text line.
 * Link cards get a com.beeper.linkpreviews entry (thumbnail uploaded when reachable);
 * person mentions become pills unless a quote fallback was prefixed to the body.
 *
 * @param replyTo event id of the quoted message in the target room, or null when it is
 *   not available (then the quote is rendered as a "> name: text" prefix)
 * @param stats per-kind counters (`<kind>:<source>`, `<kind>:text`, `link:preview`), mutated
 * @param encrypted whether the target room is encrypted (media is then uploaded encrypted)
 * @param oldEvents the message's events in the room(s) a rebuild replaces: their media is used
 *   when neither the backup copy nor the CDN has it any more, and for a link card whose old
 *   event is media (Zalo exports some shared photos as links)
 */
async function buildEvent(
  event: ImportEvent,
  replyTo: string | null,
  stats: Record<string, number>,
  encrypted: boolean,
  oldEvents: OldEvent[] = [],
): Promise<{ type: string; content: Record<string, unknown> }> {
  const upload = encrypted ? uploaders.encrypted : uploaders.plain;
  const replyRelation = replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {};
  if (!event.media && event.linkPreview && oldEvents.length) {
    const fromOldRoom = await oldRoomMedia(oldEvents, event.msgId);
    if (fromOldRoom) {
      stats['link:old-room'] = (stats['link:old-room'] ?? 0) + 1;
      const built = await buildMediaEvent(upload, { kind: fromOldRoom.kind, urls: [] }, fromOldRoom.media);
      return { type: built.type, content: { ...built.content, ...replyRelation } };
    }
  }
  const descriptor = event.media;
  const stickerId = descriptor?.kind === 'sticker' ? descriptor.stickerId : undefined;
  const reusable = stickerId ? cachedSticker(stickerId, encrypted) : null;
  if (stickerId && reusable) {
    // Already uploaded in this mode: no download, no upload
    stats['sticker:cache'] = (stats['sticker:cache'] ?? 0) + 1;
    return { type: 'm.sticker', content: { ...stickerContent(reusable, stickerId), ...replyRelation } };
  }
  const resolved = descriptor
    ? (usableMedia(descriptor.kind, await resolveMedia(event), event.msgId) ??
      (oldEvents.length
        ? usableMedia(descriptor.kind, (await oldRoomMedia(oldEvents, event.msgId))?.media ?? null, event.msgId)
        : null))
    : null;
  if (descriptor && resolved) {
    stats[`${descriptor.kind}:${resolved.source}`] = (stats[`${descriptor.kind}:${resolved.source}`] ?? 0) + 1;
    const built = await buildMediaEvent(upload, descriptor, resolved, { filename: localMedia[event.msgId]?.name });
    if (stickerId) {
      // usableMedia() let only an image through, so the upload is safe to reuse
      const media: StickerMedia = {
        uploaded: built.uploaded,
        mimetype: resolved.mimetype,
        size: resolved.buffer.byteLength,
        ...((descriptor.width ?? resolved.width) ? { w: descriptor.width ?? resolved.width } : {}),
        ...((descriptor.height ?? resolved.height) ? { h: descriptor.height ?? resolved.height } : {}),
      };
      stickerMxc.set(`${encrypted ? 'encrypted' : 'plain'}:${stickerId}`, media);
      store.putStickerMedia(stickerId, encrypted, media);
    }
    return { type: built.type, content: { ...built.content, ...replyRelation } };
  }
  if (descriptor) stats[`${descriptor.kind}:text`] = (stats[`${descriptor.kind}:text`] ?? 0) + 1;
  // Media (or a link the old room may show as media) became text while the old-room copy could
  // not be read: that room must not be deleted on this run's word
  if ((descriptor || event.linkPreview) && undecryptableMsgIds.has(event.msgId)) {
    unverifiedMedia.add(event.msgId);
    stats['old-room:undecryptable'] = (stats['old-room:undecryptable'] ?? 0) + 1;
  }

  const body = (event.quote && !replyTo ? quoteFallback(event.quote) : '') + event.content.body;
  const content: Record<string, unknown> = { msgtype: event.content.msgtype, body, ...replyRelation };
  const action = event.content['com.beeper.action_message'];
  if (action) content['com.beeper.action_message'] = action;
  if (event.linkPreview) {
    content['com.beeper.linkpreviews'] = [
      await buildLinkPreview(upload, event.linkPreview, config.bridge.mediaMaxBytes, IMPORT_FETCH_TIMEOUT_MS),
    ];
    stats['link:preview'] = (stats['link:preview'] ?? 0) + 1;
  }
  if (event.mentions?.length && !(event.quote && !replyTo)) {
    // positions are relative to the original text — only valid without the quote prefix
    const { formattedBody, userIds } = buildInboundMentions(event.content.body, event.mentions, (uid) =>
      uid === cliOptions.ownUid ? owner : puppets.mxidFor(uid),
    );
    content.format = 'org.matrix.custom.html';
    content.formatted_body = formattedBody;
    content['m.mentions'] = { user_ids: userIds };
  }
  return { type: 'm.room.message', content };
}

/** Display name for a conversation: the group name, or the DM peer's best-known name; null if unknown. */
function labelOf(key: string): string | null {
  const { threadId, threadType } = parseThreadKey(key);
  return threadType === 'group' ? (exportMeta.gmap[key] ?? null) : (names.get(threadId) ?? null);
}

// ---------------------------------------------------------------------------
// --dry-run: summarise what would be imported, then exit (no Matrix connection)
// ---------------------------------------------------------------------------

if (cliOptions.dryRun) {
  let total = 0;
  for (const key of rowsByKey.keys()) {
    const events = eventsFor(key);
    total += events.length;
    const kinds: Record<string, number> = {};
    let quotes = 0;
    const eventMsgIds = new Set(events.map((event) => event.msgId));
    for (const event of events) {
      // --probe: actually fetch each attachment (no upload) to see which still resolve
      const probeResult =
        event.media && cliOptions.probe && !localMedia[event.msgId]
          ? (await resolveMedia(event))
            ? '(cdn)'
            : '(text)'
          : '';
      const kindLabel = event.media
        ? `${event.media.kind}${localMedia[event.msgId] ? '(local)' : probeResult}`
        : event.content.msgtype;
      kinds[kindLabel] = (kinds[kindLabel] ?? 0) + 1;
      if (event.quote?.msgId && eventMsgIds.has(event.quote.msgId)) quotes++;
    }
    if (events.length)
      console.log(
        `${key} (${labelOf(key) ?? '?'}): ${events.length} events ${JSON.stringify(kinds)}, ${quotes} replies`,
      );
  }
  console.log(`dry run: ${total} events in ${rowsByKey.size} conversations`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Matrix side: appservice intents, store, batch_send
// ---------------------------------------------------------------------------

const bridge = new Bridge({
  homeserverUrl: config.matrix.homeserverUrl,
  domain: config.matrix.domain,
  registration,
  disableStores: true,
  controller: { onEvent: () => undefined },
});
await bridge.initialise(); // intents only — no listener, the live bridge keeps the port

const store = new MappingStore(config.bridge.dbPath);
// imported rows belong to this account (without --own-uid the live bridge files them on its next login)
if (cliOptions.ownUid) store.useAccount(cliOptions.ownUid);
const puppets = new PuppetRegistry(bridge, store, config.matrix.domain, undefined, `${bridgeAppId}_`);
const bot = bridge.getIntent();
// With encryption on, new rooms are created encrypted and history sent into encrypted rooms
// is encrypted by a bot device of the importer's own: never the live bridge's store, which
// the running bridge holds open
const importerCrypto = config.encryption.enabled
  ? await initBotCrypto({
      homeserverUrl: config.matrix.homeserverUrl,
      botUserId: bot.userId,
      asToken: registration.getAppServiceToken()!,
      storePath: path.join(
        path.dirname(config.encryption.storePath),
        `${path.basename(config.encryption.storePath)}-import`,
      ),
      deviceDisplayName: 'Zalo bridge (history import)',
    })
  : undefined;
const historyEngine = importerCrypto ? historyCryptoEngine(importerCrypto.client) : undefined;
const portals = new PortalManager(bridge, store, puppets, owner, branding, () => importerCrypto?.rooms);

/** Whether a room is encrypted (always false with encryption off). */
const isEncryptedRoom = async (roomId: string): Promise<boolean> =>
  importerCrypto ? importerCrypto.rooms.isEncrypted(roomId) : false;

/**
 * Posts events through Beeper's batch_send backfill endpoint as the bridge bot, silently
 * (no notifications, read by the owner). Events for an encrypted room are encrypted first.
 *
 * @param forward true appends after the newest message; false inserts before the oldest
 *   (an empty room is always appended to, forward_if_no_messages)
 * @returns the new event ids, positionally matching `events` (may be shorter/empty)
 * @throws when the homeserver rejects the request, or the room key cannot be shared
 */
async function batchSend(roomId: string, events: readonly BatchEvent[], forward: boolean): Promise<string[]> {
  const wireEvents =
    historyEngine && (await isEncryptedRoom(roomId))
      ? await encryptHistoryBatch(historyEngine, roomId, events)
      : events;
  const response = (await bot.matrixClient.doRequest(
    'POST',
    `/_matrix/client/unstable/com.beeper.backfill/rooms/${encodeURIComponent(roomId)}/batch_send`,
    null,
    { forward, forward_if_no_messages: true, send_notification: false, mark_read_by: owner, events: wireEvents },
  )) as { event_ids?: string[] };
  return response.event_ids ?? [];
}

/**
 * Senders must be members: DM peer created the room; group ghosts are invited + joined.
 * Ensures a puppet (Matrix profile) for every ghost sender and, in groups, its membership.
 *
 * @returns uids of group ghosts that could not be prepared (their messages go out as the bot)
 * @throws in a DM when the peer's puppet cannot be prepared
 */
async function prepareSenders(
  events: ImportEvent[],
  roomId: string,
  threadType: 'user' | 'group',
  key: string,
): Promise<Set<string>> {
  const ghostIds = new Set(events.flatMap((event) => (event.sender.kind === 'ghost' ? [event.sender.uid] : [])));
  // A ghost that cannot join must not sink the whole group: its messages go out as the bot
  const failedGhosts = new Set<string>();
  for (const uid of ghostIds) {
    const name = names.get(uid);
    try {
      await puppets.ensurePuppet(uid, name);
      if (threadType === 'group') await portals.ensureGhostInRoom(uid, roomId, name);
    } catch (err) {
      if (threadType === 'user') throw err; // the DM peer created the room — nothing to fall back to
      failedGhosts.add(uid);
      console.warn(`[import] ghost ${uid} unavailable in ${key}, sending as bot:`, errorMessage(err));
    }
  }
  return failedGhosts;
}

/**
 * Full batch_send entry for an export message: the built event plus sender, original
 * timestamp and the import/self-bridge markers. Owner messages are tagged as double-puppet
 * sourced; messages of a failed ghost are sent by the bot (text messages also get a
 * "Name: " body prefix; media events do not).
 *
 * @param replyTo event id of the quoted message in the target room, or null
 * @param stats media counters, mutated (see buildEvent)
 * @param encrypted whether the target room is encrypted
 * @param oldEvents the message's events in the room(s) a rebuild replaces (media fallback)
 */
async function toPayload(
  event: ImportEvent,
  replyTo: string | null,
  failedGhosts: Set<string>,
  stats: Record<string, number>,
  encrypted: boolean,
  oldEvents: OldEvent[] = [],
): Promise<BatchEvent> {
  const { type, content } = await buildEvent(event, replyTo, stats, encrypted, oldEvents);
  Object.assign(content, { [SELF_BRIDGE_MARKER]: true, [IMPORT_MARKER]: true });
  if (event.sender.kind === 'owner') content[DOUBLE_PUPPET_SOURCE_KEY] = bridgeAppId;
  let sender =
    event.sender.kind === 'owner'
      ? owner
      : event.sender.kind === 'ghost'
        ? puppets.mxidFor(event.sender.uid)
        : bot.userId;
  if (event.sender.kind === 'ghost' && failedGhosts.has(event.sender.uid)) {
    sender = bot.userId;
    if (type === 'm.room.message')
      content.body = `${names.get(event.sender.uid) ?? event.sender.uid}: ${String(content.body)}`;
  }
  return { type, sender, origin_server_ts: event.timestamp, content };
}

/** Message direction as stored in bridge.db: the owner's messages are outbound. */
const direction = (event: ImportEvent) =>
  (event.sender.kind === 'owner' ? 'outbound' : 'inbound') as 'outbound' | 'inbound';

// ---------------------------------------------------------------------------
// Reactions: <key>.reactions.json sidecar → m.reaction events in the current portal
// ---------------------------------------------------------------------------

/**
 * Posts the export's reactions into the thread's current portal room: each reactor's
 * reaction as their ghost (the owner's own, reactor "0", as the owner), encrypted when the
 * room is, and records each one in the reaction table so the live bridge can redact it on a
 * Zalo removal and does not post it again. Reactions already recorded in this room (same
 * message, reactor and icon) are skipped, so a re-run posts nothing twice. Targets that are
 * not mapped to an event in the current room are skipped.
 *
 * Side effects: ghost joins, batch_send, bridge.db inserts, pacing sleeps.
 *
 * @returns number of reactions posted
 * @throws when batch_send rejects a chunk (the reactions sent before stay recorded)
 */
async function postReactions(key: string): Promise<number> {
  const file = path.join(cliOptions.dir, `${key}.reactions.json`);
  if (!fs.existsSync(file)) return 0;
  const { threadId, threadType } = parseThreadKey(key);
  const portal = store.getPortalByThread(threadId);
  if (!portal) return 0;
  const roomId = portal.room_id;
  const entries = parseReactionSidecar(fs.readFileSync(file, 'utf8'));
  const timestamps = new Map(eventsFor(key).map((event) => [event.msgId, event.timestamp]));

  type Pending = { event: BatchEvent; msgId: string; senderUid: string; icon: string };
  const pending: Pending[] = [];
  const ghostReady = new Map<string, boolean>();
  let skipped = 0;
  let unmapped = 0;
  for (const entry of entries) {
    const mapped = entry.msgId ? store.getEventByZaloMsgId(entry.msgId) : null;
    const eventId =
      mapped?.roomId === roomId && mapped.eventId
        ? mapped.eventId
        : entry.cliMsgId
          ? store.getEventIdByCliMsgId(roomId, entry.cliMsgId, null)
          : null;
    if (!eventId) {
      unmapped += entry.reactions.length;
      continue;
    }
    const msgId = entry.msgId || entry.cliMsgId;
    for (const { reactor, rType } of entry.reactions) {
      const isOwner = reactor === '0';
      const senderUid = isOwner ? cliOptions.ownUid : reactor;
      if (!senderUid) {
        skipped++; // the owner's reaction needs --own-uid to be recorded under the right uid
        continue;
      }
      const icon = zaloRTypeToIcon(rType);
      const known = store
        .getReactions(msgId, senderUid)
        .some((row) => row.room_id === roomId && row.zalo_icon === icon);
      const queued = pending.some((p) => p.msgId === msgId && p.senderUid === senderUid && p.icon === icon);
      if (known || queued) {
        skipped++;
        continue;
      }
      if (!isOwner && !ghostReady.has(senderUid)) {
        const name = names.get(senderUid);
        try {
          await puppets.ensurePuppet(senderUid, name);
          if (threadType === 'group') await portals.ensureGhostInRoom(senderUid, roomId, name);
          ghostReady.set(senderUid, true);
        } catch (err) {
          ghostReady.set(senderUid, false);
          console.log(`[import] ${key}: ghost ${senderUid} unavailable, its reactions skipped:`, errorMessage(err));
        }
      }
      if (!isOwner && !ghostReady.get(senderUid)) {
        skipped++;
        continue;
      }
      const content: Record<string, unknown> = {
        'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key: zaloToEmoji(icon) },
        [SELF_BRIDGE_MARKER]: true,
        [IMPORT_MARKER]: true,
      };
      if (isOwner) content[DOUBLE_PUPPET_SOURCE_KEY] = bridgeAppId;
      const event: BatchEvent = {
        type: 'm.reaction',
        sender: isOwner ? owner : puppets.mxidFor(senderUid),
        origin_server_ts: timestamps.get(msgId) ?? Date.now(),
        content,
      };
      pending.push({ event, msgId, senderUid, icon });
    }
  }

  let posted = 0;
  for (let start = 0; start < pending.length; start += cliOptions.batch) {
    const chunk = pending.slice(start, start + cliOptions.batch);
    const eventIds = await batchSend(
      roomId,
      chunk.map((p) => p.event),
      true,
    );
    chunk.forEach((p, i) => {
      const eventId = eventIds[i];
      if (!eventId) return;
      store.recordReaction({
        event_id: eventId,
        room_id: roomId,
        target_msg_id: p.msgId,
        sender_id: p.senderUid,
        zalo_icon: p.icon,
      });
      posted++;
    });
    if (start + cliOptions.batch < pending.length) await sleep(cliOptions.delayMs);
  }
  if (posted < pending.length)
    throw new Error(`${key}: only ${posted} of ${pending.length} reactions were accepted by batch_send`);
  console.log(
    `[import] ${key}: ${posted} reactions posted, ${skipped} already there or skipped, ${unmapped} on messages not in the room`,
  );
  return posted;
}

// ---------------------------------------------------------------------------
// --rebuild: full history into a fresh room, live-only messages carried over
// ---------------------------------------------------------------------------

/**
 * Full ordered history into a fresh room, then repoint the thread to it.
 * Creates a detached portal room, fills it and switches bridge.db to it; if anything
 * fails before the switch, the half-filled room is removed and the old room stays.
 *
 * @returns number of messages sent (export + carried live-only); 0 when the export is empty
 * @throws whatever the fill/switch threw (after the partial-room cleanup)
 */
async function rebuild(key: string): Promise<number> {
  const { threadId, threadType } = parseThreadKey(key);
  const events = eventsFor(key);
  if (!events.length) return 0;
  const oldPortal = store.getPortalByThread(threadId);
  // Rerunnable migration: a thread whose portal is already encrypted was rebuilt before
  if (!cliOptions.includeEncrypted && importerCrypto && oldPortal && (await isEncryptedRoom(oldPortal.room_id))) {
    console.log(`[import] ${key}: portal ${oldPortal.room_id} is already encrypted, not rebuilt`);
    return 0;
  }
  const label = oldPortal?.name ?? labelOf(key);
  const portal = await portals.createDetachedPortal({
    threadId,
    threadType,
    senderId: threadId,
    senderName: label ?? undefined,
    resolveGroupName: async () => label,
  });
  try {
    return await fillAndSwitch(key, events, oldPortal, portal, label);
  } catch (err) {
    // Not repointed → the half-filled room is unreachable: drop it, the old room stays
    if (!store.isPortalRoom(portal.room_id)) {
      await removeRoom(portal.room_id, threadId, threadType).catch((removeErr: unknown) =>
        console.warn(`[import] could not drop partial room ${portal.room_id}:`, errorMessage(removeErr)),
      );
    }
    throw err;
  }
}

/**
 * Fills the new room with the export merged with the live-only messages of the old
 * room(s) (old portal + --carry-from), oldest first, then repoints the thread to it.
 * Live messages that arrive during the run are copied right before and right after the
 * repoint. Logs a WARNING when live messages remain stranded in the old rooms.
 *
 * Side effects: Matrix sends (batch_send, ghost joins), bridge.db repoint, pacing sleeps.
 *
 * @param oldPortal the thread's current portal, if any (source of live-only messages)
 * @param portal the freshly created, still detached room
 * @param label conversation name stored on the repointed portal row
 * @returns number of messages mapped to the new room
 */
async function fillAndSwitch(
  key: string,
  events: ImportEvent[],
  oldPortal: ReturnType<MappingStore['getPortalByThread']>,
  portal: { room_id: string },
  label: string | null,
): Promise<number> {
  const { threadId, threadType } = parseThreadKey(key);
  const failedGhosts = await prepareSenders(events, portal.room_id, threadType, key);
  const encrypted = await isEncryptedRoom(portal.room_id);

  // Live-bridged messages the export does not know (Zalo PC missed them, or they arrived
  // after the export was taken): replay their Matrix events in timeline order
  const exportedMsgIds = exportedIds.get(key) ?? new Set<string>();
  const sourceRooms = [...new Set([...(oldPortal ? [oldPortal.room_id] : []), ...cliOptions.carryFrom])];
  const liveOnly = await readLiveEvents(sourceRooms, exportedMsgIds, new Set());
  // Each message's events in the old room(s): media the CDN no longer serves is taken from there.
  // The --baseline-db row comes last: after an earlier rebuild the store points at that rebuild's
  // room, where a message whose media was unreachable is only text, while the original room
  // still holds the media.
  const oldEvents = new Map<string, OldEvent[]>();
  const addOldEvent = (msgId: string, candidate: OldEvent) => {
    const list = oldEvents.get(msgId) ?? [];
    if (!list.some((known) => known.eventId === candidate.eventId)) list.push(candidate);
    oldEvents.set(msgId, list);
  };
  for (const roomId of sourceRooms)
    for (const row of store.getRoomMessages(roomId))
      if (row.eventId) addOldEvent(row.msgId, { roomId, eventId: row.eventId });
  const baseline = baselineRows(threadId);
  if (baseline.roomId)
    for (const row of baseline.rows)
      if (row.eventId) addOldEvent(row.msgId, { roomId: baseline.roomId, eventId: row.eventId });
  const items: Item[] = [
    ...events.map((event) => ({ kind: 'export' as const, ev: event, ts: event.timestamp })),
    ...liveOnly,
  ].sort((a, b) => a.ts - b.ts);
  console.log(
    `[import] rebuild ${key} "${label ?? ''}": ${events.length} messages + ${liveOnly.length} live-only → new ${encrypted ? 'encrypted' : 'plain'} room ${portal.room_id} (old ${oldPortal?.room_id ?? 'none'})`,
  );

  /** Zalo msgId → event id in the new room (reply targets + skip list for copyLive). */
  const eventIds = new Map<string, string>();
  const stats: Record<string, number> = {};
  const sentRows: RepointRow[] = [];
  let chunk: Item[] = [];
  /**
   * Sends the pending chunk (payloads prepared concurrently, order preserved), records
   * the new event ids in `eventIds` / `sentRows`, empties the chunk and waits --delay-ms.
   * Items the homeserver returned no event id for are left unmapped.
   */
  const flush = async () => {
    if (!chunk.length) return;
    const payloads = await mapLimit(chunk, PREPARE_CONCURRENCY, (item) =>
      item.kind === 'export'
        ? toPayload(
            item.ev,
            (item.ev.quote?.msgId && eventIds.get(item.ev.quote.msgId)) || null,
            failedGhosts,
            stats,
            encrypted,
            oldEvents.get(item.ev.msgId) ?? [],
          )
        : livePayload(item, portal.room_id, threadType, eventIds, stats, encrypted),
    );
    const sentEventIds = await batchSend(portal.room_id, payloads, true);
    chunk.forEach((item, i) => {
      const eventId = sentEventIds[i];
      if (!eventId) return;
      const msgId = item.kind === 'export' ? item.ev.msgId : item.row.msgId;
      eventIds.set(msgId, eventId);
      sentRows.push(
        item.kind === 'export'
          ? {
              msgId,
              eventId,
              direction: direction(item.ev),
              cliMsgId: item.ev.cliMsgId ?? null,
              msgType: item.ev.rawMsgType,
            }
          : { msgId, eventId, direction: item.row.direction, cliMsgId: item.row.cliMsgId, msgType: item.row.msgType },
      );
    });
    chunk = [];
    await sleep(cliOptions.delayMs);
  };
  const msgIdsInChunk = new Set<string>();
  for (const item of items) {
    // A reply needs its target's event id: send the target's chunk first
    const replyTarget = item.kind === 'export' ? item.ev.quote?.msgId : item.replyToMsgId;
    if (replyTarget && msgIdsInChunk.has(replyTarget)) {
      await flush();
      msgIdsInChunk.clear();
    }
    chunk.push(item);
    msgIdsInChunk.add(item.kind === 'export' ? item.ev.msgId : item.row.msgId);
    if (chunk.length >= cliOptions.batch) {
      await flush();
      msgIdsInChunk.clear();
    }
  }
  await flush();

  // Messages bridged into the old room while this ran: copy right before the switch,
  // then once more for anything that raced the repoint (both are the newest messages)
  const portalRow = { thread_id: threadId, thread_type: threadType, room_id: portal.room_id, name: label };
  // The repoint moves the rows out of the old rooms: keep them (with their old event ids) so the
  // completeness audit can still check those rooms before they are deleted
  const moved = new Map<string, AuditRow & { roomId: string }>();
  const snapshotOldRows = () => {
    for (const roomId of sourceRooms)
      for (const { msgId, eventId, direction, ts } of store.getRoomMessages(roomId))
        if (!moved.has(msgId)) moved.set(msgId, { roomId, msgId, eventId, direction, ts });
  };
  const tail = await copyLive(sourceRooms, portal.room_id, threadType, exportedMsgIds, eventIds, stats, encrypted);
  snapshotOldRows();
  store.repointPortal(portalRow, [...sentRows, ...tail]);
  const raced = await copyLive(sourceRooms, portal.room_id, threadType, exportedMsgIds, eventIds, stats, encrypted);
  snapshotOldRows();
  if (raced.length) store.repointPortal(portalRow, raced);
  const record: RebuildRecord = {
    newRoom: portal.room_id,
    moved: [...moved.values()],
    unverifiedMedia: events.map((event) => event.msgId).filter((msgId) => unverifiedMedia.has(msgId)),
  };
  fs.mkdirSync(path.dirname(rebuildRecordFile(threadId)), { recursive: true });
  fs.writeFileSync(rebuildRecordFile(threadId), `${JSON.stringify(record, null, 2)}\n`);
  if (record.unverifiedMedia.length)
    console.warn(
      `[import] ${key}: WARNING ${record.unverifiedMedia.length} media message(s) became text while their old-room event could not be decrypted; the old room must be kept (the audit blocks deleting it)`,
    );

  const stranded = sourceRooms
    .flatMap((roomId) => store.getRoomMessages(roomId))
    .filter((message) => !exportedMsgIds.has(message.msgId)).length;
  const sentExport = sentRows.filter((row) => exportedMsgIds.has(row.msgId)).length;
  console.log(
    `[import] ${key}: ${sentExport}/${events.length} sent, ${sentRows.length - sentExport + tail.length + raced.length} live-only message(s) carried over, media ${JSON.stringify(stats)}` +
      (stranded ? `; WARNING ${stranded} live message(s) could not be carried over` : ''),
  );
  return sentRows.length + tail.length + raced.length;
}

/**
 * Live-bridged messages of the given rooms that the export lacks, with their Matrix events.
 * Each event is fetched as the owner; redacted events are skipped, unreadable ones are
 * logged and skipped. Encrypted events are decrypted with the importer's device, which holds
 * the keys of everything it sent itself (an earlier rebuild); events the live bridge's device
 * encrypted have keys only there, so they stay behind and count as stranded. A reply's target
 * event is resolved back to its Zalo msgId.
 *
 * @param knownMsgIds msgIds present in the export (not live-only)
 * @param skip msgIds already copied to the new room
 * @returns the live items in per-room bridging order (callers sort by timestamp)
 */
async function readLiveEvents(roomIds: string[], knownMsgIds: Set<string>, skip: Set<string>): Promise<LiveItem[]> {
  // The owner is joined to every portal (DMs are created by the ghost, not the bot)
  const reader = ownerIntent(bridge, owner).matrixClient;
  const liveItems: LiveItem[] = [];
  let redacted = 0;
  for (const roomId of roomIds) {
    for (const row of store.getRoomMessages(roomId)) {
      if (!row.eventId || knownMsgIds.has(row.msgId) || skip.has(row.msgId)) continue;
      try {
        const wire = (await reader.getRawEvent(roomId, row.eventId)) as RawEvent;
        if (isRedacted(wire)) {
          redacted++;
          continue;
        }
        const raw = wire.type === 'm.room.encrypted' ? await decryptLive(wire, roomId, row.msgId) : wire;
        if (!raw) continue;
        const replyToEventId = (
          raw.content['m.relates_to'] as { 'm.in_reply_to'?: { event_id?: string } } | undefined
        )?.['m.in_reply_to']?.event_id;
        const replyToMsgId = replyToEventId ? store.getZaloTargetByEventId(replyToEventId)?.zaloMsgId : undefined;
        // The live bridge could not render (or download) this message then; the current bridge
        // may, and a failed download is retried from the stored payload's URLs
        const noticeType =
          unsupportedNoticeType(raw.content) ?? (isFailedMediaNotice(raw.content) ? row.msgType : null);
        const rerender = noticeType
          ? rerenderStored(store.getQuoteJsonByEventId(row.eventId), row.msgId, noticeType)
          : null;
        liveItems.push({
          kind: 'live',
          ts: raw.origin_server_ts,
          row,
          raw,
          ...(replyToMsgId ? { replyToMsgId } : {}),
          ...(rerender ? { rerender } : {}),
        });
      } catch (err) {
        console.warn(`[import] could not read live event ${row.eventId} (${row.msgId}):`, errorMessage(err));
      }
    }
  }
  if (redacted)
    console.log(`[import] ${redacted} live message(s) skipped: redacted (deleted/recalled) in the old room`);
  return liveItems;
}

/** A redacted event: the server strips its content (an encrypted one loses its ciphertext too). */
function isRedacted(event: { content?: Record<string, unknown> }): boolean {
  return !event.content || !Object.keys(event.content).length;
}

/**
 * A live encrypted event in clear, or null (logged) when the importer's device lacks its key.
 * Side effect: a failure is recorded in {@link undecryptableMsgIds} under `msgId`.
 */
async function decryptLive(event: RawEvent, roomId: string, msgId?: string): Promise<RawEvent | null> {
  if (!importerCrypto) {
    if (msgId) undecryptableMsgIds.add(msgId);
    return null;
  }
  try {
    return (await importerCrypto.rooms.decrypt({ ...event, room_id: roomId })) as RawEvent;
  } catch (err) {
    if (msgId) undecryptableMsgIds.add(msgId);
    console.warn(
      `[import] cannot decrypt live event in ${roomId} (key only on the live bridge's device):`,
      errorMessage(err),
    );
    return null;
  }
}

/**
 * The live event re-posted into the new room: same sender/time/content, reply remapped.
 * A reply whose target has no event in the new room loses its relation. Group ghost
 * senders are joined to the new room first (Matrix side effect). A "not supported" notice
 * with a re-rendered payload ({@link LiveItem.rerender}) is posted as the message the current
 * bridge renders (media uploaded, system lines from the bot); if that fails the notice is kept.
 *
 * @param eventIds Zalo msgId → event id in the new room
 * @param stats counters, mutated (`rerendered:<kind>` and the media sources)
 * @param encrypted whether the new room is encrypted (media upload)
 */
async function livePayload(
  item: LiveItem,
  newRoomId: string,
  threadType: 'user' | 'group',
  eventIds: Map<string, string>,
  stats: Record<string, number>,
  encrypted: boolean,
): Promise<BatchEvent> {
  const relation = item.raw.content['m.relates_to'] as Record<string, unknown> | undefined;
  const hasReply = Boolean(relation?.['m.in_reply_to']);
  const remapped = hasReply && item.replyToMsgId ? eventIds.get(item.replyToMsgId) : undefined;
  const rerendered = item.rerender ? await rerenderedContent(item, item.rerender, remapped, stats, encrypted) : null;
  let { type, sender } = item.raw;
  let content: Record<string, unknown>;
  if (rerendered) {
    ({ type, content } = rerendered);
    if (item.rerender?.via === 'import' && item.rerender.system) sender = bot.userId;
  } else {
    content = { ...item.raw.content };
    if (hasReply) {
      if (remapped) content['m.relates_to'] = { 'm.in_reply_to': { event_id: remapped } };
      else delete content['m.relates_to'];
    }
  }
  // Without it Beeper's server shows the owner's copied message as "failed to send"
  if (sender === owner) content[DOUBLE_PUPPET_SOURCE_KEY] = bridgeAppId;
  const ghostUid = puppets.uidFor(sender);
  if (ghostUid && threadType === 'group') await portals.ensureGhostInRoom(ghostUid, newRoomId, names.get(ghostUid));
  return { type, sender, origin_server_ts: item.raw.origin_server_ts, content };
}

/**
 * The event a re-rendered "not supported" notice becomes, or null (logged) when building it
 * failed and the notice should be copied as it was. Keeps the bridge markers of the notice.
 *
 * @param replyTo event id of the quoted message in the new room, if any
 */
async function rerenderedContent(
  item: LiveItem,
  rerender: Rerendered,
  replyTo: string | undefined,
  stats: Record<string, number>,
  encrypted: boolean,
): Promise<{ type: string; content: Record<string, unknown> } | null> {
  try {
    let built: { type: string; content: Record<string, unknown> };
    if (rerender.via === 'import') {
      const event: ImportEvent = {
        msgId: item.row.msgId,
        timestamp: item.raw.origin_server_ts,
        sender: { kind: 'bot' },
        content: rerender.content,
        ...(rerender.media ? { media: rerender.media } : {}),
        ...(rerender.linkPreview ? { linkPreview: rerender.linkPreview } : {}),
        rawMsgType: item.row.msgType ?? '',
      };
      built = await buildEvent(event, replyTo ?? null, stats, encrypted);
    } else {
      const reply = replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {};
      built = { type: rerender.type, content: { ...rerender.content, ...reply } };
    }
    for (const marker of [SELF_BRIDGE_MARKER, IMPORT_MARKER])
      if (marker in item.raw.content) built.content[marker] = item.raw.content[marker];
    stats[`rerendered:${rerender.kind}`] = (stats[`rerendered:${rerender.kind}`] ?? 0) + 1;
    return built;
  } catch (err) {
    console.warn(
      `[import] could not re-render "not supported" message ${item.row.msgId}, notice kept:`,
      errorMessage(err),
    );
    return null;
  }
}

/**
 * Copies live messages not yet in the new room (they arrived during the rebuild), oldest first.
 * Sends them in one batch_send and records their new event ids in `eventIds` (mutated).
 *
 * @returns the rows to repoint (messages that got an event id)
 */
async function copyLive(
  roomIds: string[],
  newRoomId: string,
  threadType: 'user' | 'group',
  knownMsgIds: Set<string>,
  eventIds: Map<string, string>,
  stats: Record<string, number>,
  encrypted: boolean,
): Promise<RepointRow[]> {
  const tail = (await readLiveEvents(roomIds, knownMsgIds, new Set(eventIds.keys()))).sort((a, b) => a.ts - b.ts);
  if (!tail.length) return [];
  const payloads = [];
  for (const item of tail) payloads.push(await livePayload(item, newRoomId, threadType, eventIds, stats, encrypted));
  const sentEventIds = await batchSend(newRoomId, payloads, true);
  const copied: RepointRow[] = [];
  tail.forEach((item, i) => {
    const eventId = sentEventIds[i];
    if (!eventId) return;
    eventIds.set(item.row.msgId, eventId);
    copied.push({
      msgId: item.row.msgId,
      eventId,
      direction: item.row.direction,
      cliMsgId: item.row.cliMsgId,
      msgType: item.row.msgType,
    });
  });
  return copied;
}

// ---------------------------------------------------------------------------
// Default mode: prepend older history into the existing portal room
// ---------------------------------------------------------------------------

/**
 * Default mode: history older than the room's first bridged message, prepended.
 * Creates the portal when the thread has none. Messages already in bridge.db are skipped,
 * so re-runs are idempotent. Every sent message is recorded in bridge.db.
 *
 * Side effects: Matrix sends, bridge.db writes, pacing sleeps.
 *
 * @returns number of messages sent
 */
async function prepend(key: string): Promise<number> {
  const { threadId, threadType } = parseThreadKey(key);
  const events = eventsFor(key).filter((event) => !store.hasMessage(event.msgId));
  if (!events.length) return 0;
  const label = labelOf(key);
  const portal = await portals.getOrCreatePortal({
    threadId,
    threadType,
    senderId: threadId,
    senderName: label ?? undefined,
    resolveGroupName: async () => label,
  });
  // Rooms with live-bridged messages: only history strictly older than the first of them
  const cutoff = store.getOldestMessageTs(portal.room_id) ?? Infinity;
  const olderEvents = events.filter((event) => event.timestamp < cutoff);
  if (!olderEvents.length) return 0;
  const failedGhosts = await prepareSenders(olderEvents, portal.room_id, threadType, key);
  const encrypted = await isEncryptedRoom(portal.room_id);
  console.log(
    `[import] ${key} "${label ?? ''}" → ${encrypted ? 'encrypted' : 'plain'} room ${portal.room_id}: ${olderEvents.length} messages`,
  );
  const stats: Record<string, number> = {};
  let imported = 0;
  // Newest chunk first: each forward:false batch lands before the previous one
  for (let end = olderEvents.length; end > 0; end -= cliOptions.batch) {
    const chunk = olderEvents.slice(Math.max(0, end - cliOptions.batch), end);
    // Replies resolve only to targets already in the room (older chunks land later)
    const payloads = await mapLimit(chunk, PREPARE_CONCURRENCY, (event) =>
      toPayload(
        event,
        (event.quote?.msgId && store.getEventIdByMsgId(event.quote.msgId)) || null,
        failedGhosts,
        stats,
        encrypted,
      ),
    );
    const sentEventIds = await batchSend(portal.room_id, payloads, false);
    chunk.forEach((event, i) => {
      const eventId = sentEventIds[i];
      // No event id back = not stored in Beeper: leave it unrecorded so the completeness
      // check reports it as missing and a re-run retries it
      if (!eventId) return;
      // senderId stays null: Beeper reads of decade-old history must not emit Zalo "seen"
      store.recordMessage(
        event.msgId,
        portal.room_id,
        eventId,
        direction(event),
        null,
        event.cliMsgId ?? null,
        null,
        event.rawMsgType,
      );
      imported++;
    });
    await sleep(cliOptions.delayMs);
  }
  console.log(`[import] ${key}: media ${JSON.stringify(stats)}`);
  return imported;
}

// ---------------------------------------------------------------------------
// --verify / --retire / --remove-old
// ---------------------------------------------------------------------------

/**
 * Every event id in a room's timeline (paginated back from the newest event, as the owner).
 * @throws when a /messages request fails
 */
async function timelineEventIds(roomId: string): Promise<Set<string>> {
  const client = ownerIntent(bridge, owner).matrixClient;
  const ids = new Set<string>();
  let paginationToken: string | undefined;
  for (;;) {
    const page = (await client.doRequest('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`, {
      dir: 'b',
      limit: 1000,
      ...(paginationToken ? { from: paginationToken } : {}),
    })) as { chunk: Array<{ event_id: string }>; end?: string };
    for (const timelineEvent of page.chunk) ids.add(timelineEvent.event_id);
    if (!page.end || !page.chunk.length) return ids;
    paginationToken = page.end;
  }
}

/**
 * A thread is verified when its portal room holds every renderable export message and
 * every message mapped to the room is a real event in the room's Beeper timeline.
 * Read-only; logs a `[verify]` line with OK or the PROBLEMS.
 *
 * @returns the problems found (empty when the thread is verified)
 */
async function verifyThread(key: string): Promise<string[]> {
  const { threadId } = parseThreadKey(key);
  const portal = store.getPortalByThread(threadId);
  if (!portal) return ['no portal'];
  const rows = store.getRoomMessages(portal.room_id);
  const inRoom = new Set(rows.map((row) => row.msgId));
  const problems: string[] = [];
  const notMapped = eventsFor(key).filter((event) => !inRoom.has(event.msgId)).length;
  if (notMapped) problems.push(`${notMapped} export messages not mapped to the room`);
  const noEvent = rows.filter((row) => !row.eventId).length;
  if (noEvent) problems.push(`${noEvent} mapped messages without an event`);
  const timeline = await timelineEventIds(portal.room_id);
  const absent = rows.filter((row) => row.eventId && !timeline.has(row.eventId)).length;
  if (absent) problems.push(`${absent} mapped events missing from the Beeper timeline`);
  console.log(
    `[verify] ${key} → ${portal.room_id}: ${rows.length} mapped, ${timeline.size} timeline events${problems.length ? `, PROBLEMS: ${problems.join('; ')}` : ', OK'}`,
  );
  return problems;
}

/**
 * Deletes a superseded room in Beeper (fallback: owner leaves + forgets) and its mappings.
 * The delete is tried as the DM peer's puppet (DMs) and then as the bot.
 *
 * @throws when `roomId` is still a live portal room, or when the owner fallback fails
 */
async function removeRoom(roomId: string, threadId: string, threadType: 'user' | 'group'): Promise<void> {
  if (store.isPortalRoom(roomId)) throw new Error(`refusing to remove live portal room ${roomId}`);
  const deleteAs = threadType === 'user' ? [puppets.intentFor(threadId), bot] : [bot];
  let outcome = '';
  for (const intent of deleteAs) {
    try {
      await intent.matrixClient.doRequest(
        'POST',
        `/_matrix/client/unstable/com.beeper.yeet/rooms/${encodeURIComponent(roomId)}/delete`,
        null,
        {},
      );
      outcome = `deleted (as ${intent.userId})`;
      break;
    } catch (err) {
      console.warn(`[retire] delete ${roomId} as ${intent.userId} failed:`, errorMessage(err));
    }
  }
  if (!outcome) {
    // Not Intent.leave(): that goes through bot-sdk's ensureRegistered → M_EXCLUSIVE for the owner
    const client = ownerIntent(bridge, owner).matrixClient;
    await client.leaveRoom(roomId);
    await client.doRequest('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/forget`, null, {});
    outcome = 'left + forgotten by the owner';
  }
  const dropped = store.deleteRoomMessages(roomId);
  console.log(`[retire] ${roomId}: ${outcome}, ${dropped} stale mapping(s) dropped`);
}

/**
 * The thread's messages in the --baseline-db (the bridge.db from before the migration):
 * every row mapped to the room its portal pointed to, without outbound echo guards.
 */
function baselineRows(threadId: string): { roomId: string | null; rows: AuditRow[] } {
  if (!cliOptions.baselineDb) return { roomId: null, rows: [] };
  const db = new Database(cliOptions.baselineDb, { readonly: true, fileMustExist: true });
  try {
    const portal = db.prepare('SELECT room_id FROM portal WHERE thread_id = ?').get(threadId) as
      { room_id: string } | undefined;
    if (!portal) return { roomId: null, rows: [] };
    const rows = db
      .prepare(
        "SELECT zalo_msg_id, event_id, direction, ts FROM message WHERE room_id = ? AND zalo_msg_id NOT LIKE 'evt:%'",
      )
      .all(portal.room_id) as Array<{ zalo_msg_id: string; event_id: string | null; direction: string; ts: number }>;
    return {
      roomId: portal.room_id,
      rows: rows.map((row) => ({
        msgId: row.zalo_msg_id,
        eventId: row.event_id,
        direction: row.direction,
        ts: row.ts,
      })),
    };
  } finally {
    db.close();
  }
}

/**
 * An event read as the owner and decrypted with the importer's device when encrypted; null
 * when it is redacted or cannot be read.
 */
async function readEvent(roomId: string, eventId: string): Promise<RawEvent | null> {
  try {
    const wire = (await ownerIntent(bridge, owner).matrixClient.getRawEvent(roomId, eventId)) as RawEvent;
    if (isRedacted(wire)) return null;
    return wire.type === 'm.room.encrypted' ? await decryptLive(wire, roomId) : wire;
  } catch (err) {
    console.warn(`[audit] cannot read ${eventId} in ${roomId}:`, errorMessage(err));
    return null;
  }
}

/** The message kind of an event (see old-room-media.ts); `unknown` when it is redacted or cannot be read. */
async function eventKind(roomId: string, eventId: string): Promise<string> {
  const raw = await readEvent(roomId, eventId);
  return raw ? messageKind(raw) : 'unknown';
}

/** The old-room event of a message: redacted (with who/why/when when the server says), present or unreadable. */
async function sourceState(roomId: string, eventId: string): Promise<SourceState> {
  try {
    const wire = (await ownerIntent(bridge, owner).matrixClient.getRawEvent(roomId, eventId)) as RawEvent & {
      unsigned?: { redacted_because?: { sender?: string; origin_server_ts?: number; content?: { reason?: string } } };
    };
    if (!isRedacted(wire)) return { state: 'present' };
    const because = wire.unsigned?.redacted_because;
    return {
      state: 'redacted',
      ...(because?.sender ? { redactedBy: because.sender } : {}),
      ...(because?.content?.reason ? { reason: because.content.reason } : {}),
      ...(because?.origin_server_ts ? { ts: because.origin_server_ts } : {}),
    };
  } catch (err) {
    return { state: 'unreadable', error: errorMessage(err) };
  }
}

/**
 * Completeness audit of a thread before its old rooms are deleted (see completeness-audit.ts):
 * every message of the --baseline-db and of the old rooms is classified. Reads old-room
 * events as the owner to verify redactions. Writes the evidence (metadata only, no message
 * content) to `import-evidence/<threadId>-<time>.json` and logs an `[audit]` summary.
 *
 * @returns the msgIds that block deleting the old rooms (empty when complete)
 * @throws when the thread has no portal, an old room is the portal, or a /messages request fails
 */
async function auditThread(key: string, oldRooms: string[]): Promise<string[]> {
  const { threadId } = parseThreadKey(key);
  const portal = store.getPortalByThread(threadId);
  if (!portal) throw new Error(`${key}: no portal`);
  if (oldRooms.includes(portal.room_id))
    throw new Error(`${key}: ${portal.room_id} is the current portal, not an old room`);
  const { roomId: baselineRoom, rows: baseline } = baselineRows(threadId);
  // The rebuild that created the current room repointed the old rooms' rows away from them;
  // its record keeps them so those rooms are still audited
  const recordFile = rebuildRecordFile(threadId);
  const rebuildRecord = fs.existsSync(recordFile)
    ? (JSON.parse(fs.readFileSync(recordFile, 'utf8')) as RebuildRecord)
    : null;
  const movedRows =
    rebuildRecord?.newRoom === portal.room_id ? rebuildRecord.moved.filter((row) => oldRooms.includes(row.roomId)) : [];
  const oldRows = [
    ...oldRooms.flatMap((roomId) =>
      store.getRoomMessages(roomId).map(({ msgId, eventId, direction, ts }) => ({ msgId, eventId, direction, ts })),
    ),
    ...movedRows.map(({ msgId, eventId, direction, ts }) => ({ msgId, eventId, direction, ts })),
  ];
  const current = new Map<string, { roomId: string; eventId: string | null }>();
  const sources = new Map<string, SourceState>();
  for (const { msgId } of [...baseline, ...oldRows]) {
    const mapped = store.getEventByZaloMsgId(msgId);
    if (!mapped || current.has(msgId)) continue;
    current.set(msgId, mapped);
    if (mapped.eventId && oldRooms.includes(mapped.roomId))
      sources.set(msgId, await sourceState(mapped.roomId, mapped.eventId));
  }
  // Media must arrive as media: compare the kind of each carried message's old event (baseline
  // room, while it still exists) with its new event. Only old media events need the new one read.
  const kinds = new Map<string, { old: string; new: string }>();
  if (baselineRoom && oldRooms.includes(baselineRoom)) {
    for (const row of baseline) {
      const now = current.get(row.msgId);
      if (!row.eventId || now?.roomId !== portal.room_id || !now.eventId) continue;
      const oldKind = await eventKind(baselineRoom, row.eventId);
      if (!isMediaKind(oldKind)) continue;
      kinds.set(row.msgId, { old: oldKind, new: await eventKind(portal.room_id, now.eventId) });
    }
  }
  // Same check for the rows the rebuild moved out of the old rooms (their old event ids)
  for (const row of movedRows) {
    const now = current.get(row.msgId);
    if (kinds.has(row.msgId) || !row.eventId || now?.roomId !== portal.room_id || !now.eventId) continue;
    const oldKind = await eventKind(row.roomId, row.eventId);
    if (!isMediaKind(oldKind)) continue;
    kinds.set(row.msgId, { old: oldKind, new: await eventKind(portal.room_id, now.eventId) });
  }
  // Media that became text while its old-room copy could not be decrypted (this run or the
  // rebuild's record): the old room may hold what the new one lacks
  const unverified = new Set([
    ...unverifiedMedia,
    ...(rebuildRecord?.newRoom === portal.room_id ? rebuildRecord.unverifiedMedia : []),
  ]);
  // Recalled (20) or deleted (-27) on Zalo per the export: the live bridge may have missed the
  // recall, so the old room still shows the media while the new room has the recall marker
  const recalled = new Set(
    (rowsByKey.get(key) ?? []).filter((row) => [20, -27].includes(Number(row.msgType))).map((row) => String(row.msgId)),
  );
  const report = auditCompleteness({
    newRoom: portal.room_id,
    oldRooms,
    newTimeline: await timelineEventIds(portal.room_id),
    baseline,
    oldRows,
    current,
    sources,
    kinds,
    recalled,
    unverifiedMedia: unverified,
    accepted: cliOptions.acceptMissing,
  });
  // Not blocking: messages still shown as "not supported" although a --rebuild would render them.
  const stillUnsupported = await findStillUnsupported(
    store.getRoomMessages(portal.room_id),
    (eventId) => store.getQuoteJsonByEventId(eventId),
    async (eventId) => (await readEvent(portal.room_id, eventId))?.content,
  );
  const auditedAt = new Date().toISOString();
  const evidenceDir = path.resolve('import-evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, `${threadId}-${auditedAt.replace(/[:.]/g, '-')}.json`);
  const evidence = {
    thread: key,
    newRoom: portal.room_id,
    oldRooms,
    baselineDb: cliOptions.baselineDb,
    baselineMessages: baseline.length,
    oldRoomMessages: oldRows.length,
    acceptedByOwner: [...cliOptions.acceptMissing],
    auditedAt,
    ...report,
    stillUnsupported,
  };
  fs.writeFileSync(
    evidenceFile,
    `${JSON.stringify(evidence, null, 2)}
`,
  );
  const counts = Object.entries(report.counts)
    .map(([verdict, n]) => `${verdict} ${n}`)
    .join(', ');
  console.log(
    `[audit] ${key} → ${portal.room_id}: ${report.entries.length} messages (baseline ${baseline.length}, old rooms ${oldRows.length}): ${counts}${report.missing.length ? `, MISSING: ${report.missing.join(',')}` : ', COMPLETE'}${stillUnsupported.length ? `; ${stillUnsupported.length} still "not supported" (renderable: run --rebuild)` : ''}; evidence ${evidenceFile}`,
  );
  return report.missing;
}

/**
 * Verify the thread and audit its completeness, then remove its superseded rooms; nothing
 * is removed on any problem or missing message.
 * @throws when verification finds problems, the audit finds missing messages, or a room removal fails
 */
async function retire(key: string, oldRooms: string[]): Promise<void> {
  const problems = await verifyThread(key);
  if (problems.length) throw new Error(`not removing old rooms of ${key}: ${problems.join('; ')}`);
  const missing = await auditThread(key, oldRooms);
  if (missing.length)
    throw new Error(`not removing old rooms of ${key}: ${missing.length} messages missing (see [audit])`);
  const { threadId, threadType } = parseThreadKey(key);
  for (const roomId of oldRooms) await removeRoom(roomId, threadId, threadType);
}

// ---------------------------------------------------------------------------
// Main: per-conversation run, completeness check, exit code
// ---------------------------------------------------------------------------

let imported = 0;
let reactions = 0;
const failures: string[] = [];
for (const key of rowsByKey.keys()) {
  try {
    if (cliOptions.verify) {
      if ((await verifyThread(key)).length) failures.push(`${key}: verification failed`);
      continue;
    }
    if (cliOptions.retire) {
      await retire(key, cliOptions.retire);
      continue;
    }
    if (cliOptions.audit) {
      if ((await auditThread(key, cliOptions.audit)).length) failures.push(`${key}: messages missing`);
      continue;
    }
    if (cliOptions.reactionsOnly) {
      if (!cliOptions.dryRun) reactions += await postReactions(key);
      continue;
    }
    const { threadId } = parseThreadKey(key);
    const before = store.getPortalByThread(threadId)?.room_id;
    imported += await (cliOptions.rebuild ? rebuild(key) : prepend(key));
    // Reactions go in before any old room is retired: a failure here keeps the old room
    if (!cliOptions.dryRun) reactions += await postReactions(key);
    // Only a rebuild that moved the thread to a new room has something to retire
    // (an empty export creates no room and keeps the current one)
    const after = store.getPortalByThread(threadId)?.room_id;
    if (cliOptions.rebuild && cliOptions.removeOld && after && after !== before) {
      await retire(key, [...new Set([...(before ? [before] : []), ...cliOptions.carryFrom])]);
    } else if (cliOptions.rebuild && after === before)
      console.log(`[import] ${key}: nothing to rebuild, room unchanged`);
  } catch (err) {
    failures.push(`${key}: ${errorMessage(err)}`);
    console.error(`[import] ${key} failed:`, errorMessage(err));
  }
}

// Completeness: every renderable export row of each conversation must now be recorded
let missing = 0;
for (const key of rowsByKey.keys()) {
  const lost = eventsFor(key).filter((event) => !store.hasMessage(event.msgId));
  if (lost.length) {
    missing += lost.length;
    console.warn(`[import] ${key}: ${lost.length} messages NOT imported`);
  }
}

console.log(
  `[import] done: ${imported} messages imported, ${reactions} reactions posted, ${missing} missing${failures.length ? `, ${failures.length} conversations failed:\n  ${failures.join('\n  ')}` : ''}`,
);
store.close();
process.exit(failures.length || missing ? 1 : 0);
