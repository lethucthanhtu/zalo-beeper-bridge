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
//        [--rebuild [--carry-from !room1,!room2] [--remove-old]] [--retire !old1,!old2] [--verify]
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
// verify-then-delete for a thread rebuilt earlier.
//
// Safety: send_notification=false and mark_read_by=owner keep it silent; every event
// carries SELF_BRIDGE_MARKER so the live bridge never sends imported owner messages
// back to Zalo; msgIds are recorded, so a re-run skips what was already imported.
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { Bridge } from 'matrix-appservice-bridge';
import { loadConfig } from '../config.ts';
import {
  dropShadowCopies,
  parseThreadKey,
  quoteFallback,
  renderExportRow,
  type ExportRow,
  type ImportEvent,
} from '../bridge/history-import.ts';
import { animatedSticker } from '../bridge/animated-sticker.ts';
import { MappingStore } from '../bridge/mapping-store.ts';
import { ownerIntent } from '../bridge/owner-intent.ts';
import {
  buildLinkPreview,
  buildMediaEvent,
  fetchFirstMedia,
  LARGE_MEDIA_MAX_BYTES,
  type Uploader,
} from '../bridge/media-content.ts';
import { sniffMimetype } from '../bridge/media-handler.ts';
import { buildInboundMentions } from '../bridge/mentions.ts';
import { SELF_BRIDGE_MARKER } from '../bridge/outbound-handler.ts';
import { PortalManager } from '../bridge/portal-manager.ts';
import { PuppetRegistry } from '../bridge/puppet-registry.ts';
import { bridgeBranding } from '../matrix/network-branding.ts';

// ---------------------------------------------------------------------------
// Constants, CLI parsing and small helpers
// ---------------------------------------------------------------------------

/** Content key tagging every imported event (alongside SELF_BRIDGE_MARKER). */
const IMPORT_MARKER = 'com.zalo-bridge.history_import';
/** History media is mostly expired: fail fast instead of the live 30 s timeout */
const IMPORT_FETCH_TIMEOUT_MS = 10_000;
/** Messages of one batch whose media/previews are prepared concurrently */
const PREPARE_CONCURRENCY = 6;
/** CDN hosts that keep media long-term (Zalo Cloud, resources, GIFs, stickers) */
const PERMANENT_HOST = /(zpcloud|zfcloud|res-zalo|zalo-gif|zgif|zalo-api)\./;

/**
 * Parses the command line (see the usage in the header comment). The first non-flag
 * argument is the export directory; numeric flags are taken as-is via Number().
 *
 * @param argv the arguments after `node <script>`
 * @returns the parsed options, defaults filled in
 * @throws on an unknown/extra argument, a missing export dir, `--rebuild` without
 *   `--only`, or `--retire` without exactly one `--only` conversation
 */
function parseArgs(argv: string[]) {
  const parsed = {
    dir: '',
    only: null as Set<string> | null,
    dryRun: false,
    probe: false,
    rebuild: false,
    mediaDir: null as string | null,
    ownUid: null as string | null,
    /** extra earlier rooms of the same thread whose live-only messages must be kept */
    carryFrom: [] as string[],
    /** after a verified rebuild, delete the superseded room(s) */
    removeOld: false,
    /** read-only: check each --only thread's portal room against the export + timeline */
    verify: false,
    /** verify the current portal of the (single) --only thread, then remove these rooms */
    retire: null as string[] | null,
    batch: 100,
    delayMs: 1500,
    mediaDays: 16,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    /** The value following a flag — a missing one is a usage error, not a crash. */
    const valueOf = (flag: string): string => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      return value;
    };
    /** A flag's value as a whole number ≥ min (NaN or fractions would break batching/pacing). */
    const integerOf = (flag: string, min: number): number => {
      const value = Number(valueOf(flag));
      if (!Number.isInteger(value) || value < min) throw new Error(`${flag} needs a whole number ≥ ${min}`);
      return value;
    };
    if (arg === '--only') parsed.only = new Set(valueOf(arg).split(','));
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--probe') parsed.probe = true;
    else if (arg === '--rebuild') parsed.rebuild = true;
    else if (arg === '--media-dir') parsed.mediaDir = valueOf(arg);
    else if (arg === '--own-uid') parsed.ownUid = valueOf(arg);
    else if (arg === '--carry-from') parsed.carryFrom = valueOf(arg).split(',');
    else if (arg === '--remove-old') parsed.removeOld = true;
    else if (arg === '--verify') parsed.verify = true;
    else if (arg === '--retire') parsed.retire = valueOf(arg).split(',');
    else if (arg === '--batch') parsed.batch = integerOf(arg, 1);
    else if (arg === '--delay-ms') parsed.delayMs = integerOf(arg, 0);
    else if (arg === '--media-days') parsed.mediaDays = integerOf(arg, 0);
    else if (!parsed.dir) parsed.dir = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!parsed.dir) {
    throw new Error(
      'usage: import-zalo-export.ts <exportDir> [--only k1,k2] [--dry-run] [--rebuild] [--media-dir DIR] [--own-uid UID] [--batch N] [--delay-ms N] [--media-days N]',
    );
  }
  if (parsed.rebuild && !parsed.only) throw new Error('--rebuild needs an explicit --only list of conversations');
  if (parsed.retire && parsed.only?.size !== 1) throw new Error('--retire needs exactly one --only conversation');
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  source: 'local' | 'cdn' | 'animated';
};

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
};

