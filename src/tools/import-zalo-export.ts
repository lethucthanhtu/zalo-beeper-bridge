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
import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { Bridge } from "matrix-appservice-bridge";
import { loadConfig } from "../config.ts";
import { dropShadowCopies, parseThreadKey, quoteFallback, renderExportRow, type ExportRow, type ImportEvent } from "../bridge/history-import.ts";
import { animatedSticker } from "../bridge/animated-sticker.ts";
import { MappingStore } from "../bridge/mapping-store.ts";
import { ownerIntent } from "../bridge/owner-intent.ts";
import { buildLinkPreview, buildMediaEvent, fetchFirstMedia, LARGE_MEDIA_MAX_BYTES, type Uploader } from "../bridge/media-content.ts";
import { sniffMimetype } from "../bridge/media-handler.ts";
import { buildInboundMentions } from "../bridge/mentions.ts";
import { SELF_BRIDGE_MARKER } from "../bridge/outbound-handler.ts";
import { PortalManager } from "../bridge/portal-manager.ts";
import { PuppetRegistry } from "../bridge/puppet-registry.ts";

const IMPORT_MARKER = "com.zalo-bridge.history_import";
/** History media is mostly expired: fail fast instead of the live 30 s timeout */
const IMPORT_FETCH_TIMEOUT_MS = 10_000;
/** Messages of one batch whose media/previews are prepared concurrently */
const PREPARE_CONCURRENCY = 6;
/** CDN hosts that keep media long-term (Zalo Cloud, resources, GIFs, stickers) */
const PERMANENT_HOST = /(zpcloud|zfcloud|res-zalo|zalo-gif|zgif|zalo-api)\./;

function parseArgs(argv: string[]) {
  const opts = {
    dir: "",
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
    const a = argv[i]!;
    if (a === "--only") opts.only = new Set(argv[++i]!.split(","));
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--probe") opts.probe = true;
    else if (a === "--rebuild") opts.rebuild = true;
    else if (a === "--media-dir") opts.mediaDir = argv[++i]!;
    else if (a === "--own-uid") opts.ownUid = argv[++i]!;
    else if (a === "--carry-from") opts.carryFrom = argv[++i]!.split(",");
    else if (a === "--remove-old") opts.removeOld = true;
    else if (a === "--verify") opts.verify = true;
    else if (a === "--retire") opts.retire = argv[++i]!.split(",");
    else if (a === "--batch") opts.batch = Number(argv[++i]);
    else if (a === "--delay-ms") opts.delayMs = Number(argv[++i]);
    else if (a === "--media-days") opts.mediaDays = Number(argv[++i]);
    else if (!opts.dir) opts.dir = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.dir) {
    throw new Error(
      "usage: import-zalo-export.ts <exportDir> [--only k1,k2] [--dry-run] [--rebuild] [--media-dir DIR] [--own-uid UID] [--batch N] [--delay-ms N] [--media-days N]",
    );
  }
  if (opts.rebuild && !opts.only) throw new Error("--rebuild needs an explicit --only list of conversations");
  if (opts.retire && opts.only?.size !== 1) throw new Error("--retire needs exactly one --only conversation");
  return opts;
}

/** Order-preserving map with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ExportMeta {
  convs: Array<{ key: string; isGroup: boolean }>;
  gmap: Record<string, string | null>;
  fmap: Record<string, string | null>;
}

interface LocalMedia {
  file: string;
  mimetype: string;
  size: number;
  w?: number;
  h?: number;
  name?: string;
}

interface Media {
  buffer: Buffer;
  mimetype: string;
  width?: number;
  height?: number;
  source: "local" | "cdn" | "animated";
}

const opts = parseArgs(process.argv.slice(2));
const config = loadConfig();
const registration = loadYaml(fs.readFileSync(config.matrix.registrationPath, "utf8")) as { sender_localpart?: string };
const bridgeAppId = (registration.sender_localpart ?? "sh-zalobot").replace(/bot$/, "");
const branding = { ...config.network, stateKey: `${config.matrix.domain}/${bridgeAppId}` };
const owner = config.matrix.owner;

const meta = JSON.parse(fs.readFileSync(path.join(opts.dir, "conversations.json"), "utf8")) as ExportMeta;
const keys = fs
  .readdirSync(opts.dir)
  .filter((f) => f.endsWith(".ndjson"))
  .map((f) => f.slice(0, -".ndjson".length))
  .filter((k) => !opts.only || opts.only.has(k));
const localMedia: Record<string, LocalMedia> = opts.mediaDir
  ? (JSON.parse(fs.readFileSync(path.join(opts.mediaDir, "media-index.json"), "utf8")) as Record<string, LocalMedia>)
  : {};

/** Every msgId in the export file, shadow copies included (they are known, just not posted). */
const exportedIds = new Map<string, Set<string>>();

