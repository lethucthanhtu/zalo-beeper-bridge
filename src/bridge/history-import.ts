// Zalo PC history export (zexport: out/<threadKey>.ndjson rows from the app's own
// IndexedDB) → Matrix message content for Beeper batch-send backfill.
// Pure conversion only — the importer CLI (src/tools/import-zalo-export.ts) does the IO.
// Media rows carry an ImportMedia descriptor (candidate CDN URLs + metadata) so the
// importer can post them like the live bridge does (m.image / m.sticker / m.video /
// m.file / m.audio); `content` is the readable text used when no copy is reachable
// (Zalo CDN links expire ~14 days after sending).
import type { ZaloMention } from "../zalo/types.ts";
import type { LinkPreview, MediaDescriptor } from "./media-content.ts";

/** One exported Zalo PC message row (subset of fields the exporter keeps). */
export interface ExportRow {
  msgId: string;
  cliMsgId?: string;
  /** "0" = the account owner; absent on some system rows */
  fromUid?: string;
  toUid?: string;
  /** numeric Zalo PC message type (1 text, 2 photo, 4 sticker, 6 link, 19 file, ...) */
  msgType: number;
  sendDttm: string;
  message: unknown;
  dName?: string;
  quote?: { msg?: unknown; fromD?: string; globalMsgId?: string | number };
  mentions?: Array<{ uid?: string; pos: number; len: number }> | null;
  act?: string;
}

export type ImportSender = { kind: "owner" } | { kind: "ghost"; uid: string; name?: string } | { kind: "bot" };

/** A media attachment the importer tries to fetch (local backup copy first, then urls). */
export type ImportMedia = MediaDescriptor;

export interface ImportQuote {
  /** global msgId of the quoted message — resolvable to a Matrix reply when bridged */
  msgId?: string;
  fromName: string;
  /** first line of the quoted text, or "[đính kèm]" for quoted media */
  text: string;
}

export interface ImportEvent {
  msgId: string;
  cliMsgId?: string;
  timestamp: number;
  sender: ImportSender;
  /** Matrix m.room.message content: the text itself, or the fallback when media is unreachable */
  content: { msgtype: "m.text" | "m.notice"; body: string };
  media?: ImportMedia;
  linkPreview?: LinkPreview;
  mentions?: ZaloMention[];
  quote?: ImportQuote;
  rawMsgType: string;
}

/** Thread key in the export: "g<id>" for groups, bare uid for DMs. */
export function parseThreadKey(key: string): { threadId: string; threadType: "user" | "group" } {
  return key.startsWith("g") ? { threadId: key.slice(1), threadType: "group" } : { threadId: key, threadType: "user" };
}

type Obj = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | undefined => (Number(v) > 0 ? Number(v) : undefined);

function parseJson(v: unknown): Obj {
  if (v && typeof v === "object") return v as Obj;
  if (typeof v !== "string" || !v) return {};
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === "object" ? (parsed as Obj) : {};
  } catch {
    return {};
  }
}

