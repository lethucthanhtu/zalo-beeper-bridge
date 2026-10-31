// Raw zca-js message → ZaloMessage. All zca-js payload quirks live here.
import { toMatrixWaveform, type MediaDescriptor } from '../bridge/media-content.ts';
import type { RawZaloMessage, ZaloContent, ZaloMessage } from './types.ts';
import { CALL_ACTIONS, describeCall } from './call-message.ts';

/** Object-form message content (media, cards, rich text); every field is optional. */
type AttachmentContent = {
  href?: string;
  thumb?: string;
  title?: string;
  description?: string;
  /** JSON string (dimensions, sizes, mediaTitle, ...) — read with parseParams */
  params?: string;
  /** card kind: 'rtf', 'recommened.link', 'recommened.user', call actions, ... */
  action?: string;
};

type StickerContent = {
  id?: number;
  catId?: number;
};

/**
 * Maps a raw Zalo `content` field to the bridge's content model, dispatching on msgType:
 * text, photo, sticker, downloadable media, then link/card types rendered as text
 * with a link preview. Anything else becomes `unsupported` (the bridge posts a notice).
 *
 * @param msgType raw Zalo msgType (e.g. 'webchat', 'chat.photo')
 * @param content raw content: a string for text, an object for everything else
 */
function normalizeContent(msgType: string, content: unknown): ZaloContent {
  if (msgType === 'webchat' && typeof content === 'string') return { kind: 'text', text: content };
  // "Delete for me" from another device: content lists the deleted messages. Live shape:
  // { type, actionType, uidFrom, uidTo, clientDelMsgId, globalDelMsgId, destId }
  // (globalMsgId is what zca-js deleteMessage sends — kept as a fallback)
  if (msgType === 'chat.delete') {
    const items: unknown[] = Array.isArray(content) ? content : [];
    const msgIds = items
      .map((item) => {
        const deleted = (item ?? {}) as { globalDelMsgId?: unknown; globalMsgId?: unknown };
        return deleted.globalDelMsgId ?? deleted.globalMsgId;
      })
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
      .map(String);
    return { kind: 'delete', msgIds };
  }
  if (typeof content !== 'object' || content === null) return { kind: 'unsupported', msgType };
  const card = content as AttachmentContent;
  // Rich text (bold/colour, or text Zalo formats itself, e.g. many @mentions): the plain
  // text is in the title. shortcut: styles in params are dropped, map them to HTML if wanted
  if (msgType === 'webchat' && card.action === 'rtf' && typeof card.title === 'string') {
    return { kind: 'text', text: card.title };
  }
  if (msgType === 'chat.photo' && card.href) {
    const params = parseParams(card.params);
    return {
      kind: 'photo',
      url: card.href,
      thumbUrl: card.thumb,
      width: positive(params.width),
      height: positive(params.height),
      // Zalo puts the photo caption in the title; a bare file name is not a caption
      caption: [card.title, card.description].find((text) => text && !FILE_NAME.test(text)) || undefined,
    };
  }
  if (msgType === 'chat.sticker') {
    const sticker = content as StickerContent;
    if (typeof sticker.id === 'number' && typeof sticker.catId === 'number') {
      return { kind: 'sticker', id: sticker.id, catId: sticker.catId };
    }
  }
  // Call log bubbles are link cards without an href — render them as a call line
  if (card.action && CALL_ACTIONS.has(card.action)) {
    return { kind: 'notice', text: describeCall(card.action, card.params) };
  }
  const media = normalizeMedia(msgType, card);
  if (media) return { kind: 'media', media };
  if (msgType === 'chat.location.new') return normalizeLocation(card);
  // Contact card ("danh thiếp"; Zalo's own typo): the href is a placeholder (zaloapp.com)
  if (card.action === 'recommened.user') return normalizeContactCard(card);
  // Web cards (OA / mini-app / payment cards) with no href: render their label as text;
  // with an href they are link cards like the rest
  if (WEB_CONTENT_TYPES.has(msgType) && !card.href) {
    const text = [card.title, card.description].filter(Boolean).join('\n');
    return { kind: 'text', text: text || '[Zalo web card — open Zalo to view]' };
  }
  if (card.href) return normalizeLinkCard({ ...card, href: card.href });
  return { kind: 'unsupported', msgType };
}

/**
 * Link/card types (chat.recommended, chat.link, chat.ecard, ...) → a text line plus a
 * Beeper link preview. In link messages the title is the text the sender typed (with the
 * link as typed, e.g. a short maps.app.goo.gl link) and href the resolved URL: show the
 * typed text, as Beeper does, and preview the typed URL. mediaTitle is the page title.
 */