function readRows(key: string): ExportRow[] {
  const text = fs.readFileSync(path.join(opts.dir, `${key}.ndjson`), "utf8");
  const rows = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ExportRow);
  exportedIds.set(key, new Set(rows.map((r) => String(r.msgId))));
  return dropShadowCopies(rows);
}

/** Best-known display name per Zalo uid: friend list first, then the latest dName seen. */
function nameIndex(rowsByKey: Map<string, ExportRow[]>): Map<string, string> {
  const names = new Map<string, string>();
  for (const rows of rowsByKey.values()) for (const r of rows) if (r.fromUid && r.fromUid !== "0" && r.dName) names.set(r.fromUid, r.dName);
  for (const [uid, name] of Object.entries(meta.fmap)) if (name) names.set(uid, name);
  return names;
}

const rowsByKey = new Map(keys.map((k) => [k, readRows(k)] as const));
const names = nameIndex(rowsByKey);

function eventsFor(key: string): ImportEvent[] {
  const { threadId, threadType } = parseThreadKey(key);
  return rowsByKey
    .get(key)!
    .map((r) => renderExportRow(r, threadType, threadId))
    .filter((e): e is ImportEvent => e !== null)
    .sort((a, b) => a.timestamp - b.timestamp || (a.msgId < b.msgId ? -1 : 1));
}

const cdnWorthTrying = (url: string, ts: number) => PERMANENT_HOST.test(url) || Date.now() - ts <= opts.mediaDays * 86_400_000;

// Stickers repeat a lot — fetch (and upload) each id once per run
const stickerCache = new Map<number, Promise<Media | null>>();

/** Backup copy first, then the CDN candidates; null when no copy is reachable. */
async function resolveMedia(ev: ImportEvent): Promise<Media | null> {
  const media = ev.media;
  if (!media) return null;
  const local = localMedia[ev.msgId];
  if (local && opts.mediaDir) {
    try {
      const buffer = fs.readFileSync(path.join(opts.mediaDir, local.file));
      return { buffer, mimetype: sniffMimetype(buffer, local.mimetype), width: local.w, height: local.h, source: "local" };
    } catch {
      // fall through to the CDN
    }
  }
  if (media.kind === "sticker" && media.stickerId) {
    const id = media.stickerId;
    let cached = stickerCache.get(id);
    if (!cached) {
      // Animated WebP built from the sprite strip; still PNG/GIF for single-frame stickers
      cached = animatedSticker(id).then(async (anim) =>
        anim
          ? { buffer: anim.buffer, mimetype: anim.mimetype, width: anim.width, height: anim.height, source: "animated" as const }
          : fetchFirst(media.urls, config.bridge.mediaMaxBytes),
      );
      stickerCache.set(id, cached);
    }
    return cached;
  }
  // Same caps as the live bridge: videos and documents may exceed the photo cap
  const cap = media.kind === "video" || media.kind === "file" ? Math.max(config.bridge.mediaMaxBytes, LARGE_MEDIA_MAX_BYTES) : config.bridge.mediaMaxBytes;
  return fetchFirst(media.urls.filter((u) => cdnWorthTrying(u, ev.timestamp)), cap);
}

async function fetchFirst(urls: string[], maxBytes: number): Promise<Media | null> {
  const found = await fetchFirstMedia(urls, maxBytes, IMPORT_FETCH_TIMEOUT_MS);
  return found ? { ...found, source: "cdn" } : null;
}

const upload: Uploader = (buffer, o) => bot.uploadContent(buffer, o);

// Uploaded mxc per sticker id (stickerCache dedupes the download, this the upload)
const stickerMxc = new Map<number, string>();

/**
 * Matrix event (type + content) for an import event, shaped like the live bridge's
 * posts. Media is uploaded here; unreachable media falls back to the text line.
 */
