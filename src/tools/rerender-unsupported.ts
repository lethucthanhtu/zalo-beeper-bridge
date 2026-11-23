// Re-renders a live "not supported" notice from the Zalo payload bridge.db kept for it, so a
// rebuild posts the message the current bridge would post instead of copying the old notice.
import type { ImportEvent } from '../bridge/history-import.ts';
import { stickerImageUrl } from '../bridge/history-import.ts';
import type { LinkPreview, MediaDescriptor } from '../media-descriptor.ts';
import { normalizeZaloMessage } from '../zalo/event-normalizer.ts';
import type { ZaloContent } from '../zalo/types.ts';
import { locationContent, mediaGoneBody, UNSUPPORTED_NOTICE_PREFIX } from '../bridge/zalo-render.ts';

/**
 * The Zalo msgType named by the bridge's "not supported" notice, or null when the content is not
 * that notice. The notice for an end-to-end encrypted Zalo message (🔒 …, or the older
 * "…: e2ee]") gives null: its stored payload is ciphertext and must never be rendered.
 */
export function unsupportedNoticeType(content: Record<string, unknown> | undefined): string | null {
  if (content?.msgtype !== 'm.notice' || typeof content.body !== 'string') return null;
  const body = content.body.trim();
  if (!body.startsWith(UNSUPPORTED_NOTICE_PREFIX) || !body.endsWith(']')) return null;
  const msgType = body.slice(UNSUPPORTED_NOTICE_PREFIX.length, -1).trim();
  return msgType && msgType !== 'e2ee' ? msgType : null;
}

/** Whether a Matrix message content is the bridge's "not supported" notice (not the 🔒 one). */
export const isUnsupportedNotice = (content: Record<string, unknown> | undefined): boolean =>
  unsupportedNoticeType(content) !== null;

/**
 * Whether a Matrix message content is the notice the live bridge posts when a photo or file
 * download failed (`[Zalo photo could not be bridged…]`). A rebuild with `--media-dir` re-renders
 * it from the stored payload, like the "not supported" notice.
 */
export function isFailedMediaNotice(content: Record<string, unknown> | undefined): boolean {
  if (content?.msgtype !== 'm.notice' || typeof content.body !== 'string') return false;
  return /^\[Zalo \w+ could not be bridged\b/m.test(content.body);
}

/** What a stored payload renders to today. */
export type Rerendered =
  | {
      /** goes through the importer's buildEvent (media upload, link preview, call tile) */
      via: 'import';
      /** ZaloContent kind, for stats */
      kind: ZaloContent['kind'];
      content: ImportEvent['content'];
      media?: MediaDescriptor;
      linkPreview?: LinkPreview;
      /** a system line: posted by the bridge bot, like the live bridge does */
      system: boolean;
    }
  | { via: 'event'; kind: 'location'; type: 'm.room.message'; content: Record<string, unknown> };

/**
 * Runs a message's stored Zalo payload (`message.quote_json`) through the current normalizer.
 *
 * @param quoteJson the stored payload: `{content, msgType, propertyExt, uidFrom, ts, …}`
 * @param msgId the message's Zalo id
 * @param noticeMsgType the msgType the old notice names ({@link unsupportedNoticeType}); the
 *   payload must be of that type, so a payload stored for some other event is never rendered
 * @returns the message as the bridge renders it today, or null when the payload is unreadable,
 *   of another type, still unsupported, or a delete/recall (then the old notice is kept)
 */
export function rerenderStored(
  quoteJson: string | null | undefined,
  msgId: string,
  noticeMsgType: string,
): Rerendered | null {
  if (!quoteJson) return null;
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(quoteJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!stored || typeof stored !== 'object' || stored.msgType !== noticeMsgType) return null;
  const msg = normalizeZaloMessage({
    type: 0,
    threadId: 't',
    isSelf: false,
    data: {
      msgId,
      msgType: noticeMsgType,
      uidFrom: typeof stored.uidFrom === 'string' && stored.uidFrom ? stored.uidFrom : 'u',
      ts: typeof stored.ts === 'string' || typeof stored.ts === 'number' ? stored.ts : 0,
      content: stored.content,
      ...(stored.propertyExt ? { propertyExt: stored.propertyExt } : {}),
    },
  });
  if (!msg) return null;
  const c = msg.content;
  switch (c.kind) {
    case 'text':
      return {
        via: 'import',
        kind: c.kind,
        content: { msgtype: 'm.text', body: c.text },
        ...(c.linkPreview ? { linkPreview: c.linkPreview } : {}),
        system: false,
      };
    case 'call':
      return {
        via: 'import',
        kind: c.kind,
        content: { msgtype: 'm.text', body: c.text, 'com.beeper.action_message': c.action },
        system: false,
      };
    case 'notice':
      return { via: 'import', kind: c.kind, content: { msgtype: 'm.notice', body: c.text }, system: true };
    case 'photo': {
      const media: MediaDescriptor = {
        kind: 'image',
        urls: [...new Set([c.url, ...(c.fallbackUrls ?? []), ...(c.thumbUrl ? [c.thumbUrl] : [])])],
        ...(c.width ? { width: c.width } : {}),
        ...(c.height ? { height: c.height } : {}),
        ...(c.caption ? { caption: c.caption } : {}),
      };
      return {
        via: 'import',
        kind: c.kind,
        content: { msgtype: 'm.text', body: mediaGoneBody(media) },
        media,
        system: false,
      };
    }
    case 'sticker': {
      const media: MediaDescriptor = { kind: 'sticker', urls: [stickerImageUrl(c.id)], stickerId: c.id };
      return { via: 'import', kind: c.kind, content: { msgtype: 'm.text', body: '[Sticker]' }, media, system: false };
    }
    case 'media':
      return {
        via: 'import',
        kind: c.kind,
        content: { msgtype: 'm.text', body: mediaGoneBody(c.media) },
        media: c.media,
        system: false,
      };
    case 'location':
      return { via: 'event', kind: c.kind, type: 'm.room.message', content: locationContent(c) };
    case 'unsupported':
    case 'delete':
    case 'recall':
      return null;
  }
}

/**
 * The carried messages whose event is still the "not supported" notice although their stored
 * payload renders today (a rebuild re-renders them). Reads an event only when its payload
 * renders, so text-only rooms cost no reads.
 *
 * @param rows the messages mapped to the room (msgType as stored by the bridge)
 * @param quoteOf the stored payload of an event ({@link rerenderStored})
 * @param readContent the decrypted content of an event, undefined when unreadable
 * @returns the msgIds, in row order
 */
export async function findStillUnsupported(
  rows: ReadonlyArray<{ msgId: string; eventId: string | null; msgType: string | null }>,
  quoteOf: (eventId: string) => string | null,
  readContent: (eventId: string) => Promise<Record<string, unknown> | undefined>,
): Promise<string[]> {
  const found: string[] = [];
  for (const { msgId, eventId, msgType } of rows) {
    if (!eventId || !msgType || msgType === 'e2ee') continue;
    if (!rerenderStored(quoteOf(eventId), msgId, msgType)) continue;
    if (unsupportedNoticeType(await readContent(eventId)) === msgType) found.push(msgId);
  }
  return found;
}