/** One entry of a rebuild timeline: an export message or a live-only message. */
type Item = { kind: 'export'; ev: ImportEvent; ts: number } | LiveItem;

// ---------------------------------------------------------------------------
// Startup: config, export files, name index
// ---------------------------------------------------------------------------

const cliOptions = parseArgs(process.argv.slice(2));
const config = loadConfig();
const registration = loadYaml(fs.readFileSync(config.matrix.registrationPath, 'utf8')) as {
  id?: string;
  sender_localpart?: string;
};
const bridgeAppId = (registration.sender_localpart ?? 'sh-zalobot').replace(/bot$/, '');
const branding = bridgeBranding(config, registration);
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
          : fetchFirst(media.urls, config.bridge.mediaMaxBytes),
      );
      stickerCache.set(id, cached);
    }
    return cached;
  }
  // Same caps as the live bridge: videos and documents may exceed the photo cap
  const maxBytes =
    media.kind === 'video' || media.kind === 'file'
      ? Math.max(config.bridge.mediaMaxBytes, LARGE_MEDIA_MAX_BYTES)
      : config.bridge.mediaMaxBytes;
  return fetchFirst(
    media.urls.filter((url) => cdnWorthTrying(url, event.timestamp)),
    maxBytes,
  );
}

/** First reachable CDN candidate (short import timeout), tagged as `source: 'cdn'`; null if none. */
async function fetchFirst(urls: string[], maxBytes: number): Promise<Media | null> {
  const found = await fetchFirstMedia(urls, maxBytes, IMPORT_FETCH_TIMEOUT_MS);
  return found ? { ...found, source: 'cdn' } : null;
}

/** Uploads to the content repo as the bridge bot (`bot` is assigned before the first call). */
const upload: Uploader = (buffer, uploadOptions) => bot.uploadContent(buffer, uploadOptions);

// Uploaded mxc per sticker id (stickerCache dedupes the download, this the upload)
const stickerMxc = new Map<number, string>();

/**
 * Matrix event (type + content) for an import event, shaped like the live bridge's
 * posts. Media is uploaded here; unreachable media falls back to the text line.
 * Link cards get a com.beeper.linkpreviews entry (thumbnail uploaded when reachable);
 * person mentions become pills unless a quote fallback was prefixed to the body.
 *
 * @param replyTo event id of the quoted message in the target room, or null when it is
 *   not available (then the quote is rendered as a "> name: text" prefix)
 * @param stats per-kind counters (`<kind>:<source>`, `<kind>:text`, `link:preview`), mutated
 */
async function buildEvent(
  event: ImportEvent,
  replyTo: string | null,
  stats: Record<string, number>,
): Promise<{ type: string; content: Record<string, unknown> }> {
  const replyRelation = replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {};
  const resolved = event.media ? await resolveMedia(event) : null;
  const descriptor = event.media;
  if (descriptor && resolved) {
    stats[`${descriptor.kind}:${resolved.source}`] = (stats[`${descriptor.kind}:${resolved.source}`] ?? 0) + 1;
    const stickerId = descriptor.kind === 'sticker' ? descriptor.stickerId : undefined;
    const built = await buildMediaEvent(upload, descriptor, resolved, {
      filename: localMedia[event.msgId]?.name,
      mxcUrl: stickerId ? stickerMxc.get(stickerId) : undefined,
    });
    if (stickerId) stickerMxc.set(stickerId, built.mxcUrl);
    return { type: built.type, content: { ...built.content, ...replyRelation } };
  }
  if (descriptor) stats[`${descriptor.kind}:text`] = (stats[`${descriptor.kind}:text`] ?? 0) + 1;

  const body = (event.quote && !replyTo ? quoteFallback(event.quote) : '') + event.content.body;
  const content: Record<string, unknown> = { msgtype: event.content.msgtype, body, ...replyRelation };
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
  registration: config.matrix.registrationPath,
  disableStores: true,
  controller: { onEvent: () => undefined },
});
await bridge.initialise(); // intents only — no listener, the live bridge keeps the port