async function buildEvent(
  ev: ImportEvent,
  replyTo: string | null,
  stats: Record<string, number>,
): Promise<{ type: string; content: Record<string, unknown> }> {
  const relates = replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: replyTo } } } : {};
  const media = ev.media ? await resolveMedia(ev) : null;
  const m = ev.media;
  if (m && media) {
    stats[`${m.kind}:${media.source}`] = (stats[`${m.kind}:${media.source}`] ?? 0) + 1;
    const sticker = m.kind === "sticker" ? m.stickerId : undefined;
    const built = await buildMediaEvent(upload, m, media, {
      filename: localMedia[ev.msgId]?.name,
      mxcUrl: sticker ? stickerMxc.get(sticker) : undefined,
    });
    if (sticker) stickerMxc.set(sticker, built.mxcUrl);
    return { type: built.type, content: { ...built.content, ...relates } };
  }
  if (m) stats[`${m.kind}:text`] = (stats[`${m.kind}:text`] ?? 0) + 1;

  const body = (ev.quote && !replyTo ? quoteFallback(ev.quote) : "") + ev.content.body;
  const content: Record<string, unknown> = { msgtype: ev.content.msgtype, body, ...relates };
  if (ev.linkPreview) {
    content["com.beeper.linkpreviews"] = [await buildLinkPreview(upload, ev.linkPreview, config.bridge.mediaMaxBytes, IMPORT_FETCH_TIMEOUT_MS)];
    stats["link:preview"] = (stats["link:preview"] ?? 0) + 1;
  }
  if (ev.mentions?.length && !(ev.quote && !replyTo)) {
    // positions are relative to the original text — only valid without the quote prefix
    const { formattedBody, userIds } = buildInboundMentions(ev.content.body, ev.mentions, (uid) =>
      uid === opts.ownUid ? owner : puppets.mxidFor(uid),
    );
    content.format = "org.matrix.custom.html";
    content.formatted_body = formattedBody;
    content["m.mentions"] = { user_ids: userIds };
  }
  return { type: "m.room.message", content };
}

function labelOf(key: string): string | null {
  const { threadId, threadType } = parseThreadKey(key);
  return threadType === "group" ? (meta.gmap[key] ?? null) : (names.get(threadId) ?? null);
}

if (opts.dryRun) {
  let total = 0;
  for (const key of rowsByKey.keys()) {
    const events = eventsFor(key);
    total += events.length;
    const kinds: Record<string, number> = {};
    let quotes = 0;
    const ids = new Set(events.map((e) => e.msgId));
    for (const e of events) {
      // --probe: actually fetch each attachment (no upload) to see which still resolve
      const found = e.media && opts.probe && !localMedia[e.msgId] ? ((await resolveMedia(e)) ? "(cdn)" : "(text)") : "";
      const k = e.media ? `${e.media.kind}${localMedia[e.msgId] ? "(local)" : found}` : e.content.msgtype;
      kinds[k] = (kinds[k] ?? 0) + 1;
      if (e.quote?.msgId && ids.has(e.quote.msgId)) quotes++;
    }
    if (events.length) console.log(`${key} (${labelOf(key) ?? "?"}): ${events.length} events ${JSON.stringify(kinds)}, ${quotes} replies`);
  }
  console.log(`dry run: ${total} events in ${rowsByKey.size} conversations`);
  process.exit(0);
}

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

async function batchSend(roomId: string, events: Array<Record<string, unknown>>, forward: boolean): Promise<string[]> {
  const res = (await bot.matrixClient.doRequest(
    "POST",
    `/_matrix/client/unstable/com.beeper.backfill/rooms/${encodeURIComponent(roomId)}/batch_send`,
    null,
    { forward, forward_if_no_messages: true, send_notification: false, mark_read_by: owner, events },
  )) as { event_ids?: string[] };
  return res.event_ids ?? [];
}

/** Senders must be members: DM peer created the room; group ghosts are invited + joined. */
async function prepareSenders(events: ImportEvent[], roomId: string, threadType: "user" | "group", key: string): Promise<Set<string>> {
  const ghostIds = new Set(events.flatMap((e) => (e.sender.kind === "ghost" ? [e.sender.uid] : [])));
  // A ghost that cannot join must not sink the whole group: its messages go out as the bot
  const failedGhosts = new Set<string>();
  for (const uid of ghostIds) {
    const name = names.get(uid);
    try {
      await puppets.ensurePuppet(uid, name);
      if (threadType === "group") await portals.ensureGhostInRoom(uid, roomId, name);
    } catch (err) {
      if (threadType === "user") throw err; // the DM peer created the room — nothing to fall back to
      failedGhosts.add(uid);
      console.warn(`[import] ghost ${uid} unavailable in ${key}, sending as bot:`, (err as Error).message);
    }
  }
  return failedGhosts;
}

