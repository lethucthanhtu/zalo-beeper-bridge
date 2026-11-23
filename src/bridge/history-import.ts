// Zalo PC history export (zexport: out/<threadKey>.ndjson rows from the app's own
// IndexedDB) → Matrix message content for Beeper batch-send backfill.
// Pure conversion only — the importer CLI (src/tools/import-zalo-export.ts) does the IO.
// Media rows carry an ImportMedia descriptor (candidate CDN URLs + metadata) so the
// importer can post them like the live bridge does (m.image / m.sticker / m.video /
// m.file / m.audio); `content` is the readable text used when no copy is reachable
// (Zalo CDN links expire ~14 days after sending).
import { CALL_ACTIONS, callActionMessage, describeCall, type BeeperActionMessage } from '../zalo/call-message.ts';
import type { ZaloMention } from '../zalo/types.ts';
import { isHttpUrl, joinLines, parseParams, positiveNumber } from '../util.ts';
import { ZALO_EMOTICON_API } from './media-fetch.ts';
import { mediaGoneBody } from './zalo-render.ts';
import { toMatrixWaveform, type LinkPreview, type MediaDescriptor } from '../media-descriptor.ts';

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
  content: { msgtype: 'm.text' | 'm.notice'; body: string; 'com.beeper.action_message'?: BeeperActionMessage };
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

/** One reacted message of a `<key>.reactions.json` export sidecar, flattened per reaction. */
export type ExportReactionEntry = {
  /** global Zalo msgId of the reacted message ('' when unknown) */
  msgId: string;
  /** client msgId of the reacted message ('' when unknown) */
  cliMsgId: string;
  /** one item per (reactor, reaction type); reactor "0" is the account owner */
  reactions: Array<{ reactor: string; rType: string }>;
};

/**
 * Parses a `<key>.reactions.json` sidecar written by export-cdp.mjs: an array of
 * `{ rMsgId, rCli, reactions: { reactorUid: { rType: count } } }`. Reaction types with a
 * count of 0 or less are dropped, as are entries with no message id or no reactions.
 *
 * @throws when the text is not valid JSON or not an array
 */
export function parseReactionSidecar(text: string): ExportReactionEntry[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error('reactions sidecar is not an array');
  const entries: ExportReactionEntry[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    // Zalo uses 0 for an id it does not have
    const idOf = (value: unknown) => (asText(value) === '0' ? '' : asText(value));
    const msgId = idOf(item?.rMsgId);
    const cliMsgId = idOf(item?.rCli);
    const byReactor = item?.reactions;
    if ((!msgId && !cliMsgId) || !byReactor || typeof byReactor !== 'object') continue;
    const reactions: ExportReactionEntry['reactions'] = [];
    for (const [reactor, types] of Object.entries(byReactor as Record<string, unknown>)) {
      if (!types || typeof types !== 'object') continue;
      for (const [rType, count] of Object.entries(types as Record<string, unknown>))
        if (typeof count !== 'number' || count > 0) reactions.push({ reactor, rType });
    }
    if (reactions.length) entries.push({ msgId, cliMsgId, reactions });
  }
  return entries;
}

/** Loosely typed JSON object as found in exported message payloads. */
type JsonObject = Record<string, unknown>;

/** Exported fields mix strings and numbers: a string as-is, a number stringified, anything else ''. */
const asText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/**
 * Zalo stores `params` (and a template's `msg`) either as an object or as a JSON string;
 * normalises both to an object. Returns {} when absent or unparsable (never throws).
 */
const parseJson = (value: unknown): JsonObject => parseParams(value) ?? {};

/** Order-preserving de-duplication of the http(s) URLs; empty and non-http entries are dropped. */
const uniqueHttpUrls = (urls: string[]): string[] => [...new Set(urls.filter(isHttpUrl))];

/**
 * Rewrites a JPEG XL photo URL to its JPEG twin; other URLs pass through unchanged.
 * New Zalo photo URLs serve JPEG XL (no Matrix client renders it); the /jpg/ twin is a JPEG.
 */
export function jxlToJpgUrl(url: string): string {
  return url.replace('/jxl/', '/jpg/').replace(/\.jxl(\?jxlstatus=1)?$/, '.jpg');
}

/** Public sticker image (PNG, or GIF for legacy emoticons) — no Zalo session needed. */
export const stickerImageUrl = (id: number): string => `${ZALO_EMOTICON_API}/sticker/webpc?eid=${id}&size=240`;

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

/**
 * Answer texts of an exported poll row. The export has no documented poll shape, so this
 * reads the usual places (attachment / params, `options` or `pollOptions`, a JSON array or
 * string, entries as strings or objects with content / text / name / title).
 *
 * @returns the non-empty option texts in order, [] when none are found
 */
function pollOptionTexts(attachment: JsonObject, params: JsonObject): string[] {
  for (const holder of [attachment, params]) {
    for (const key of ['options', 'pollOptions']) {
      let list: unknown = holder[key];
      if (typeof list === 'string') {
        try {
          list = JSON.parse(list);
        } catch {
          continue;
        }
      }
      if (!Array.isArray(list)) continue;
      const texts = list
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object'
              ? asText((entry as JsonObject).content) ||
                asText((entry as JsonObject).text) ||
                asText((entry as JsonObject).name) ||
                asText((entry as JsonObject).title)
              : '',
        )
        .filter((text) => text.trim());
      if (texts.length) return texts;
    }
  }
  return [];
}

