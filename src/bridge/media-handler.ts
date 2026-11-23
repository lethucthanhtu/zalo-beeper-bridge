// Inbound photos and stickers: Zalo CDN → Matrix content repo → portal room. Zalo CDN URLs are
// public (no session headers) but expire, so download immediately on event receipt.
import type { Intent } from 'matrix-appservice-bridge';
import { animatedSticker } from './animated-sticker.ts';
import {
  buildMediaEvent,
  downloadFirstMedia,
  fileExtensionFor,
  roomUploader,
  stickerContent,
} from './media-content.ts';
import { fetchMediaCapped, sniffMimetype } from './media-fetch.ts';
import type { MappingStore, StickerMedia } from './mapping-store.ts';

/** A Zalo photo message as needed to bridge it. */
type InboundPhoto = {
  url: string;
  /** Other copies (HD, thumbnail) tried in order when `url` fails. */
  fallbackUrls?: string[];
  width?: number;
  height?: number;
  caption?: string;
  /** What to call the photo in log lines, e.g. `photo <msgId>`. */
  label?: string;
};

/** Result of bridging one media message into Matrix. */
type MediaResult = {
  eventId: string;
};

/** Persistent sticker upload cache (MappingStore implements it); see {@link bridgeInboundSticker}. */
export type StickerMediaStore = Pick<MappingStore, 'getStickerMedia' | 'putStickerMedia'>;

// Sticker upload cache: the same sticker id is sent many times, so upload once per mode.
// Keyed by mode and sticker id. An encrypted upload is not tied to a room (the key travels in
// each event), so one encrypted upload serves every encrypted room.
const stickerMxcCache = new Map<string, StickerMedia>();

/**
 * Renders a Zalo sticker as a native Matrix m.sticker event.
 * The uploaded image is reused per sticker id and mode (plain or encrypted): from the in-process
 * cache, else from `store` (kept across restarts and shared with the history importer). Only a
 * validated image is cached.
 *
 * @param intent - Sender intent (the ghost of the Zalo sender).
 * @param roomId - Portal room.
 * @param stickerId - Zalo sticker id.
 * @param imageUrl - Static sticker image URL, used when no animated version exists.
 * @param maxBytes - Download size cap.
 * @param extra - Extra content fields merged into the event (e.g. relations); they override defaults.
 * @param encrypted - Whether the room is encrypted: the image is then uploaded encrypted and sent as `file`.
 * @param store - Persistent sticker cache; without it only the in-process cache is used.
 * @returns The Matrix event id.
 * @throws When neither an animated nor a static image is available, or on download/upload/send errors.
 */
export async function bridgeInboundSticker(
  intent: Intent,
  roomId: string,
  stickerId: number,
  imageUrl: string | null,
  maxBytes: number,
  extra?: Record<string, unknown>,
  encrypted = false,
  store?: StickerMediaStore,
): Promise<MediaResult> {
  const cacheKey = `${encrypted ? 'encrypted' : 'plain'}:${stickerId}`;
  let cached = stickerMxcCache.get(cacheKey) ?? store?.getStickerMedia(stickerId, encrypted) ?? undefined;
  if (cached) stickerMxcCache.set(cacheKey, cached);
  else {
    // Animated stickers have no animated URL — build the WebP from Zalo's sprite strip
    const animated = await animatedSticker(stickerId);
    let image: { buffer: Buffer; mimetype: string; w?: number; h?: number };
    if (animated)
      image = { buffer: animated.buffer, mimetype: animated.mimetype, w: animated.width, h: animated.height };
    else if (imageUrl) {
      const { buffer, mimetype } = await fetchMediaCapped(imageUrl, maxBytes);
      image = { buffer, mimetype: sniffMimetype(buffer, mimetype) };
      // A 200 answer is not proof of an image: a few-byte non-image body would show as a broken sticker
      if (!image.mimetype.startsWith('image/'))
        throw new Error(`sticker ${stickerId} is not an image (${buffer.byteLength} bytes, ${image.mimetype})`);
    } else throw new Error('sticker image unavailable');
    const upload = roomUploader((buffer, options) => intent.uploadContent(buffer, options), encrypted);
    const uploaded = await upload(image.buffer, { type: image.mimetype, name: `zalo-sticker-${stickerId}` });
    cached = { uploaded, mimetype: image.mimetype, size: image.buffer.byteLength, w: image.w, h: image.h };
    stickerMxcCache.set(cacheKey, cached);
    try {
      store?.putStickerMedia(stickerId, encrypted, cached);
    } catch {
      // The cache is an optimisation: a busy or read-only database must not lose the sticker
    }
  }
  const { event_id } = await intent.sendEvent(roomId, 'm.sticker', { ...stickerContent(cached, stickerId), ...extra });
  return { eventId: event_id };
}

/**
 * Downloads a Zalo photo, uploads it to the Matrix content repo and sends it as `m.image`.
 * The caption, when present, becomes the body (MSC2530) with the file name in `filename`.
 *
 * @param intent - Sender intent (the ghost of the Zalo sender, or the owner).
 * @param roomId - Portal room.
 * @param photo - Photo URL, optional dimensions and caption.
 * @param maxBytes - Download size cap.
 * @param extra - Extra content fields merged into the event (e.g. relations); they override defaults.
 * @param encrypted - Whether the room is encrypted: the photo is then uploaded encrypted and sent as `file`.
 * @returns The Matrix event id.
 * @throws On download (MediaDownloadError, see {@link downloadFirstMedia}), upload or send errors.
 */
export async function bridgeInboundPhoto(
  intent: Intent,
  roomId: string,
  photo: InboundPhoto,
  maxBytes: number,
  extra?: Record<string, unknown>,
  encrypted = false,
): Promise<MediaResult> {
  // Sniffed mimetype: Zalo labels GIF photos image/jpeg
  const bytes = await downloadFirstMedia([photo.url, ...(photo.fallbackUrls ?? [])], maxBytes, {
    label: photo.label ?? 'photo',
  });
  const upload = roomUploader((data, options) => intent.uploadContent(data, options), encrypted);
  // Same builder as history imports, so live encrypted photos get their thumbnail too
  const { content } = await buildMediaEvent(
    upload,
    { kind: 'image', urls: [photo.url], caption: photo.caption, width: photo.width, height: photo.height },
    bytes,
    { filename: `zalo-photo.${fileExtensionFor(bytes.mimetype)}` },
  );
  Object.assign(content, extra);
  const { event_id } = await intent.sendMessage(roomId, content);
  return { eventId: event_id };
}
