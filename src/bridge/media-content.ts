// Shared Zalo media → Matrix content, used by the live inbound pipeline AND the history
// importer so a bridged video/file/voice/GIF/sticker/link looks the same either way.
// Callers resolve the bytes (CDN download or backup copy); this module uploads them and
// shapes the event (m.image / m.video / m.file / m.audio voice / m.sticker), and turns a
// Zalo link card into a Beeper link preview (com.beeper.linkpreviews).
import { fetchMediaCapped, sniffMimetype } from './media-handler.ts';

export type MediaKind = 'image' | 'sticker' | 'video' | 'file' | 'audio';

/** Videos and documents routinely exceed the photo cap; Beeper accepts uploads this big */
export const LARGE_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** A Zalo attachment: where it may be downloaded from plus what Matrix wants to know. */
export type MediaDescriptor = {
  kind: MediaKind;
  /** candidate download URLs, best first (may all be expired) */
  urls: string[];
  filename?: string;
  caption?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  size?: number;
  /** Zalo sticker id — stickers are cached per id */
  stickerId?: number;
};

/** Zalo link card → Beeper link preview. */
export type LinkPreview = {
  /** the URL as it appears in the message body */
  url: string;
  title?: string;
  description?: string;
  /** preview thumbnail on the Zalo CDN (may be expired) */
  imageUrl?: string;
};

/** Downloaded (or locally read) media bytes plus their real type and optional dimensions. */
export type MediaBytes = {
  buffer: Buffer;
  mimetype: string;
  width?: number;
  height?: number;
};

/** Uploads to the Matrix content repo (Intent.uploadContent shape). */
export type Uploader = (buffer: Buffer, options: { type: string; name: string }) => Promise<string>;

/**
 * Downloads the first candidate URL that still serves the media. Candidates are tried in
 * order; any failure (expired link, dead host, timeout, over `maxBytes`) moves on to the
 * next one. The mimetype is sniffed from the bytes because Zalo's content-type is often wrong.
 *
 * @param urls candidate download URLs, best first
 * @param maxBytes download cap passed to {@link fetchMediaCapped}
 * @param timeoutMs per-request timeout; the media handler's default when omitted
 * @returns the bytes with the sniffed mimetype, or null when no candidate is reachable
 */
export async function fetchFirstMedia(
  urls: string[],
  maxBytes: number,
  timeoutMs?: number,
): Promise<MediaBytes | null> {
  for (const url of urls) {
    try {
      const { buffer, mimetype } = await fetchMediaCapped(url, maxBytes, timeoutMs);
      return { buffer, mimetype: sniffMimetype(buffer, mimetype) };
    } catch {
      // expired / dead host → next candidate
    }
  }
  return null;
}

/**
 * File extension for a mimetype (its subtype, with `jpeg` → `jpg` and `quicktime` → `mov`),
 * used to name uploads that carry no filename; `bin` when the mimetype has no subtype.
 */
const fileExtensionFor = (mimetype: string) =>
  mimetype.split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov') ?? 'bin';

/**
 * Matrix event for an attachment. `mxcUrl` skips the upload (sticker cache).
 * Voice notes carry the MSC3245 marker so Beeper shows a voice-message bubble.
 *
 * Side effect: uploads `bytes` through `upload` unless `overrides.mxcUrl` is given.
 *
 * @param upload content-repo uploader (e.g. Intent.uploadContent)
 * @param media what the attachment is (kind, caption, dimensions, duration, filename)
 * @param bytes the resolved media bytes; dimensions here are used when `media` lacks them
 * @param overrides `filename` beats the descriptor's name; `mxcUrl` reuses an earlier upload
 * @returns the event type, its content, and the mxc URL (so callers can cache it)
 */
export async function buildMediaEvent(
  upload: Uploader,
  media: MediaDescriptor,
  bytes: MediaBytes,
  overrides: { filename?: string; mxcUrl?: string } = {},
): Promise<{ type: string; content: Record<string, unknown>; mxcUrl: string }> {
  // A voice note must carry an audio type or clients won't play it (Zalo mislabels it)
  if (media.kind === 'audio' && !bytes.mimetype.startsWith('audio/')) bytes = { ...bytes, mimetype: 'audio/aac' };
  const filename = overrides.filename ?? media.filename ?? `zalo-${media.kind}.${fileExtensionFor(bytes.mimetype)}`;
  const mxcUrl = overrides.mxcUrl ?? (await upload(bytes.buffer, { type: bytes.mimetype, name: filename }));
  const width = media.width ?? bytes.width;
  const height = media.height ?? bytes.height;
  const duration = media.durationMs ? Math.round(media.durationMs) : undefined;
  const info = {
    mimetype: bytes.mimetype,
    size: bytes.buffer.byteLength,
    ...(width ? { w: width } : {}),
    ...(height ? { h: height } : {}),
    ...(duration ? { duration } : {}),
  };
  if (media.kind === 'sticker') return { type: 'm.sticker', content: { body: 'sticker', url: mxcUrl, info }, mxcUrl };
  const msgtype = { image: 'm.image', video: 'm.video', file: 'm.file', audio: 'm.audio' }[media.kind];
  // MSC2530 caption: body = caption, filename = the actual file name (kept distinct)
  const content: Record<string, unknown> = { msgtype, body: media.caption || filename, url: mxcUrl, info };
  if (media.caption || media.kind === 'file') content.filename = filename;
  if (media.kind === 'audio') {
    content['org.matrix.msc1767.audio'] = duration ? { duration } : {};
    content['org.matrix.msc3245.voice'] = {};
  }
  return { type: 'm.room.message', content, mxcUrl };
}

/**
 * com.beeper.linkpreviews entry (mautrix BeeperLinkPreview shape). The thumbnail is
 * uploaded when it still downloads; a preview without an image is still shown.
 *
 * Side effects: downloads `preview.imageUrl` (if any) and uploads it through `upload`
 * when it turns out to be an image.
 *
 * @param maxBytes download cap for the thumbnail
 * @param timeoutMs thumbnail download timeout; the media handler's default when omitted
 * @returns the preview object (`matched_url`, `og:*`, `matrix:image:size`)
 */
export async function buildLinkPreview(
  upload: Uploader,
  preview: LinkPreview,
  maxBytes: number,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const previewEntry: Record<string, unknown> = { matched_url: preview.url, 'og:url': preview.url };
  if (preview.title) previewEntry['og:title'] = preview.title;
  if (preview.description) previewEntry['og:description'] = preview.description;
  if (preview.imageUrl) {
    const image = await fetchFirstMedia([preview.imageUrl], maxBytes, timeoutMs);
    if (image?.mimetype.startsWith('image/')) {
      previewEntry['og:image'] = await upload(image.buffer, {
        type: image.mimetype,
        name: `preview.${fileExtensionFor(image.mimetype)}`,
      });
      previewEntry['og:image:type'] = image.mimetype;
      previewEntry['matrix:image:size'] = image.buffer.byteLength;
    }
  }
  return previewEntry;
}