/** Result of rendering one export row: the readable text plus the optional rich parts. */
type Rendered = {
  body: string;
  notice: boolean;
  /** call log bubble: Beeper call tile payload */
  action?: BeeperActionMessage;
  media?: ImportMedia;
  linkPreview?: LinkPreview;
};

/**
 * Zalo PC msgTypes that are system events, not something a person wrote: -4 (group joins,
 * leaves, renames) and -1909 (pins). They carry the acting member as fromUid, but showing
 * them as that person's message is the bug, so the importer posts them as the bot.
 */
const SYSTEM_MSG_TYPES = new Set([-4, -1909]);

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
      const media: MediaDescriptor = {
        kind: 'image',
        urls,
        caption,
        width,
        height,
        size: positiveNumber(params.fileSize),
      };
      return { body: mediaGoneBody(media), notice: false, media };
    }
    case 3: {
      const durationMs = positiveNumber(params.duration);
      const waveform = toMatrixWaveform(params.waveformSamples);
      const media: MediaDescriptor = {
        kind: 'audio',
        urls: uniqueHttpUrls([asText(params.m4a), asText(attachment.href)]),
        filename: 'Voice message.m4a',
        durationMs,
        size: positiveNumber(params.fileSize),
        ...(waveform ? { waveform } : {}),
      };
      return { body: mediaGoneBody(media), notice: false, media };
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
      const media: MediaDescriptor = {
        kind: 'video',
        urls: uniqueHttpUrls([asText(attachment.oriUrl), asText(attachment.href)]),
        filename: 'zalo-video.mp4',
        caption: title || undefined,
        width: positiveNumber(params.video_width),
        height: positiveNumber(params.video_height),
        durationMs,
        size: positiveNumber(params.fileSize),
      };
      return { body: mediaGoneBody(media), notice: false, media };
    }
    case 19: {
      const media: MediaDescriptor = {
        kind: 'file',
        urls: uniqueHttpUrls([asText(attachment.href)]),
        filename: title || 'zalo-file',
        size: positiveNumber(params.fileSize),
      };
      return { body: mediaGoneBody(media), notice: false, media };
    }
    case 6: {
      if (CALL_ACTIONS.has(asText(attachment.action))) {
        // the title is the literal "sendBubbleMessage" — the call details are in params
        return {
          body: describeCall(asText(attachment.action), attachment.params, { icon: false }),
          notice: false,
          action: callActionMessage(attachment.params),
        };
      }
      const href = asText(attachment.href);
      const label = title && title !== href ? title : asText(params.mediaTitle) || desc;
      const body = joinLines(label && label !== href ? label : undefined, href) || '[Liên kết]';
      if (!isHttpUrl(href)) return { body, notice: false };
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
          ...(isHttpUrl(thumb) ? { imageUrl: thumb } : {}),
        },
      };
    }
    case 26: {
      // Poll: readable question + numbered options (native poll import is a phase-3 follow-up)
      const question = title || asText(params.question) || asText(attachment.question) || desc;
      const options = pollOptionTexts(attachment, params);
      if (question || options.length) {
        const lines = options.map((option, index) => `${index + 1}. ${option}`);
        return { body: joinLines(`📊 [Bình chọn] ${question}`.trimEnd(), ...lines), notice: true };
      }
      return { body: fillTemplate(params) || '[Bình chọn]', notice: true };
    }
    case 20:
    case -27:
      // Recalled / deleted rows that kept an object payload (usually the string placeholder):
      // the marker only, never the payload, which may still hold the removed message
      return { body: row.msgType === 20 ? '[Tin nhắn đã thu hồi]' : '[Tin nhắn đã xoá]', notice: true };
    default: {
      // System rows (-1909 pins, 25 friend cards, 52 zinstant ...) and unknown types
      const text = title || fillTemplate(params) || desc || asText(attachment.href);
      return { body: text || `[Tin nhắn Zalo loại ${row.msgType}]`, notice: true };
    }
  }
}

/**
 * Export row → importable event; null when there is nothing to show (no msgId, no send
 * time, or an empty rendered body). Also resolves the sender, the quote and the mentions.
 *
 * @param threadType decides who other sender-less rows are attributed to (peer in DMs, bot in groups);
 *   system rows (SYSTEM_MSG_TYPES) are always the bot's
 * @param threadId the DM peer's uid, used as the sender of sender-less DM rows
 */
export function renderExportRow(row: ExportRow, threadType: 'user' | 'group', threadId: string): ImportEvent | null {
  if (!row.msgId || !row.sendDttm) return null;
  const { body, notice, action, media, linkPreview } = render(row);
  if (!body.trim()) return null;

  const sender: ImportSender = SYSTEM_MSG_TYPES.has(Number(row.msgType))
    ? { kind: 'bot' } // a system line is the bridge's, whoever acted
    : row.fromUid === '0'
      ? { kind: 'owner' }
      : row.fromUid
        ? { kind: 'ghost', uid: row.fromUid, name: row.dName || undefined }
        : threadType === 'user'
          ? { kind: 'ghost', uid: threadId } // other sender-less DM rows: attribute to the peer
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
    content: {
      msgtype: notice ? 'm.notice' : 'm.text',
      body,
      ...(action ? { 'com.beeper.action_message': action } : {}),
    },
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
