// Inbound media pipeline: Zalo CDN URL → download → Matrix content repo → m.image.
// Phase 1 verified the CDN is public (no session headers), but URLs may expire —
// always download immediately on event receipt.
import type { Intent } from 'matrix-appservice-bridge';
import { animatedSticker } from './animated-sticker.ts';

/** A Zalo photo message as needed to bridge it. */
export type InboundPhoto = {
  url: string;
  width?: number;
  height?: number;
  caption?: string;
};

/** Result of bridging one media message into Matrix. */
export type MediaResult = {
  eventId: string;
};

const FETCH_TIMEOUT_MS = 30_000;
// Media URLs come from message payloads (contact-influenced input) — restrict
// to Zalo CDN hosts over https to close SSRF toward localhost/LAN.
// dlmd.me / dlfl.vn are Zalo's signed video / file download CDNs.
const ALLOWED_HOST_SUFFIXES = ['.zdn.vn', '.zadn.vn', '.dlmd.me', '.dlfl.vn'];

/** Downloaded bytes plus the server-declared mimetype (parameters stripped). */
export type FetchedMedia = {
  buffer: Buffer;
  mimetype: string;
};

/**
 * Real media type from magic bytes — Zalo CDNs mislabel (GIFs as image/jpeg, stickers unlabelled).
 *
 * @param buffer - File contents (only the first few bytes are inspected).
 * @param fallback - Declared mimetype; returned when no signature matches. For ISO-BMFF
 *   (`ftyp`) containers an `audio/*` fallback is kept, since the same box marks m4a audio.
 * @returns The sniffed mimetype, or `fallback`.
 */
