// Zalo content → Matrix content pieces that the live inbound handler, the history importer and
// the "not supported" re-render all post. One copy keeps a rebuilt room reading like a live one:
// the same location pin, the same notice text (which the re-render also parses back) and the
// same "no longer on the Zalo server" line when an attachment cannot be downloaded.
import type { MediaDescriptor } from '../media-descriptor.ts';
import { joinLines } from '../util.ts';
import type { ZaloContent } from '../zalo/types.ts';

/** Start of the notice posted for a Zalo msgType the bridge cannot render. */
export const UNSUPPORTED_NOTICE_PREFIX = '[Zalo message type not supported by bridge:';

/** Notice for an end-to-end encrypted Zalo message: the payload is ciphertext, never shown. */
export const E2EE_NOTICE_BODY =
  '🔒 Tin nhắn mã hoá đầu cuối của Zalo — bridge không giải mã được. Mở Zalo trên điện thoại để đọc. (End-to-end encrypted Zalo message — open Zalo on your phone to read it.)';

/** Body of the notice for a Zalo msgType the bridge cannot render. */
export const unsupportedNoticeBody = (msgType: string): string =>
  msgType === 'e2ee' ? E2EE_NOTICE_BODY : `${UNSUPPORTED_NOTICE_PREFIX} ${msgType}]`;

/**
 * Native Matrix location: clients draw a map preview and open the device's default maps app.
 * Carries both the classic `geo_uri` and the extensible-events (MSC3488) fields.
 */
export function locationContent(content: Extract<ZaloContent, { kind: 'location' }>): Record<string, unknown> {
  const geoUri = `geo:${content.latitude},${content.longitude}`;
  return {
    msgtype: 'm.location',
    body: content.text,
    geo_uri: geoUri,
    'org.matrix.msc3488.location': { uri: geoUri, description: content.label },
    'org.matrix.msc3488.asset': { type: 'm.pin' },
    'org.matrix.msc1767.text': content.text,
  };
}

/** Human-readable size ("367 KB", "1.5 MB"); '' when unknown. */
export function formatBytes(byteCount: number): string {
  if (!Number.isFinite(byteCount) || byteCount <= 0) return '';
  if (byteCount < 1024 * 1024) return `${Math.max(1, Math.round(byteCount / 1024))} KB`;
  return `${(byteCount / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Text posted instead of an attachment whose bytes are gone (expired CDN link, no backup copy).
 * Keeps what is still known (size, length, caption, file name) so the message stays meaningful.
 */
export function mediaGoneBody(media: MediaDescriptor): string {
  const gone = 'không còn trên máy chủ Zalo';
  const secs = media.durationMs ? ` ${Math.round(media.durationMs / 1000)}s` : '';
  switch (media.kind) {
    case 'image': {
      const dims = media.width && media.height ? ` ${media.width}×${media.height}` : '';
      return joinLines(`📷 [Ảnh${dims} — ${gone}]`, media.caption);
    }
    case 'audio':
      return `🎤 [Tin nhắn thoại${secs} — ${gone}]`;
    case 'video':
      return joinLines(`🎬 [Video${secs} — ${gone}]`, media.caption);
    case 'sticker':
      return '[Sticker]';
    case 'file': {
      const size = media.size ? ` (${formatBytes(media.size)})` : '';
      return `📎 [Tệp] ${media.filename ?? 'zalo-file'}${size} — ${gone}`;
    }
  }
}