function normalizeLinkCard(card: AttachmentContent & { href: string }): ZaloContent {
  const params = parseParams(card.params);
  const typedUrl = card.title?.match(/https?:\/\/\S+/)?.[0];
  const label = card.title || card.description || '';
  const text = typedUrl ? card.title! : label && !label.includes(card.href) ? `${label}\n${card.href}` : card.href;
  const previewUrl = typedUrl ?? card.href;
  /** Zalo repeats the URL as title/description when the page has none — not preview text. */
  const isUrl = (value: string) => value === card.href || value === previewUrl;
  const title =
    (typeof params.mediaTitle === 'string' && !isUrl(params.mediaTitle) && params.mediaTitle) ||
    (card.title && !typedUrl && !isUrl(card.title) ? card.title : '');
  const description =
    card.description && !isUrl(card.description) && card.description !== title ? card.description : '';
  if (!isHttpUrl(card.href)) return { kind: 'text', text };
  return {
    kind: 'text',
    text,
    linkPreview: {
      url: previewUrl,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(card.thumb && isHttpUrl(card.thumb) ? { imageUrl: card.thumb } : {}),
    },
  };
}

/** True for an http(s) URL (Zalo also uses placeholders like "www.zaloapp.com"). */
const isHttpUrl = (url: string) => /^https?:\/\//.test(url);

/**
 * Parses the JSON-encoded `params` string Zalo attaches to media/card content.
 *
 * @returns the parsed object, or {} when absent, malformed or not an object
 */
function parseParams(params: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(params ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {}; // params malformed — all fields are optional
  }
}

/** chat.webcontent (52) and its v2 variant (61) — type codes from Za-go's msgType table */
const WEB_CONTENT_TYPES = new Set(['chat.webcontent', 'chat.webcontent.v2']);

/** A photo title that is just the sent file's name (e.g. "IMG_0012.JPG") is not a caption */
const FILE_NAME = /^[^\s/\\]+\.(jpe?g|png|gif|webp|heic|heif|jxl|bmp)$/i;

/**
 * Contact card → its QR code as an image captioned with name, phone and a zalo.me link
 * (the link opens the Zalo app on phones); text with an avatar preview when there is no
 * QR. Live shape: title = name, description = JSON {phone?, qrCodeUrl?}, params = the
 * contact's uid, thumb = avatar. phone is absent when the contact hides it.
 */
function normalizeContactCard(card: AttachmentContent): ZaloContent {
  const details = parseParams(card.description);
  const phone = typeof details.phone === 'string' && /^\+?\d{6,15}$/.test(details.phone) ? details.phone : '';
  const qrUrl = typeof details.qrCodeUrl === 'string' && /^https:\/\//.test(details.qrCodeUrl) ? details.qrCodeUrl : '';
  const name = card.title || 'Zalo contact';
  const url = phone ? `https://zalo.me/${phone}` : '';
  const text = [`👤 Danh thiếp Zalo: ${name}`, phone && `📞 ${phone}`, url && `Mở trong Zalo: ${url}`]
    .filter(Boolean)
    .join('\n');
  if (qrUrl) return { kind: 'photo', url: qrUrl, caption: url ? text : `${text}\n(quét QR bằng Zalo để mở)` };
  if (!url) return { kind: 'text', text };
  const imageUrl = card.thumb && /^https:\/\//.test(card.thumb) ? card.thumb : undefined;
  return { kind: 'text', text, linkPreview: { url, title: name, ...(imageUrl ? { imageUrl } : {}) } };
}

/**
 * Shared location (chat.location.new) → a native Matrix location (map preview; tapping
 * opens the device's default maps app), with "📍 place / address / Google Maps link" as
 * the text fallback. Without coordinates it is text only. Live shape: title = place
 * name ('' for "my location"), description = address, params = JSON {isUserLocation,
 * srcId, latitude, longitude}; lat/lng spellings are tried too.
 */
function normalizeLocation(location: AttachmentContent): ZaloContent {
  const fields: Record<string, unknown> = { ...parseParams(location.params), ...(location as Record<string, unknown>) };
  /** First key holding a finite number (numeric strings accepted). */
  const pick = (...keys: string[]) =>
    keys.map((key) => Number(fields[key])).find((value) => Number.isFinite(value) && value !== 0);
  const lat = pick('lat', 'latitude');
  const lng = pick('lng', 'lon', 'long', 'longitude');
  const hasCoordinates = lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const link = hasCoordinates
    ? `https://www.google.com/maps?q=${lat},${lng}`
    : location.href && /^https?:\/\//.test(location.href)
      ? location.href
      : '';
  const label = location.title || location.description || 'Vị trí được chia sẻ (shared location)';
  const details = location.description && location.description !== label ? `\n${location.description}` : '';
  const text = `📍 ${label}${details}${link ? `\n${link}` : ''}`;
  return hasCoordinates ? { kind: 'location', latitude: lat, longitude: lng, label, text } : { kind: 'text', text };
}

