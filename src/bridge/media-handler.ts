// Inbound media pipeline: Zalo CDN URL → download → Matrix content repo → m.image.
// Phase 1 verified the CDN is public (no session headers), but URLs may expire —
// always download immediately on event receipt.
import type { Intent } from "matrix-appservice-bridge";
import { animatedSticker } from "./animated-sticker.ts";

export interface InboundPhoto {
  url: string;
  width?: number;
  height?: number;
  caption?: string;
}

export interface MediaResult {
  eventId: string;
}

const FETCH_TIMEOUT_MS = 30_000;
// Media URLs come from message payloads (contact-influenced input) — restrict
// to Zalo CDN hosts over https to close SSRF toward localhost/LAN.
// dlmd.me / dlfl.vn are Zalo's signed video / file download CDNs.
const ALLOWED_HOST_SUFFIXES = [".zdn.vn", ".zadn.vn", ".dlmd.me", ".dlfl.vn"];

export interface FetchedMedia {
  buffer: Buffer;
  mimetype: string;
}

/** Real media type from magic bytes — Zalo CDNs mislabel (GIFs as image/jpeg, stickers unlabelled). */
export function sniffMimetype(buf: Buffer, fallback: string): string {
  const ascii = (start: number, end: number) => buf.subarray(start, end).toString("latin1");
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") return ascii(8, 10) === "qt" ? "video/quicktime" : fallback.startsWith("audio/") ? fallback : "video/mp4";
  if (ascii(0, 4) === "%PDF") return "application/pdf";
  // Zalo voice notes are raw ADTS AAC served as image/jpeg
  if (buf[0] === 0xff && ((buf[1] ?? 0) & 0xf6) === 0xf0) return "audio/aac";
  if (ascii(0, 3) === "ID3" || (buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(0, 5) === "#!AMR") return "audio/amr";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  return fallback;
}

/**
 * Download Matrix media (mxc://) via the authenticated media endpoint.
 * Beeper serves media behind auth + a redirect to R2; matrix-bot-sdk's
 * downloadContent forwards the Authorization header to R2 and gets a 400.
 * Native fetch strips auth on the cross-origin redirect, so it works.
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
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`matrix media download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("matrix media download returned no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`media exceeds size cap (>${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    mimetype: response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
  };
}

/** Guarded download: https-only, Zalo CDN hosts, hard timeout, streamed byte cap. */
export async function fetchMediaCapped(url: string, maxBytes: number, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchedMedia> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`refusing non-https media URL (${parsed.protocol})`);
  if (!ALLOWED_HOST_SUFFIXES.some((s) => parsed.hostname.endsWith(s))) {
    throw new Error(`refusing media host outside Zalo CDN (${parsed.hostname})`);
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`media download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("media download returned no body");
  // Expired links can answer 200 with an HTML/JSON error page instead of the media
  if (/^(text\/html|application\/json)/.test(response.headers.get("content-type") ?? "")) {
    throw new Error("media download returned an error page");
  }

  // Stream with a cap — content-length can be spoofed, never trust it for allocation
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`media exceeds size cap (>${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    mimetype: response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
  };
}

// Sticker mxc cache — the same sticker id is sent many times; upload once per run
const stickerMxcCache = new Map<number, { mxc: string; mimetype: string; size: number; w?: number; h?: number }>();

/** Renders a Zalo sticker as a native Matrix m.sticker event. */
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
    if (animated) image = { buffer: animated.buffer, mimetype: animated.mimetype, w: animated.width, h: animated.height };
    else if (imageUrl) {
      const { buffer, mimetype } = await fetchMediaCapped(imageUrl, maxBytes);
      image = { buffer, mimetype: sniffMimetype(buffer, mimetype) };
    } else throw new Error("sticker image unavailable");
    const mxc = await intent.uploadContent(image.buffer, { type: image.mimetype, name: `zalo-sticker-${stickerId}` });
    cached = { mxc, mimetype: image.mimetype, size: image.buffer.byteLength, w: image.w, h: image.h };
    stickerMxcCache.set(stickerId, cached);
  }
  const { event_id } = await intent.sendEvent(roomId, "m.sticker", {
    body: "sticker",
    url: cached.mxc,
    info: { mimetype: cached.mimetype, size: cached.size, ...(cached.w ? { w: cached.w, h: cached.h } : {}) },
    ...extra,
  });
  return { eventId: event_id };
}

export async function bridgeInboundPhoto(
  intent: Intent,
  roomId: string,
  photo: InboundPhoto,
  maxBytes: number,
  extra?: Record<string, unknown>,
): Promise<MediaResult> {
  const { buffer, mimetype } = await fetchMediaCapped(photo.url, maxBytes);
  const ext = mimetype.split("/")[1]?.split(";")[0] ?? "jpg";
  const mxcUrl = await intent.uploadContent(buffer, { type: mimetype, name: `zalo-photo.${ext}` });
  // MSC2530 caption: body = caption, filename = the actual file name (kept distinct)
  const content: Record<string, unknown> = {
    msgtype: "m.image",
    body: photo.caption || `zalo-photo.${ext}`,
    url: mxcUrl,
    info: {
      mimetype,
      size: buffer.byteLength,
      ...(photo.width ? { w: photo.width } : {}),
      ...(photo.height ? { h: photo.height } : {}),
    },
  };
  if (photo.caption) content.filename = `zalo-photo.${ext}`;
  Object.assign(content, extra);
  const { event_id } = await intent.sendMessage(roomId, content);
  return { eventId: event_id };
}