async function toPayload(ev: ImportEvent, replyTo: string | null, failedGhosts: Set<string>, stats: Record<string, number>) {
  const { type, content } = await buildEvent(ev, replyTo, stats);
  Object.assign(content, { [SELF_BRIDGE_MARKER]: true, [IMPORT_MARKER]: true });
  if (ev.sender.kind === "owner") content["fi.mau.double_puppet_source"] = bridgeAppId;
  let sender = ev.sender.kind === "owner" ? owner : ev.sender.kind === "ghost" ? puppets.mxidFor(ev.sender.uid) : bot.userId;
  if (ev.sender.kind === "ghost" && failedGhosts.has(ev.sender.uid)) {
    sender = bot.userId;
    if (type === "m.room.message") content.body = `${names.get(ev.sender.uid) ?? ev.sender.uid}: ${String(content.body)}`;
  }
  return { type, sender, origin_server_ts: ev.timestamp, content };
}

const direction = (ev: ImportEvent) => (ev.sender.kind === "owner" ? "outbound" : "inbound") as "outbound" | "inbound";

/** Full ordered history into a fresh room, then repoint the thread to it. */
async function rebuild(key: string): Promise<number> {
  const { threadId, threadType } = parseThreadKey(key);
  const events = eventsFor(key);
  if (!events.length) return 0;
  const old = store.getPortalByThread(threadId);
  const label = old?.name ?? labelOf(key);
  const portal = await portals.createDetachedPortal({
    threadId,
    threadType,
    senderId: threadId,
    senderName: label ?? undefined,
    resolveGroupName: async () => label,
  });
  try {
    return await fillAndSwitch(key, events, old, portal, label);
  } catch (err) {
    // Not repointed → the half-filled room is unreachable: drop it, the old room stays
    if (!store.isPortalRoom(portal.room_id)) {
      await removeRoom(portal.room_id, threadId, threadType).catch((e: Error) => console.warn(`[import] could not drop partial room ${portal.room_id}:`, e.message));
    }
    throw err;
  }
}

