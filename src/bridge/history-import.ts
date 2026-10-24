// Zalo PC history export (zexport: out/<threadKey>.ndjson rows from the app's own
// IndexedDB) → Matrix message content for Beeper batch-send backfill.
// Pure conversion only — the importer CLI (src/tools/import-zalo-export.ts) does the IO.
// Media rows carry an ImportMedia descriptor (candidate CDN URLs + metadata) so the
// importer can post them like the live bridge does (m.image / m.sticker / m.video /
// m.file / m.audio); `content` is the readable text used when no copy is reachable
// (Zalo CDN links expire ~14 days after sending).
import { CALL_ACTIONS, describeCall } from '../zalo/call-message.ts';
import type { ZaloMention } from '../zalo/types.ts';
import { toMatrixWaveform, type LinkPreview, type MediaDescriptor } from './media-content.ts';

/** One exported Zalo PC message row (subset of fields the exporter keeps). */
export type ExportRow = {
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
};

/** Who posts an imported message: the owner (double puppet), a Zalo ghost, or the bridge bot. */
export type ImportSender = { kind: 'owner' } | { kind: 'ghost'; uid: string; name?: string } | { kind: 'bot' };

/** A media attachment the importer tries to fetch (local backup copy first, then urls). */
export type ImportMedia = MediaDescriptor;

/** A Zalo quote: a Matrix reply when its target is bridged, otherwise a plain-text fallback. */
export type ImportQuote = {
  /** global msgId of the quoted message — resolvable to a Matrix reply when bridged */
  msgId?: string;
  fromName: string;
  /** first line of the quoted text, or "[đính kèm]" for quoted media */
  text: string;
};

/** One export row rendered for batch-send: text content plus optional media / preview / mentions / quote. */
export type ImportEvent = {
  msgId: string;
  cliMsgId?: string;
  timestamp: number;
  sender: ImportSender;
  /** Matrix m.room.message content: the text itself, or the fallback when media is unreachable */
  content: { msgtype: 'm.text' | 'm.notice'; body: string };
  media?: ImportMedia;
  linkPreview?: LinkPreview;
  mentions?: ZaloMention[];
  quote?: ImportQuote;
  rawMsgType: string;
};

/**
 * Splits an export thread key into the Zalo thread id and type.
 * Thread key in the export: "g<id>" for groups, bare uid for DMs.
 */
export function parseThreadKey(key: string): { threadId: string; threadType: 'user' | 'group' } {
  return key.startsWith('g') ? { threadId: key.slice(1), threadType: 'group' } : { threadId: key, threadType: 'user' };
}

/** Loosely typed JSON object as found in exported message payloads. */
type JsonObject = Record<string, unknown>;

/** Exported fields mix strings and numbers: a string as-is, a number stringified, anything else ''. */
const asText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
/** Positive numeric value (number or numeric string); undefined for 0, negatives and non-numbers. */
const positiveNumber = (value: unknown): number | undefined => (Number(value) > 0 ? Number(value) : undefined);

/**
 * Zalo stores `params` (and a template's `msg`) either as an object or as a JSON string;
 * normalises both to an object. Returns {} when absent or unparsable (never throws).
 */
function parseJson(value: unknown): JsonObject {
  if (value && typeof value === 'object') return value as JsonObject;
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as JsonObject) : {};
  } catch {
    return {};
  }
}

/** Joins the non-blank parts with newlines (undefined and whitespace-only parts are skipped). */
const joinLines = (...parts: Array<string | undefined>): string =>
  parts.filter((part) => part && part.trim()).join('\n');