/**
 * Coerces a loosely-typed Zalo numeric field (number or numeric string) to a number.
 *
 * @returns the number when it is > 0, otherwise undefined (missing / zero / garbage)
 */
const positive = (value: unknown): number | undefined => (Number(value) > 0 ? Number(value) : undefined);

/**
 * Video / file / voice / GIF / doodle attachments → a downloadable media descriptor.
 *
 * @param msgType raw Zalo msgType selecting the media kind
 * @param attachment raw attachment content (href + JSON params with size/dimensions/duration)
 * @returns null when there is no href or the msgType is not a known media type
 */
function normalizeMedia(msgType: string, attachment: AttachmentContent): MediaDescriptor | null {
  if (!attachment.href) return null;
  const params = parseParams(attachment.params);
  switch (msgType) {
    case 'chat.video.msg':
      return {
        kind: 'video',
        urls: [attachment.href],
        filename: 'zalo-video.mp4',
        caption: attachment.title || undefined,
        width: positive(params.video_width),
        height: positive(params.video_height),
        durationMs: positive(params.duration),
        size: positive(params.fileSize),
      };
    case 'share.file':
      return {
        kind: 'file',
        urls: [attachment.href],
        filename: attachment.title || 'zalo-file',
        size: positive(params.fileSize),
      };
    case 'chat.voice': {
      const waveform = toMatrixWaveform(params.waveformSamples);
      return {
        kind: 'audio',
        urls: [attachment.href],
        filename: 'Voice message.m4a',
        durationMs: positive(params.duration),
        size: positive(params.fileSize),
        ...(waveform ? { waveform } : {}),
      };
    }
    case 'chat.gif':
      return {
        kind: 'image',
        urls: [attachment.href, ...(attachment.thumb ? [attachment.thumb] : [])],
        filename: 'zalo.gif',
        width: positive(params.width),
        height: positive(params.height),
      };
    case 'chat.doodle':
      return {
        kind: 'image',
        urls: [attachment.href],
        filename: 'zalo-doodle.png',
        width: positive(params.width),
        height: positive(params.height),
      };
    default:
      return null;
  }
}

/**
 * Converts a raw zca-js listener/history message into the bridge's ZaloMessage:
 * stringifies ids, derives the thread type, normalizes content, and keeps the raw
 * fields needed to quote the message later.
 *
 * @returns null for events that carry no bridgeable message (missing ids)
 */
export function normalizeZaloMessage(raw: RawZaloMessage): ZaloMessage | null {
  const messageData = raw.data;
  // uidFrom is the Phase 4 puppet key — never let "undefined" become a ghost id
  if (!messageData?.msgId || !raw.threadId || !messageData.uidFrom) return null;
  // E2EE 1-1 chats (Signal protocol): the content is ciphertext this web session cannot
  // decrypt — never post it as text, surface a notice instead
  const content: ZaloContent = messageData.e2ee
    ? { kind: 'unsupported', msgType: 'e2ee' }
    : normalizeContent(messageData.msgType, messageData.content);
  return {
    msgId: String(messageData.msgId),
    threadId: raw.threadId,
    threadType: raw.type === 1 ? 'group' : 'user',
    senderId: String(messageData.uidFrom),
    senderName: messageData.dName || undefined,
    timestamp: Number(messageData.ts) || Date.now(),
    isSelf: raw.isSelf === true,
    content,
    cliMsgId: messageData.cliMsgId != null ? String(messageData.cliMsgId) : undefined,
    rawMsgType: messageData.msgType,
    // Any message can be quoted later (Matrix reply → Zalo quote): keep the raw content
    quotable: {
      content: messageData.content,
      msgType: messageData.msgType,
      propertyExt: messageData.propertyExt ?? null,
      uidFrom: String(messageData.uidFrom),
      msgId: String(messageData.msgId),
      cliMsgId: String(messageData.cliMsgId ?? ''),
      ts: String(messageData.ts),
      ttl: messageData.ttl ?? 0,
    },
    // Zalo quote → the quoted message's global msgId (Matrix reply mapping)
    replyToMsgId: messageData.quote?.globalMsgId != null ? String(messageData.quote.globalMsgId) : undefined,
    mentions: messageData.mentions?.map((mention) => ({
      uid: String(mention.uid),
      pos: mention.pos,
      len: mention.len,
    })),
  };
}