async function fillAndSwitch(
  key: string,
  events: ImportEvent[],
  old: ReturnType<MappingStore["getPortalByThread"]>,
  portal: { room_id: string },
  label: string | null,
): Promise<number> {
  const { threadId, threadType } = parseThreadKey(key);
  const failedGhosts = await prepareSenders(events, portal.room_id, threadType, key);

  // Live-bridged messages the export does not know (Zalo PC missed them, or they arrived
  // after the export was taken): replay their Matrix events in timeline order
  const known = exportedIds.get(key) ?? new Set<string>();
  const sources = [...new Set([...(old ? [old.room_id] : []), ...opts.carryFrom])];
  const live = await readLiveEvents(sources, known, new Set());
  const items: Item[] = [...events.map((ev) => ({ kind: "export" as const, ev, ts: ev.timestamp })), ...live].sort((a, b) => a.ts - b.ts);
  console.log(
    `[import] rebuild ${key} "${label ?? ""}": ${events.length} messages + ${live.length} live-only → new room ${portal.room_id} (old ${old?.room_id ?? "none"})`,
  );

  const eventIds = new Map<string, string>();
  const stats: Record<string, number> = {};
  const done: RepointRow[] = [];
  let chunk: Item[] = [];
  const flush = async () => {
    if (!chunk.length) return;
    const payload = await mapLimit(chunk, PREPARE_CONCURRENCY, (it) =>
      it.kind === "export"
        ? toPayload(it.ev, (it.ev.quote?.msgId && eventIds.get(it.ev.quote.msgId)) || null, failedGhosts, stats)
        : livePayload(it, portal.room_id, threadType, eventIds),
    );
    const ids = await batchSend(portal.room_id, payload, true);
    chunk.forEach((it, i) => {
      const id = ids[i];
      if (!id) return;
      const msgId = it.kind === "export" ? it.ev.msgId : it.row.msgId;
      eventIds.set(msgId, id);
      done.push(
        it.kind === "export"
          ? { msgId, eventId: id, direction: direction(it.ev), cliMsgId: it.ev.cliMsgId ?? null, msgType: it.ev.rawMsgType }
          : { msgId, eventId: id, direction: it.row.direction, cliMsgId: it.row.cliMsgId, msgType: it.row.msgType },
      );
    });
    chunk = [];
    await sleep(opts.delayMs);
  };
  const inChunk = new Set<string>();
  for (const it of items) {
    // A reply needs its target's event id: send the target's chunk first
    const target = it.kind === "export" ? it.ev.quote?.msgId : it.replyToMsgId;
    if (target && inChunk.has(target)) {
      await flush();
      inChunk.clear();
    }
    chunk.push(it);
    inChunk.add(it.kind === "export" ? it.ev.msgId : it.row.msgId);
    if (chunk.length >= opts.batch) {
      await flush();
      inChunk.clear();
    }
  }
  await flush();

  // Messages bridged into the old room while this ran: copy right before the switch,
  // then once more for anything that raced the repoint (both are the newest messages)
  const row = { thread_id: threadId, thread_type: threadType, room_id: portal.room_id, name: label };
  const tail = await copyLive(sources, portal.room_id, threadType, known, eventIds);
  store.repointPortal(row, [...done, ...tail]);
  const raced = await copyLive(sources, portal.room_id, threadType, known, eventIds);
  if (raced.length) store.repointPortal(row, raced);

  const stranded = sources.flatMap((r) => store.getRoomMessages(r)).filter((m) => !known.has(m.msgId)).length;
  const sentExport = done.filter((d) => known.has(d.msgId)).length;
  console.log(
    `[import] ${key}: ${sentExport}/${events.length} sent, ${done.length - sentExport + tail.length + raced.length} live-only message(s) carried over, media ${JSON.stringify(stats)}` +
      (stranded ? `; WARNING ${stranded} live message(s) could not be carried over` : ""),
  );
  return done.length + tail.length + raced.length;
}

interface RepointRow {
  msgId: string;
  eventId: string;
  direction: "inbound" | "outbound";
  cliMsgId: string | null;
  msgType: string | null;
}

interface RawEvent {
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
}

interface LiveItem {
  kind: "live";
  ts: number;
  row: ReturnType<MappingStore["getRoomMessages"]>[number];
  raw: RawEvent;
  /** Zalo msgId the live event replied to (for chunk ordering + remap) */
  replyToMsgId?: string;
}

type Item = { kind: "export"; ev: ImportEvent; ts: number } | LiveItem;