/** Order-preserving de-duplication of the http(s) URLs; empty and non-http entries are dropped. */
const uniqueHttpUrls = (urls: string[]): string[] => [...new Set(urls.filter((url) => /^https?:\/\//.test(url)))];

/** Human-readable size ("367 KB", "1.5 MB") for the file fallback text; '' when unknown. */
function formatBytes(byteCount: number): string {
  if (!Number.isFinite(byteCount) || byteCount <= 0) return '';
  if (byteCount < 1024 * 1024) return `${Math.max(1, Math.round(byteCount / 1024))} KB`;
  return `${(byteCount / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Rewrites a JPEG XL photo URL to its JPEG twin; other URLs pass through unchanged.
 * New Zalo photo URLs serve JPEG XL (no Matrix client renders it); the /jpg/ twin is a JPEG.
 */
export function jxlToJpgUrl(url: string): string {
  return url.replace('/jxl/', '/jpg/').replace(/\.jxl(\?jxlstatus=1)?$/, '.jpg');
}

/** Public sticker image (PNG, or GIF for legacy emoticons) — no Zalo session needed. */
export const stickerImageUrl = (id: number): string =>
  `https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=${id}&size=240`;

/**
 * System-message templates ("%1$s pinned message %2$s") filled from highlight names.
 * Prefers the Vietnamese template; without highlights the row's dName / question fill in.
 *
 * @param params the row's parsed `params` object
 * @returns the filled text, or '' when the row carries no template
 */
function fillTemplate(params: JsonObject): string {
  const template = parseJson(params.msg);
  const templateText = asText(template.vi) || asText(template.en);
  if (!templateText) return '';
  const highlights = Array.isArray(params.highLightsV2)
    ? (params.highLightsV2 as JsonObject[]).map((highlight) => asText(highlight.dpn))
    : [];
  const fills = highlights.length ? highlights : [asText(params.dName), asText(params.question)];
  return templateText.replace(/%(\d)\$s/g, (_, position: string) => fills[Number(position) - 1] ?? '');
}

/** Result of rendering one export row: the readable text plus the optional rich parts. */
type Rendered = {
  body: string;
  notice: boolean;
  media?: ImportMedia;
  linkPreview?: LinkPreview;
};

/**
 * Renders the message body; `notice` marks system/placeholder lines.
 * Dispatches on the Zalo PC msgType: media types also get an ImportMedia descriptor (their
 * body is the Vietnamese "no longer on Zalo's servers" fallback), link cards a LinkPreview.
 * An empty body means there is nothing to show.
 */
function render(row: ExportRow): Rendered {
  const message = row.message;
  if (typeof message === 'string') {
    // Text, plus string placeholders for recalled (20) / deleted (-27) / system (-4) rows
    return { body: message, notice: row.msgType !== 1 };
  }
  if (Array.isArray(message)) {
    // msgType 21: Zalo OA / ZNS cards — list title + link per card
    const cards = (message as JsonObject[]).map((card) =>
      joinLines(asText(card.title), asText(card.description), asText(card.href)),
    );
    return { body: joinLines('[Thẻ Zalo]', ...cards), notice: true };
  }
  const attachment = (message ?? {}) as JsonObject;
  const params = parseJson(attachment.params);
  const title = asText(attachment.title);
  const desc = asText(attachment.description) || asText(attachment.desc);
  switch (row.msgType) {
    case 1:
      // rich-text (action "rtf"): the plain text is in the title
      return { body: title || desc, notice: false };
    case 2: {
      const caption = title || desc || undefined;
      const width = positiveNumber(params.width);
      const height = positiveNumber(params.height);
      const urls = uniqueHttpUrls(
        [
          asText(attachment.hdUrl),
          asText(params.hd),
          asText(attachment.oriUrl),
          asText(params.rawUrl),
          asText(attachment.normalUrl),
        ].map(jxlToJpgUrl),
      );
      const dims = width && height ? ` ${width}×${height}` : '';
      return {
        body: joinLines(`📷 [Ảnh${dims} — không còn trên máy chủ Zalo]`, caption),
        notice: false,
        media: { kind: 'image', urls, caption, width, height, size: positiveNumber(params.fileSize) },
      };
    }
    case 3: {
      const durationMs = positiveNumber(params.duration);
      const waveform = toMatrixWaveform(params.waveformSamples);
      const secs = durationMs ? ` ${Math.round(durationMs / 1000)}s` : '';
      return {
        body: `🎤 [Tin nhắn thoại${secs} — không còn trên máy chủ Zalo]`,
        notice: false,
        media: {
          kind: 'audio',
          urls: uniqueHttpUrls([asText(params.m4a), asText(attachment.href)]),
          filename: 'Voice message.m4a',
          durationMs,
          size: positiveNumber(params.fileSize),
          ...(waveform ? { waveform } : {}),
        },
      };
    }
    case 4: {
      const id = Number(attachment.id);
      return Number.isFinite(id) && id > 0
        ? { body: '[Sticker]', notice: false, media: { kind: 'sticker', urls: [stickerImageUrl(id)], stickerId: id } }
        : { body: '[Sticker]', notice: false };
    }
    case 7:
      return {
        body: '[GIF — không còn trên máy chủ Zalo]',
        notice: false,
        media: {
          kind: 'image',
          urls: uniqueHttpUrls([asText(attachment.oriUrl), asText(attachment.normalUrl), asText(params.hd)]),
          filename: 'zalo.gif',
          width: positiveNumber(params.width),
          height: positiveNumber(params.height),
          size: positiveNumber(params.fileSize),
        },
      };
    case 17: {
      const map =
        attachment.lat && attachment.lo
          ? `https://maps.google.com/?q=${asText(attachment.lat)},${asText(attachment.lo)}`
          : '';
      return { body: joinLines('📍 [Vị trí]', desc || title, map), notice: false };
    }
    case 18: {
      const durationMs = positiveNumber(attachment.duration) ?? positiveNumber(params.duration);
      const secs = durationMs ? ` ${Math.round(durationMs / 1000)}s` : '';
      return {
        body: joinLines(`🎬 [Video${secs} — không còn trên máy chủ Zalo]`, title),
        notice: false,
        media: {
          kind: 'video',
          urls: uniqueHttpUrls([asText(attachment.oriUrl), asText(attachment.href)]),
          filename: 'zalo-video.mp4',
          caption: title || undefined,
          width: positiveNumber(params.video_width),
          height: positiveNumber(params.video_height),
          durationMs,
          size: positiveNumber(params.fileSize),
        },
      };
    }
    case 19: {
      const size = positiveNumber(params.fileSize);
      const human = size ? ` (${formatBytes(size)})` : '';
      return {
        body: `📎 [Tệp] ${title}${human} — không còn trên máy chủ Zalo`,
        notice: false,
        media: { kind: 'file', urls: uniqueHttpUrls([asText(attachment.href)]), filename: title || 'zalo-file', size },
      };
    }
    case 6: {
      if (CALL_ACTIONS.has(asText(attachment.action))) {
        // the title is the literal "sendBubbleMessage" — the call details are in params
        return { body: describeCall(asText(attachment.action), attachment.params), notice: true };
      }
      const href = asText(attachment.href);
      const label = title && title !== href ? title : asText(params.mediaTitle) || desc;
      const body = joinLines(label && label !== href ? label : undefined, href) || '[Liên kết]';
      if (!/^https?:\/\//.test(href)) return { body, notice: false };
      // Zalo card fields: title is the page title (or the URL itself), description the summary
      const pageTitle = asText(params.mediaTitle) || (title && title !== href ? title : '');
      const summary = desc && desc !== href && desc !== pageTitle ? desc : '';
      const thumb = asText(attachment.thumb);
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
      const text = title || fillTemplate(params) || desc || asText(attachment.href);
      return { body: text || `[Tin nhắn Zalo loại ${row.msgType}]`, notice: true };
    }
  }
}

/**
 * Export row → importable event; null when there is nothing to show (no msgId, no send
 * time, or an empty rendered body). Also resolves the sender, the quote and the mentions.
 *
 * @param threadType decides who sender-less system rows are attributed to (peer in DMs, bot in groups)
 * @param threadId the DM peer's uid, used as the sender of DM system rows
 */
export function renderExportRow(row: ExportRow, threadType: 'user' | 'group', threadId: string): ImportEvent | null {
  if (!row.msgId || !row.sendDttm) return null;
  const { body, notice, media, linkPreview } = render(row);
  if (!body.trim()) return null;

  const sender: ImportSender =
    row.fromUid === '0'
      ? { kind: 'owner' }
      : row.fromUid
        ? { kind: 'ghost', uid: row.fromUid, name: row.dName || undefined }
        : threadType === 'user'
          ? { kind: 'ghost', uid: threadId } // DM system rows: attribute to the peer
          : { kind: 'bot' };

  // quote.msg is the quoted text, or an object when the quoted message was media
  const quote: ImportQuote | undefined =
    row.quote?.msg || row.quote?.fromD
      ? {
          msgId: row.quote.globalMsgId != null ? String(row.quote.globalMsgId) : undefined,
          fromName: row.quote.fromD ?? '',
          text: (asText(row.quote.msg) || '[đính kèm]').split('\n')[0]!,
        }
      : undefined;

  // @All mentions carry no uid — only person mentions become Matrix pills
  const mentions = (row.mentions ?? [])
    .filter((mention) => mention.uid)
    .map((mention) => ({ uid: String(mention.uid), pos: mention.pos, len: mention.len }));

  return {
    msgId: String(row.msgId),
    cliMsgId: row.cliMsgId != null ? String(row.cliMsgId) : undefined,
    timestamp: Number(row.sendDttm),
    sender,
    content: { msgtype: notice ? 'm.notice' : 'm.text', body },
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
 *
 * @returns the rows without redundant shadows, in their original order
 */
export function dropShadowCopies(rows: ExportRow[]): ExportRow[] {
  /** A shadow row's msgId ends in "_<digits>". */
  const isShadow = (row: ExportRow) => /_\d+$/.test(String(row.msgId));
  const realRowKeys = new Set(
    rows.filter((row) => !isShadow(row) && row.cliMsgId != null).map((row) => `${row.cliMsgId}|${row.msgType}`),
  );
  return rows.filter((row) => !isShadow(row) || !realRowKeys.has(`${row.cliMsgId}|${row.msgType}`));
}

/** Plain-text reply fallback for a quote whose target is not bridged (prefixed to the body). */
export function quoteFallback(quote: ImportQuote): string {
  return `> ${quote.fromName}: ${quote.text}\n\n`;
}
