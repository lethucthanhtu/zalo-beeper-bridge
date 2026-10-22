#!/usr/bin/env node
/**
 * Import Zalo NDJSON exports into existing Beeper/Zalo bridge portals.
 *
 * IMPORTANT: Matrix client/appservice send APIs do not let a client choose
 * origin_server_ts. Events are sent oldest-first and retain the source timestamp
 * in both a visible annotation and custom event metadata; Beeper's event timestamp
 * will still be the import time unless the homeserver provides a privileged
 * historical-import API. Beeper Cloud support for such an API is not assumed.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { load as loadYaml } from "js-yaml";
import { createBridge } from "../matrix/appservice.ts";
import { loadConfig } from "../config.ts";
import { MappingStore } from "../bridge/mapping-store.ts";
import { PortalManager } from "../bridge/portal-manager.ts";
import { PuppetRegistry } from "../bridge/puppet-registry.ts";
import { ownerIntent } from "../bridge/owner-intent.ts";
import { bridgeInboundPhoto, bridgeInboundSticker } from "../bridge/media-handler.ts";
import type { ZaloThreadType } from "../zalo/types.ts";

type JsonRecord = Record<string, unknown>;
interface ThreadMapping {
  threadId: string;
  threadType: ZaloThreadType;
  name?: string;
}
interface ParsedMessage {
  msgId: string;
  timestamp: number;
  senderId: string;
  senderName?: string;
  content: Record<string, unknown>;
  threadId: string;
  threadType: ZaloThreadType;
  raw: JsonRecord;
}
interface Options {
  input: string;
  mapping?: string;
  dryRun: boolean;
  ownUid?: string;
  limit?: number;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv: string[]): Options {
  const options: Options = { input: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    if (arg === "--input" && value) { options.input = value; i++; }
    else if (arg === "--mapping" && value) { options.mapping = value; i++; }
    else if (arg === "--own-uid" && value) { options.ownUid = value; i++; }
    else if (arg === "--limit" && value && Number.isInteger(Number(value)) && Number(value) > 0) { options.limit = Number(value); i++; }
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  npm run import:ndjson -- --input ./zalo-export --dry-run
  npm run import:ndjson -- --input ./zalo-export --mapping ./threads.json

Options:
  --input DIR       Directory containing one .ndjson/.jsonl file per chat (required)
  --mapping FILE    Optional JSON mapping keyed by file basename, e.g.
                    { "g123.ndjson": { "threadId": "123", "threadType": "group", "name": "My group" } }
  --own-uid UID     Your Zalo UID; imports your own messages as the Beeper owner
  --limit N         Import at most N messages (useful for a smoke test)
  --dry-run         Parse and validate only; do not create rooms or send messages

Timestamp note:
  The original Zalo timestamp is annotated and stored as event metadata. Beeper Cloud
  does not expose a verified historical-event import API here, so the Matrix timeline
  timestamp remains the time the event is sent.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!options.input) throw new Error("--input is required");
  return options;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
function normalizeUid(value: string): string {
  return value.replace(/^[ug]/, "");
}
function timestampMs(row: JsonRecord): number | null {
  const raw = row.sendDttm ?? row.serverTime ?? row.timestamp ?? row.ts ?? row.time;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const value = raw < 100_000_000_000 ? raw * 1000 : raw;
    return value > 0 ? value : null;
  }
  if (typeof raw === "string" && raw.trim()) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      const value = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
      return value > 0 ? value : null;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function timestampLabel(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
function threadFromFilename(filename: string): { id: string; hintedType?: ZaloThreadType } | null {
  const stem = path.basename(filename).replace(/\.(ndjson|jsonl|json)$/i, "");
  const match = /(?:^|[^0-9])([ug]?\d+)$/.exec(stem);
  if (!match) return null;
  const token = match[1]!;
  const prefix = token[0] === "g" ? "group" : token[0] === "u" ? "user" : undefined;
  return { id: normalizeUid(token), hintedType: prefix };
}
function extractText(row: JsonRecord): string | undefined {
  const value = row.message ?? row.text ?? row.content ?? row.body;
  if (typeof value === "string") return value;
  const obj = asRecord(value);
  if (obj) {
    const text = firstString(obj.text, obj.message, obj.title, obj.description, obj.caption);
    if (text) return text;
  }
  return undefined;
}
function extractMediaUrl(row: JsonRecord): string | undefined {
  const content = asRecord(row.content);
  const media = asRecord(row.media);
  return firstString(
    row.url, row.href, row.imageUrl, row.photoUrl, row.fileUrl, row.downloadUrl,
    content?.url, content?.href, content?.photoUrl, content?.imageUrl,
    media?.url, media?.href,
  );
}
function toParsed(row: JsonRecord, mapping: ThreadMapping): ParsedMessage | null {
  const msgId = firstString(row.msgId, row.messageId, row.id);
  const senderId = firstString(row.fromUid, row.uidFrom, row.senderId, row.senderUid);
  const timestamp = timestampMs(row);
  if (!msgId || !senderId || timestamp === null) return null;
  const senderName = firstString(row.dName, row.senderName, row.fromName, row.name);
  const rawType = String(row.msgType ?? row.type ?? "unknown").toLowerCase();
  const text = extractText(row);
  const mediaUrl = extractMediaUrl(row);
  let content: Record<string, unknown>;
  const isSticker = rawType.includes("sticker") || row.stickerId !== undefined;
  const isPhoto = rawType.includes("photo") || rawType.includes("image") || rawType === "2" || rawType === "3";
  if (isSticker) {
    const stickerId = Number(row.stickerId ?? asRecord(row.content)?.id);
    const catId = Number(row.catId ?? asRecord(row.content)?.catId);
    content = Number.isFinite(stickerId) && stickerId > 0 && Number.isFinite(catId) && catId >= 0 && mediaUrl
      ? { msgtype: "sticker", stickerId, catId, mediaUrl, body: text || "[Zalo sticker]" }
      : { msgtype: "m.notice", body: `[Zalo sticker; original payload: ${JSON.stringify(row).slice(0, 1200)}]` };
  } else if (isPhoto && mediaUrl) {
    content = { msgtype: "m.image", url: mediaUrl, body: text || "[Zalo image]", originalType: rawType };
  } else if (text !== undefined) {
    content = { msgtype: "m.text", body: text };
  } else if (mediaUrl) {
    content = { msgtype: "m.file", url: mediaUrl, body: firstString(row.fileName, row.title) || `[Zalo attachment: ${rawType}]`, originalType: rawType };
  } else {
    // Preserve unsupported message data as readable text rather than silently dropping it.
    content = { msgtype: "m.notice", body: `[Imported Zalo message type: ${rawType}]\n${JSON.stringify(row, null, 2).slice(0, 3000)}` };
  }
  return { msgId, timestamp, senderId, senderName, content, threadId: mapping.threadId, threadType: mapping.threadType, raw: row };
}
async function listFiles(input: string): Promise<string[]> {
  const stat = await fs.promises.stat(input);
  if (stat.isFile()) return /\.(ndjson|jsonl)$/i.test(input) ? [input] : [];
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.(ndjson|jsonl)$/i.test(entry.name)) out.push(full);
    }
  }
  await walk(input);
  return out;
}
async function readRows(file: string): Promise<Array<{ line: number; row: JsonRecord }>> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const rows: Array<{ line: number; row: JsonRecord }> = [];
  let line = 0;
  for await (const rawLine of lines) {
    line++;
    if (!rawLine.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(rawLine);
      const row = asRecord(parsed);
      if (!row) throw new Error("JSON line is not an object");
      rows.push({ line, row });
    } catch (err) {
      console.warn(`[import] ${file}:${line}: invalid NDJSON: ${(err as Error).message}`);
    }
  }
  return rows;
}
function getMapping(file: string, rows: Array<{ line: number; row: JsonRecord }>, mappings: Record<string, ThreadMapping>, store: MappingStore): ThreadMapping {
  const base = path.basename(file);
  const explicit = mappings[base] ?? mappings[file];
  if (explicit) {
    if (!explicit.threadId || !["user", "group"].includes(explicit.threadType)) throw new Error(`Invalid mapping for ${base}`);
    return { ...explicit, threadId: normalizeUid(explicit.threadId) };
  }
  const fromName = threadFromFilename(file);
  if (fromName) {
    const existing = store.getPortalByThread(fromName.id);
    const type = existing?.thread_type ?? fromName.hintedType;
    if (type) return { threadId: fromName.id, threadType: type };
  }
  const toUids = [...new Set(rows.map(({ row }) => firstString(row.toUid, row.threadId, row.conversationId)).filter((v): v is string => !!v))];
  const groupTarget = toUids.find((uid) => uid.startsWith("g"));
  if (groupTarget) return { threadId: normalizeUid(groupTarget), threadType: "group" };
  const onlyTarget = toUids.length === 1 ? toUids[0] : undefined;
  if (onlyTarget) {
    const id = normalizeUid(onlyTarget);
    const existing = store.getPortalByThread(id);
    if (existing) return { threadId: id, threadType: existing.thread_type };
  }
  throw new Error(`Cannot determine chat ID/type for ${base}. Add it to --mapping; do not guess whether this is a DM or group.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const input = path.resolve(options.input);
  const files = await listFiles(input);
  if (!files.length) throw new Error(`No .ndjson/.jsonl files found under ${input}`);
  const mappings: Record<string, ThreadMapping> = options.mapping
    ? JSON.parse(await fs.promises.readFile(path.resolve(options.mapping), "utf8")) as Record<string, ThreadMapping>
    : {};

  const config = loadConfig();
  const registration = loadYaml(await fs.promises.readFile(config.matrix.registrationPath, "utf8")) as { namespaces?: { users?: Array<{ regex: string }> } };
  const ghostRegex = registration.namespaces?.users?.[0]?.regex;
  if (!ghostRegex) throw new Error(`No user namespace in ${config.matrix.registrationPath}`);

  const store = new MappingStore(config.bridge.dbPath);
  const bridge = createBridge(config, async () => {}, async () => {});
  await bridge.initialise();
  const branding = { ...config.network, stateKey: `${config.matrix.domain}/sh-zalo` };
  const puppets = new PuppetRegistry(bridge, store, config.matrix.domain);
  const portals = new PortalManager(bridge, store, puppets, config.matrix.owner, branding);
  let sent = 0;
  let skipped = 0;
  let invalid = 0;
  let failed = 0;
  let total = 0;
  try {
    const all: ParsedMessage[] = [];
    for (const file of files) {
      const rows = await readRows(file);
      let mapping: ThreadMapping;
      try { mapping = getMapping(file, rows, mappings, store); }
      catch (err) { console.error(`[import] ${(err as Error).message}`); failed += rows.length; continue; }
      for (const { row } of rows) {
        const parsed = toParsed(row, mapping);
        if (!parsed) { invalid++; continue; }
        all.push(parsed);
      }
    }
    all.sort((a, b) => a.timestamp - b.timestamp || a.msgId.localeCompare(b.msgId));
    const selected = options.limit ? all.slice(0, options.limit) : all;
    total = selected.length;
    console.log(`[import] files=${files.length}, valid=${all.length}, selected=${selected.length}, dryRun=${options.dryRun}`);
    if (options.dryRun) {
      const chats = new Map<string, number>();
      for (const msg of selected) chats.set(`${msg.threadType}:${msg.threadId}`, (chats.get(`${msg.threadType}:${msg.threadId}`) ?? 0) + 1);
      for (const [chat, count] of chats) console.log(`  ${chat}: ${count} messages`);
      console.log("[import] dry-run complete; no Matrix events were sent.");
      return;
    }

    // The appservice token can create ghost users via Intent; do not start another
    // HTTP listener here, because the normal bridge process may already own the port.
    for (const msg of selected) {
      if (store.hasMessage(msg.msgId)) { skipped++; continue; }
      try {
        const portal = await portals.getOrCreatePortal({
          threadId: msg.threadId,
          threadType: msg.threadType,
          senderId: msg.threadType === "user" ? msg.threadId : msg.senderId,
          senderName: msg.threadType === "user" ? msg.senderName : undefined,
        });
        const isSelf = !!options.ownUid && msg.senderId === options.ownUid;
        const intent = isSelf
          ? ownerIntent(bridge, config.matrix.owner)
          : await puppets.ensurePuppet(msg.senderId, msg.senderName);
        if (msg.threadType === "group" && !isSelf) {
          await portals.ensureGhostInRoom(msg.senderId, portal.room_id, msg.senderName);
        }
        const original = timestampLabel(msg.timestamp);
        const extra = {
          "com.lethucthanhtu.zalo_import": {
            original_timestamp_ms: msg.timestamp,
            original_timestamp: original,
            source: "zalo-ndjson",
            msg_id: msg.msgId,
          },
        };
        const content = { ...msg.content };
        if (content.msgtype === "sticker" && typeof content.mediaUrl === "string") {
          const stickerId = Number(content.stickerId);
          // A sticker image URL must be hosted on the supported Zalo CDN; failures fall back to a notice.
          try {
            const { eventId } = await bridgeInboundSticker(intent, portal.room_id, stickerId, content.mediaUrl, config.bridge.mediaMaxBytes, extra);
            store.recordMessage(msg.msgId, portal.room_id, eventId, "inbound", null, firstString(msg.raw.cliMsgId) ?? null, msg.senderId, String(msg.raw.msgType ?? ""));
          } catch (err) {
            const result = await intent.sendMessage(portal.room_id, { msgtype: "m.notice", body: `[Zalo sticker import failed: ${(err as Error).message}] Original time: ${original}`, ...extra });
            store.recordMessage(msg.msgId, portal.room_id, result.event_id, "inbound", null, null, msg.senderId, String(msg.raw.msgType ?? ""));
          }
          sent++;
          continue;
        }
        if (content.msgtype === "m.image" && typeof content.url === "string") {
          try {
            const { eventId } = await bridgeInboundPhoto(intent, portal.room_id, {
              url: content.url,
              caption: `[Imported from Zalo · original time: ${original}] ${typeof content.body === "string" ? content.body : ""}`,
            }, config.bridge.mediaMaxBytes, extra);
            store.recordMessage(msg.msgId, portal.room_id, eventId, "inbound", null, firstString(msg.raw.cliMsgId) ?? null, msg.senderId, String(msg.raw.msgType ?? ""));
          } catch (err) {
            const result = await intent.sendMessage(portal.room_id, { msgtype: "m.notice", body: `[Zalo image import failed: ${(err as Error).message}] Original time: ${original}`, ...extra });
            store.recordMessage(msg.msgId, portal.room_id, result.event_id, "inbound", null, null, msg.senderId, String(msg.raw.msgType ?? ""));
          }
          sent++;
          continue;
        }
        if (typeof content.body === "string") {
          // Explicitly show source time; this does NOT change Matrix origin_server_ts.
          content.body = `[Imported from Zalo · original time: ${original}]\n${content.body}`;
        }
        const result = await intent.sendMessage(portal.room_id, { ...content, ...extra });
        store.recordMessage(msg.msgId, portal.room_id, result.event_id, "inbound", null, firstString(msg.raw.cliMsgId) ?? null, msg.senderId, String(msg.raw.msgType ?? ""));
        sent++;
        // Slow down to avoid overwhelming Beeper's homeserver and preserve chronological order.
        await sleep(150);
      } catch (err) {
        failed++;
        console.error(`[import] msgId=${msg.msgId} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    store.close();
  }
  console.log(`[import] done: selected=${total}, sent=${sent}, skipped(existing)=${skipped}, invalid=${invalid}, failed=${failed}`);
  console.log("[import] Original times are annotated/metadata only. Beeper timeline timestamps are import time unless Beeper provides a supported historical-import API.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[import] fatal:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