export function sniffMimetype(buffer: Buffer, fallback: string): string {
  /** Bytes [start, end) as a latin1 string, for comparing ASCII signatures. */
  const asciiAt = (start: number, end: number) => buffer.subarray(start, end).toString('latin1');
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (asciiAt(1, 4) === 'PNG') return 'image/png';
  if (asciiAt(0, 4) === 'GIF8') return 'image/gif';
  if (asciiAt(0, 4) === 'RIFF' && asciiAt(8, 12) === 'WEBP') return 'image/webp';
  if (asciiAt(4, 8) === 'ftyp')
    return asciiAt(8, 10) === 'qt' ? 'video/quicktime' : fallback.startsWith('audio/') ? fallback : 'video/mp4';
  if (asciiAt(0, 4) === '%PDF') return 'application/pdf';
  // Zalo voice notes are raw ADTS AAC served as image/jpeg
  if (buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xf6) === 0xf0) return 'audio/aac';
  if (asciiAt(0, 3) === 'ID3' || (buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (asciiAt(0, 5) === '#!AMR') return 'audio/amr';
  if (asciiAt(0, 4) === 'OggS') return 'audio/ogg';
  return fallback;
}

/**
 * Download Matrix media (mxc://) via the authenticated media endpoint.
 * Beeper serves media behind auth + a redirect to R2; matrix-bot-sdk's
 * downloadContent forwards the Authorization header to R2 and gets a 400.
 * Native fetch strips auth on the cross-origin redirect, so it works.
 *
 * @param homeserverUrl - Homeserver base URL.
 * @param accessToken - Token sent as Bearer auth (the appservice token).
 * @param mxcUrl - `mxc://<server>/<mediaId>` URL to download.
 * @param maxBytes - Streamed size cap; the download aborts once exceeded.
 * @returns The bytes and the response mimetype (`application/octet-stream` when absent).
 * @throws On a malformed mxc URL, non-2xx answer, empty body, timeout (FETCH_TIMEOUT_MS) or size cap.
 */
export async function downloadMatrixMedia(
  homeserverUrl: string,
  accessToken: string,
  mxcUrl: string,
  maxBytes: number,
): Promise<FetchedMedia> {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUrl);
  if (!match) throw new Error(`bad mxc url: ${mxcUrl}`);
  const [, server, mediaId] = match;
  const url = `${homeserverUrl}/_matrix/client/v1/media/download/${server}/${mediaId}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`matrix media download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error('matrix media download returned no body');
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maxBytes) throw new Error(`media exceeds size cap (>${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    mimetype: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
  };
}

/**
 * Guarded download: https-only, Zalo CDN hosts, hard timeout, streamed byte cap.
 *
 * @param url - Zalo CDN media URL (untrusted, from a message payload).
 * @param maxBytes - Streamed size cap; the download aborts once exceeded.
 * @param timeoutMs - Hard timeout for the whole request.
 * @returns The bytes and the declared mimetype (`application/octet-stream` when absent);
 *   callers should still run {@link sniffMimetype} since Zalo mislabels media.
 * @throws On a non-https URL, a host outside ALLOWED_HOST_SUFFIXES, non-2xx answer, empty body,
 *   an HTML/JSON error page, timeout or the size cap.
 */
export async function fetchMediaCapped(
  url: string,
  maxBytes: number,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchedMedia> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`refusing non-https media URL (${parsed.protocol})`);
  if (!ALLOWED_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))) {
    throw new Error(`refusing media host outside Zalo CDN (${parsed.hostname})`);
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`media download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error('media download returned no body');
  // Expired links can answer 200 with an HTML/JSON error page instead of the media
  if (/^(text\/html|application\/json)/.test(response.headers.get('content-type') ?? '')) {
    throw new Error('media download returned an error page');
  }

  // Stream with a cap — content-length can be spoofed, never trust it for allocation
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maxBytes) throw new Error(`media exceeds size cap (>${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    mimetype: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
  };
}

// Sticker mxc cache — the same sticker id is sent many times; upload once per run
const stickerMxcCache = new Map<number, { mxc: string; mimetype: string; size: number; w?: number; h?: number }>();

/**
 * Renders a Zalo sticker as a native Matrix m.sticker event.
 * The uploaded image is cached per sticker id for the process lifetime (see stickerMxcCache).
 *
 * @param intent - Sender intent (the ghost of the Zalo sender).
 * @param roomId - Portal room.
 * @param stickerId - Zalo sticker id.
 * @param imageUrl - Static sticker image URL, used when no animated version exists.
 * @param maxBytes - Download size cap.
 * @param extra - Extra content fields merged into the event (e.g. relations); they override defaults.
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
): Promise<MediaResult> {
  let cached = stickerMxcCache.get(stickerId);
  if (!cached) {
    // Animated stickers have no animated URL — build the WebP from Zalo's sprite strip
    const animated = await animatedSticker(stickerId);
    let image: { buffer: Buffer; mimetype: string; w?: number; h?: number };
    if (animated)
      image = { buffer: animated.buffer, mimetype: animated.mimetype, w: animated.width, h: animated.height };
    else if (imageUrl) {
      const { buffer, mimetype } = await fetchMediaCapped(imageUrl, maxBytes);
      image = { buffer, mimetype: sniffMimetype(buffer, mimetype) };
    } else throw new Error('sticker image unavailable');
    const mxc = await intent.uploadContent(image.buffer, { type: image.mimetype, name: `zalo-sticker-${stickerId}` });
    cached = { mxc, mimetype: image.mimetype, size: image.buffer.byteLength, w: image.w, h: image.h };
    stickerMxcCache.set(stickerId, cached);
  }
  const { event_id } = await intent.sendEvent(roomId, 'm.sticker', {
    body: 'sticker',
    url: cached.mxc,
    info: { mimetype: cached.mimetype, size: cached.size, ...(cached.w ? { w: cached.w, h: cached.h } : {}) },
    ...extra,
  });
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
 * @returns The Matrix event id.
 * @throws On download (see {@link fetchMediaCapped}), upload or send errors.
 */
export async function bridgeInboundPhoto(
  intent: Intent,
  roomId: string,
  photo: InboundPhoto,
  maxBytes: number,
  extra?: Record<string, unknown>,
): Promise<MediaResult> {
  const { buffer, mimetype } = await fetchMediaCapped(photo.url, maxBytes);
  const extension = mimetype.split('/')[1]?.split(';')[0] ?? 'jpg';
  const mxcUrl = await intent.uploadContent(buffer, { type: mimetype, name: `zalo-photo.${extension}` });
  // MSC2530 caption: body = caption, filename = the actual file name (kept distinct)
  const content: Record<string, unknown> = {
    msgtype: 'm.image',
    body: photo.caption || `zalo-photo.${extension}`,
    url: mxcUrl,
    info: {
      mimetype,
      size: buffer.byteLength,
      ...(photo.width ? { w: photo.width } : {}),
      ...(photo.height ? { h: photo.height } : {}),
    },
  };
  if (photo.caption) content.filename = `zalo-photo.${extension}`;
  Object.assign(content, extra);
  const { event_id } = await intent.sendMessage(roomId, content);
  return { eventId: event_id };
}