const lines = (...parts: Array<string | undefined>): string => parts.filter((p) => p && p.trim()).join("\n");
const uniq = (urls: string[]): string[] => [...new Set(urls.filter((u) => /^https?:\/\//.test(u)))];

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** New Zalo photo URLs serve JPEG XL (no Matrix client renders it); the /jpg/ twin is a JPEG. */
export function jxlToJpgUrl(url: string): string {
  return url.replace("/jxl/", "/jpg/").replace(/\.jxl(\?jxlstatus=1)?$/, ".jpg");
}

/** Public sticker image (PNG, or GIF for legacy emoticons) — no Zalo session needed. */
export const stickerImageUrl = (id: number): string => `https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=${id}&size=240`;

/** System-message templates ("%1$s pinned message %2$s") filled from highlight names. */
function fillTemplate(params: Obj): string {
  const msg = parseJson(params.msg);
  const template = str(msg.vi) || str(msg.en);
  if (!template) return "";
  const highlights = Array.isArray(params.highLightsV2) ? (params.highLightsV2 as Obj[]).map((h) => str(h.dpn)) : [];
  const fills = highlights.length ? highlights : [str(params.dName), str(params.question)];
  return template.replace(/%(\d)\$s/g, (_, i: string) => fills[Number(i) - 1] ?? "");
}

interface Rendered {
  body: string;
  notice: boolean;
  media?: ImportMedia;
  linkPreview?: LinkPreview;
}

/** Renders the message body; `notice` marks system/placeholder lines. */
function render(row: ExportRow): Rendered {
  const m = row.message;
  if (typeof m === "string") {
    // Text, plus string placeholders for recalled (20) / deleted (-27) / system (-4) rows
    return { body: m, notice: row.msgType !== 1 };
  }
  if (Array.isArray(m)) {
    // msgType 21: Zalo OA / ZNS cards — list title + link per card
    const cards = (m as Obj[]).map((c) => lines(str(c.title), str(c.description), str(c.href)));
    return { body: lines("[Thẻ Zalo]", ...cards), notice: true };
  }
  const c = (m ?? {}) as Obj;
  const params = parseJson(c.params);
  const title = str(c.title);
  const desc = str(c.description) || str(c.desc);
  switch (row.msgType) {
    case 1:
      // rich-text (action "rtf"): the plain text is in the title
      return { body: title || desc, notice: false };
    case 2: {
      const caption = title || desc || undefined;
      const width = num(params.width);
      const height = num(params.height);
      const urls = uniq([str(c.hdUrl), str(params.hd), str(c.oriUrl), str(params.rawUrl), str(c.normalUrl)].map(jxlToJpgUrl));
      const dims = width && height ? ` ${width}×${height}` : "";
      return {
        body: lines(`📷 [Ảnh${dims} — không còn trên máy chủ Zalo]`, caption),
        notice: false,
        media: { kind: "image", urls, caption, width, height, size: num(params.fileSize) },
      };
    }
    case 3: {
      const durationMs = num(params.duration);
      const secs = durationMs ? ` ${Math.round(durationMs / 1000)}s` : "";
      return {
        body: `🎤 [Tin nhắn thoại${secs} — không còn trên máy chủ Zalo]`,
        notice: false,
        media: { kind: "audio", urls: uniq([str(params.m4a), str(c.href)]), filename: "zalo-voice.m4a", durationMs, size: num(params.fileSize) },
      };
    }
    case 4: {
      const id = Number(c.id);
      return Number.isFinite(id) && id > 0
        ? { body: "[Sticker]", notice: false, media: { kind: "sticker", urls: [stickerImageUrl(id)], stickerId: id } }
        : { body: "[Sticker]", notice: false };
    }
    case 7:
      return {
        body: "[GIF — không còn trên máy chủ Zalo]",
        notice: false,
        media: {
          kind: "image",
          urls: uniq([str(c.oriUrl), str(c.normalUrl), str(params.hd)]),
          filename: "zalo.gif",
          width: num(params.width),
          height: num(params.height),
          size: num(params.fileSize),
        },
      };
    case 17: {
      const map = c.lat && c.lo ? `https://maps.google.com/?q=${str(c.lat)},${str(c.lo)}` : "";
      return { body: lines("📍 [Vị trí]", desc || title, map), notice: false };
    }
    case 18: {
      const durationMs = num(c.duration) ?? num(params.duration);
      const secs = durationMs ? ` ${Math.round(durationMs / 1000)}s` : "";
      return {
        body: lines(`🎬 [Video${secs} — không còn trên máy chủ Zalo]`, title),
        notice: false,
        media: {
          kind: "video",
          urls: uniq([str(c.oriUrl), str(c.href)]),
          filename: "zalo-video.mp4",
          caption: title || undefined,
          width: num(params.video_width),
          height: num(params.video_height),
          durationMs,
          size: num(params.fileSize),
        },
      };
    }
    case 19: {
      const size = num(params.fileSize);
      const human = size ? ` (${formatBytes(size)})` : "";
      return {
        body: `📎 [Tệp] ${title}${human} — không còn trên máy chủ Zalo`,
        notice: false,
        media: { kind: "file", urls: uniq([str(c.href)]), filename: title || "zalo-file", size },
      };
    }
    case 6: {
      if (str(c.action) === "recommened.misscall" || str(c.action) === "recommened.calltime") {
        return { body: `📞 ${title || "Cuộc gọi"}`, notice: true };
      }
      const href = str(c.href);
      const label = title && title !== href ? title : str(params.mediaTitle) || desc;
      const body = lines(label && label !== href ? label : undefined, href) || "[Liên kết]";
      if (!/^https?:\/\//.test(href)) return { body, notice: false };
      // Zalo card fields: title is the page title (or the URL itself), description the summary
      const pageTitle = str(params.mediaTitle) || (title && title !== href ? title : "");
      const summary = desc && desc !== href && desc !== pageTitle ? desc : "";
      const thumb = str(c.thumb);
      return {
        body,
        notice: false,
        linkPreview: {
          url: href,
          ...(pageTitle ? { title: pageTitle } : {}),
          ...(summary ? { description: summary } : {}),
          ...(/^https?:\/\//.test(thumb) ? { imageUrl: thumb } : {}),
        },
      };
    }
    default: {
      // System rows (-1909 pins, 25 friend cards, 26 polls, 52 zinstant ...) and unknown types
      const text = title || fillTemplate(params) || desc || str(c.href);
      return { body: text || `[Tin nhắn Zalo loại ${row.msgType}]`, notice: true };
    }
  }
}

/** Export row → importable event; null when there is nothing to show. */
export function renderExportRow(row: ExportRow, threadType: "user" | "group", threadId: string): ImportEvent | null {
  if (!row.msgId || !row.sendDttm) return null;
  const { body, notice, media, linkPreview } = render(row);
  if (!body.trim()) return null;

  const sender: ImportSender =
    row.fromUid === "0"
      ? { kind: "owner" }
      : row.fromUid
        ? { kind: "ghost", uid: row.fromUid, name: row.dName || undefined }
        : threadType === "user"
          ? { kind: "ghost", uid: threadId } // DM system rows: attribute to the peer
          : { kind: "bot" };

  // quote.msg is the quoted text, or an object when the quoted message was media
  const quote: ImportQuote | undefined =
    row.quote?.msg || row.quote?.fromD
      ? {
          msgId: row.quote.globalMsgId != null ? String(row.quote.globalMsgId) : undefined,
          fromName: row.quote.fromD ?? "",
          text: (str(row.quote.msg) || "[đính kèm]").split("\n")[0]!,
        }
      : undefined;

  // @All mentions carry no uid — only person mentions become Matrix pills
  const mentions = (row.mentions ?? []).filter((x) => x.uid).map((x) => ({ uid: String(x.uid), pos: x.pos, len: x.len }));

  return {
    msgId: String(row.msgId),
    cliMsgId: row.cliMsgId != null ? String(row.cliMsgId) : undefined,
    timestamp: Number(row.sendDttm),
    sender,
    content: { msgtype: notice ? "m.notice" : "m.text", body },
    ...(media ? { media } : {}),
    ...(linkPreview ? { linkPreview } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(quote ? { quote } : {}),
    rawMsgType: String(row.msgType),
  };
}

/**
 * Zalo PC keeps a second local row for some of the owner's own messages: msgId with a
 * "_NNN" suffix, same cliMsgId + msgType as the real (server msgId) row. Importing both
 * duplicates the message; drop the shadow when its real row is present. Suffixed rows
 * without a real twin are the only copy of that message and are kept.
 */
export function dropShadowCopies(rows: ExportRow[]): ExportRow[] {
  const isShadow = (r: ExportRow) => /_\d+$/.test(String(r.msgId));
  const real = new Set(rows.filter((r) => !isShadow(r) && r.cliMsgId != null).map((r) => `${r.cliMsgId}|${r.msgType}`));
  return rows.filter((r) => !isShadow(r) || !real.has(`${r.cliMsgId}|${r.msgType}`));
}

/** Plain-text reply fallback for a quote whose target is not bridged. */
export function quoteFallback(quote: ImportQuote): string {
  return `> ${quote.fromName}: ${quote.text}\n\n`;
}