const store = new MappingStore(config.bridge.dbPath);
const puppets = new PuppetRegistry(bridge, store, config.matrix.domain);
const portals = new PortalManager(bridge, store, puppets, owner, branding);
const bot = bridge.getIntent();

/**
 * Posts events through Beeper's batch_send backfill endpoint as the bridge bot, silently
 * (no notifications, read by the owner).
 *
 * @param forward true appends after the newest message; false inserts before the oldest
 *   (an empty room is always appended to, forward_if_no_messages)
 * @returns the new event ids, positionally matching `events` (may be shorter/empty)
 * @throws when the homeserver rejects the request
 */
async function batchSend(roomId: string, events: Array<Record<string, unknown>>, forward: boolean): Promise<string[]> {
  const response = (await bot.matrixClient.doRequest(
    'POST',
    `/_matrix/client/unstable/com.beeper.backfill/rooms/${encodeURIComponent(roomId)}/batch_send`,
    null,
    { forward, forward_if_no_messages: true, send_notification: false, mark_read_by: owner, events },
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
      console.warn(`[import] ghost ${uid} unavailable in ${key}, sending as bot:`, (err as Error).message);
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
 */
async function toPayload(
  event: ImportEvent,
  replyTo: string | null,
  failedGhosts: Set<string>,
  stats: Record<string, number>,
) {
  const { type, content } = await buildEvent(event, replyTo, stats);
  Object.assign(content, { [SELF_BRIDGE_MARKER]: true, [IMPORT_MARKER]: true });
  if (event.sender.kind === 'owner') content['fi.mau.double_puppet_source'] = bridgeAppId;
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
      await removeRoom(portal.room_id, threadId, threadType).catch((removeErr: Error) =>
        console.warn(`[import] could not drop partial room ${portal.room_id}:`, removeErr.message),
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

  // Live-bridged messages the export does not know (Zalo PC missed them, or they arrived
  // after the export was taken): replay their Matrix events in timeline order
  const exportedMsgIds = exportedIds.get(key) ?? new Set<string>();
  const sourceRooms = [...new Set([...(oldPortal ? [oldPortal.room_id] : []), ...cliOptions.carryFrom])];
  const liveOnly = await readLiveEvents(sourceRooms, exportedMsgIds, new Set());
  const items: Item[] = [
    ...events.map((event) => ({ kind: 'export' as const, ev: event, ts: event.timestamp })),
    ...liveOnly,
  ].sort((a, b) => a.ts - b.ts);
  console.log(
    `[import] rebuild ${key} "${label ?? ''}": ${events.length} messages + ${liveOnly.length} live-only → new room ${portal.room_id} (old ${oldPortal?.room_id ?? 'none'})`,
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
        ? toPayload(item.ev, (item.ev.quote?.msgId && eventIds.get(item.ev.quote.msgId)) || null, failedGhosts, stats)
        : livePayload(item, portal.room_id, threadType, eventIds),
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
  const tail = await copyLive(sourceRooms, portal.room_id, threadType, exportedMsgIds, eventIds);
  store.repointPortal(portalRow, [...sentRows, ...tail]);
  const raced = await copyLive(sourceRooms, portal.room_id, threadType, exportedMsgIds, eventIds);
  if (raced.length) store.repointPortal(portalRow, raced);

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
 * logged and skipped. A reply's target event is resolved back to its Zalo msgId.
 *
 * @param knownMsgIds msgIds present in the export (not live-only)
 * @param skip msgIds already copied to the new room
 * @returns the live items in per-room bridging order (callers sort by timestamp)
 */
async function readLiveEvents(roomIds: string[], knownMsgIds: Set<string>, skip: Set<string>): Promise<LiveItem[]> {
  // The owner is joined to every portal (DMs are created by the ghost, not the bot)
  const reader = ownerIntent(bridge, owner).matrixClient;
  const liveItems: LiveItem[] = [];
  for (const roomId of roomIds) {
    for (const row of store.getRoomMessages(roomId)) {
      if (!row.eventId || knownMsgIds.has(row.msgId) || skip.has(row.msgId)) continue;
      try {
        const raw = (await reader.getRawEvent(roomId, row.eventId)) as RawEvent;
        if (!raw.content || !Object.keys(raw.content).length) continue; // redacted
        const replyToEventId = (
          raw.content['m.relates_to'] as { 'm.in_reply_to'?: { event_id?: string } } | undefined
        )?.['m.in_reply_to']?.event_id;
        const replyToMsgId = replyToEventId ? store.getZaloTargetByEventId(replyToEventId)?.zaloMsgId : undefined;
        liveItems.push({ kind: 'live', ts: raw.origin_server_ts, row, raw, ...(replyToMsgId ? { replyToMsgId } : {}) });
      } catch (err) {
        console.warn(`[import] could not read live event ${row.eventId} (${row.msgId}):`, (err as Error).message);
      }
    }
  }
  return liveItems;
}

/**
 * The live event re-posted into the new room: same sender/time/content, reply remapped.
 * A reply whose target has no event in the new room loses its relation. Group ghost
 * senders are joined to the new room first (Matrix side effect).
 *
 * @param eventIds Zalo msgId → event id in the new room
 */
async function livePayload(
  item: LiveItem,
  newRoomId: string,
  threadType: 'user' | 'group',
  eventIds: Map<string, string>,
) {
  const content = { ...item.raw.content };
  if (content['m.relates_to'] && (content['m.relates_to'] as Record<string, unknown>)['m.in_reply_to']) {
    const remapped = item.replyToMsgId ? eventIds.get(item.replyToMsgId) : undefined;
    if (remapped) content['m.relates_to'] = { 'm.in_reply_to': { event_id: remapped } };
    else delete content['m.relates_to'];
  }
  const ghostUid = /^@sh-zalo_(\d+):/.exec(item.raw.sender)?.[1];
  if (ghostUid && threadType === 'group') await portals.ensureGhostInRoom(ghostUid, newRoomId, names.get(ghostUid));
  return { type: item.raw.type, sender: item.raw.sender, origin_server_ts: item.raw.origin_server_ts, content };
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
): Promise<RepointRow[]> {
  const tail = (await readLiveEvents(roomIds, knownMsgIds, new Set(eventIds.keys()))).sort((a, b) => a.ts - b.ts);
  if (!tail.length) return [];
  const payloads = [];
  for (const item of tail) payloads.push(await livePayload(item, newRoomId, threadType, eventIds));
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
  console.log(`[import] ${key} "${label ?? ''}" → ${portal.room_id}: ${olderEvents.length} messages`);
  const stats: Record<string, number> = {};
  let imported = 0;
  // Newest chunk first: each forward:false batch lands before the previous one
  for (let end = olderEvents.length; end > 0; end -= cliOptions.batch) {
    const chunk = olderEvents.slice(Math.max(0, end - cliOptions.batch), end);
    // Replies resolve only to targets already in the room (older chunks land later)
    const payloads = await mapLimit(chunk, PREPARE_CONCURRENCY, (event) =>
      toPayload(event, (event.quote?.msgId && store.getEventIdByMsgId(event.quote.msgId)) || null, failedGhosts, stats),
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
      console.warn(`[retire] delete ${roomId} as ${intent.userId} failed:`, (err as Error).message);
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
 * Verify the thread, then remove its superseded rooms; nothing is removed on any problem.
 * @throws when verification finds problems, or a room removal fails
 */
async function retire(key: string, oldRooms: string[]): Promise<void> {
  const problems = await verifyThread(key);
  if (problems.length) throw new Error(`not removing old rooms of ${key}: ${problems.join('; ')}`);
  const { threadId, threadType } = parseThreadKey(key);
  for (const roomId of oldRooms) await removeRoom(roomId, threadId, threadType);
}

// ---------------------------------------------------------------------------
// Main: per-conversation run, completeness check, exit code
// ---------------------------------------------------------------------------

let imported = 0;
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
    const { threadId } = parseThreadKey(key);
    const before = store.getPortalByThread(threadId)?.room_id;
    imported += await (cliOptions.rebuild ? rebuild(key) : prepend(key));
    // Only a rebuild that moved the thread to a new room has something to retire
    // (an empty export creates no room and keeps the current one)
    const after = store.getPortalByThread(threadId)?.room_id;
    if (cliOptions.rebuild && cliOptions.removeOld && after && after !== before) {
      await retire(key, [...new Set([...(before ? [before] : []), ...cliOptions.carryFrom])]);
    } else if (cliOptions.rebuild && after === before)
      console.log(`[import] ${key}: nothing to rebuild, room unchanged`);
  } catch (err) {
    failures.push(`${key}: ${(err as Error).message}`);
    console.error(`[import] ${key} failed:`, (err as Error).message);
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
  `[import] done: ${imported} messages imported, ${missing} missing${failures.length ? `, ${failures.length} conversations failed:\n  ${failures.join('\n  ')}` : ''}`,
);
store.close();
process.exit(failures.length || missing ? 1 : 0);