/** Live-bridged messages of the given rooms that the export lacks, with their Matrix events. */
async function readLiveEvents(roomIds: string[], known: Set<string>, skip: Set<string>): Promise<LiveItem[]> {
  // The owner is joined to every portal (DMs are created by the ghost, not the bot)
  const reader = ownerIntent(bridge, owner).matrixClient;
  const out: LiveItem[] = [];
  for (const roomId of roomIds) {
    for (const row of store.getRoomMessages(roomId)) {
      if (!row.eventId || known.has(row.msgId) || skip.has(row.msgId)) continue;
      try {
        const raw = (await reader.getRawEvent(roomId, row.eventId)) as RawEvent;
        if (!raw.content || !Object.keys(raw.content).length) continue; // redacted
        const replyTo = (raw.content["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } } | undefined)?.["m.in_reply_to"]?.event_id;
        const replyToMsgId = replyTo ? store.getZaloTargetByEventId(replyTo)?.zaloMsgId : undefined;
        out.push({ kind: "live", ts: raw.origin_server_ts, row, raw, ...(replyToMsgId ? { replyToMsgId } : {}) });
      } catch (err) {
        console.warn(`[import] could not read live event ${row.eventId} (${row.msgId}):`, (err as Error).message);
      }
    }
  }
  return out;
}

/** The live event re-posted into the new room: same sender/time/content, reply remapped. */
async function livePayload(it: LiveItem, newRoomId: string, threadType: "user" | "group", eventIds: Map<string, string>) {
  const content = { ...it.raw.content };
  if (content["m.relates_to"] && (content["m.relates_to"] as Record<string, unknown>)["m.in_reply_to"]) {
    const remapped = it.replyToMsgId ? eventIds.get(it.replyToMsgId) : undefined;
    if (remapped) content["m.relates_to"] = { "m.in_reply_to": { event_id: remapped } };
    else delete content["m.relates_to"];
  }
  const ghost = /^@sh-zalo_(\d+):/.exec(it.raw.sender)?.[1];
  if (ghost && threadType === "group") await portals.ensureGhostInRoom(ghost, newRoomId, names.get(ghost));
  return { type: it.raw.type, sender: it.raw.sender, origin_server_ts: it.raw.origin_server_ts, content };
}

/** Copies live messages not yet in the new room (they arrived during the rebuild), oldest first. */
async function copyLive(
  roomIds: string[],
  newRoomId: string,
  threadType: "user" | "group",
  known: Set<string>,
  eventIds: Map<string, string>,
): Promise<RepointRow[]> {
  const tail = (await readLiveEvents(roomIds, known, new Set(eventIds.keys()))).sort((a, b) => a.ts - b.ts);
  if (!tail.length) return [];
  const payload = [];
  for (const it of tail) payload.push(await livePayload(it, newRoomId, threadType, eventIds));
  const ids = await batchSend(newRoomId, payload, true);
  const out: RepointRow[] = [];
  tail.forEach((it, i) => {
    const id = ids[i];
    if (!id) return;
    eventIds.set(it.row.msgId, id);
    out.push({ msgId: it.row.msgId, eventId: id, direction: it.row.direction, cliMsgId: it.row.cliMsgId, msgType: it.row.msgType });
  });
  return out;
}

/** Default mode: history older than the room's first bridged message, prepended. */
async function prepend(key: string): Promise<number> {
  const { threadId, threadType } = parseThreadKey(key);
  const events = eventsFor(key).filter((e) => !store.hasMessage(e.msgId));
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
  const todo = events.filter((e) => e.timestamp < cutoff);
  if (!todo.length) return 0;
  const failedGhosts = await prepareSenders(todo, portal.room_id, threadType, key);
  console.log(`[import] ${key} "${label ?? ""}" → ${portal.room_id}: ${todo.length} messages`);
  const stats: Record<string, number> = {};
  let imported = 0;
  // Newest chunk first: each forward:false batch lands before the previous one
  for (let end = todo.length; end > 0; end -= opts.batch) {
    const chunk = todo.slice(Math.max(0, end - opts.batch), end);
    // Replies resolve only to targets already in the room (older chunks land later)
    const payload = await mapLimit(chunk, PREPARE_CONCURRENCY, (ev) =>
      toPayload(ev, (ev.quote?.msgId && store.getEventIdByMsgId(ev.quote.msgId)) || null, failedGhosts, stats),
    );
    const ids = await batchSend(portal.room_id, payload, false);
    chunk.forEach((ev, i) => {
      // senderId stays null: Beeper reads of decade-old history must not emit Zalo "seen"
      store.recordMessage(ev.msgId, portal.room_id, ids[i] ?? null, direction(ev), null, ev.cliMsgId ?? null, null, ev.rawMsgType);
    });
    imported += chunk.length;
    await sleep(opts.delayMs);
  }
  console.log(`[import] ${key}: media ${JSON.stringify(stats)}`);
  return imported;
}

/** Every event id in a room's timeline (paginated back from the newest event). */
async function timelineEventIds(roomId: string): Promise<Set<string>> {
  const client = ownerIntent(bridge, owner).matrixClient;
  const ids = new Set<string>();
  let from: string | undefined;
  for (;;) {
    const res = (await client.doRequest("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`, {
      dir: "b",
      limit: 1000,
      ...(from ? { from } : {}),
    })) as { chunk: Array<{ event_id: string }>; end?: string };
    for (const e of res.chunk) ids.add(e.event_id);
    if (!res.end || !res.chunk.length) return ids;
    from = res.end;
  }
}

/**
 * A thread is verified when its portal room holds every renderable export message and
 * every message mapped to the room is a real event in the room's Beeper timeline.
 */
async function verifyThread(key: string): Promise<string[]> {
  const { threadId } = parseThreadKey(key);
  const portal = store.getPortalByThread(threadId);
  if (!portal) return ["no portal"];
  const rows = store.getRoomMessages(portal.room_id);
  const inRoom = new Set(rows.map((r) => r.msgId));
  const problems: string[] = [];
  const notMapped = eventsFor(key).filter((e) => !inRoom.has(e.msgId)).length;
  if (notMapped) problems.push(`${notMapped} export messages not mapped to the room`);
  const noEvent = rows.filter((r) => !r.eventId).length;
  if (noEvent) problems.push(`${noEvent} mapped messages without an event`);
  const timeline = await timelineEventIds(portal.room_id);
  const absent = rows.filter((r) => r.eventId && !timeline.has(r.eventId)).length;
  if (absent) problems.push(`${absent} mapped events missing from the Beeper timeline`);
  console.log(`[verify] ${key} → ${portal.room_id}: ${rows.length} mapped, ${timeline.size} timeline events${problems.length ? `, PROBLEMS: ${problems.join("; ")}` : ", OK"}`);
  return problems;
}

/** Deletes a superseded room in Beeper (fallback: owner leaves + forgets) and its mappings. */
async function removeRoom(roomId: string, threadId: string, threadType: "user" | "group"): Promise<void> {
  if (store.isPortalRoom(roomId)) throw new Error(`refusing to remove live portal room ${roomId}`);
  const deleteAs = threadType === "user" ? [puppets.intentFor(threadId), bot] : [bot];
  let how = "";
  for (const intent of deleteAs) {
    try {
      await intent.matrixClient.doRequest("POST", `/_matrix/client/unstable/com.beeper.yeet/rooms/${encodeURIComponent(roomId)}/delete`, null, {});
      how = `deleted (as ${intent.userId})`;
      break;
    } catch (err) {
      console.warn(`[retire] delete ${roomId} as ${intent.userId} failed:`, (err as Error).message);
    }
  }
  if (!how) {
    // Not Intent.leave(): that goes through bot-sdk's ensureRegistered → M_EXCLUSIVE for the owner
    const client = ownerIntent(bridge, owner).matrixClient;
    await client.leaveRoom(roomId);
    await client.doRequest("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/forget`, null, {});
    how = "left + forgotten by the owner";
  }
  const dropped = store.deleteRoomMessages(roomId);
  console.log(`[retire] ${roomId}: ${how}, ${dropped} stale mapping(s) dropped`);
}

/** Verify the thread, then remove its superseded rooms; nothing is removed on any problem. */
async function retire(key: string, oldRooms: string[]): Promise<void> {
  const problems = await verifyThread(key);
  if (problems.length) throw new Error(`not removing old rooms of ${key}: ${problems.join("; ")}`);
  const { threadId, threadType } = parseThreadKey(key);
  for (const roomId of oldRooms) await removeRoom(roomId, threadId, threadType);
}

let imported = 0;
const failures: string[] = [];
for (const key of rowsByKey.keys()) {
  try {
    if (opts.verify) {
      if ((await verifyThread(key)).length) failures.push(`${key}: verification failed`);
      continue;
    }
    if (opts.retire) {
      await retire(key, opts.retire);
      continue;
    }
    const { threadId } = parseThreadKey(key);
    const before = store.getPortalByThread(threadId)?.room_id;
    imported += await (opts.rebuild ? rebuild(key) : prepend(key));
    // Only a rebuild that moved the thread to a new room has something to retire
    // (an empty export creates no room and keeps the current one)
    const after = store.getPortalByThread(threadId)?.room_id;
    if (opts.rebuild && opts.removeOld && after && after !== before) {
      await retire(key, [...new Set([...(before ? [before] : []), ...opts.carryFrom])]);
    } else if (opts.rebuild && after === before) console.log(`[import] ${key}: nothing to rebuild, room unchanged`);
  } catch (err) {
    failures.push(`${key}: ${(err as Error).message}`);
    console.error(`[import] ${key} failed:`, (err as Error).message);
  }
}

// Completeness: every renderable export row of each conversation must now be recorded
let missing = 0;
for (const key of rowsByKey.keys()) {
  const lost = eventsFor(key).filter((e) => !store.hasMessage(e.msgId));
  if (lost.length) {
    missing += lost.length;
    console.warn(`[import] ${key}: ${lost.length} messages NOT imported`);
  }
}

console.log(`[import] done: ${imported} messages imported, ${missing} missing${failures.length ? `, ${failures.length} conversations failed:\n  ${failures.join("\n  ")}` : ""}`);
store.close();
process.exit(failures.length || missing ? 1 : 0);
