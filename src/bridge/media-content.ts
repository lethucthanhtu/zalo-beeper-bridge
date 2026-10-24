// Shared Zalo media → Matrix content, used by the live inbound pipeline AND the history
// importer so a bridged video/file/voice/GIF/sticker/link looks the same either way.
// Callers resolve the bytes (CDN download or backup copy); this module uploads them and
// shapes the event (m.image / m.video / m.file / m.audio voice / m.sticker), and turns a
// Zalo link card into a Beeper link preview (com.beeper.linkpreviews).
import { fetchMediaCapped, sniffMimetype } from "./media-handler.ts";

export type MediaKind = "image" | "sticker" | "video" | "file" | "audio";

/** Videos and documents routinely exceed the photo cap; Beeper accepts uploads this big */
export const LARGE_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** A Zalo attachment: where it may be downloaded from plus what Matrix wants to know. */
export interface MediaDescriptor {
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
}

/** Zalo link card → Beeper link preview. */
export interface LinkPreview {
  /** the URL as it appears in the message body */
  url: string;
  title?: string;
  description?: string;
  /** preview thumbnail on the Zalo CDN (may be expired) */
  imageUrl?: string;
}

export interface MediaBytes {
  buffer: Buffer;
  mimetype: string;
  width?: number;
  height?: number;
}

/** Uploads to the Matrix content repo (Intent.uploadContent shape). */
export type Uploader = (buffer: Buffer, opts: { type: string; name: string }) => Promise<string>;

/** First candidate URL that still serves the media, with the real (sniffed) type. */
export async function fetchFirstMedia(urls: string[], maxBytes: number, timeoutMs?: number): Promise<MediaBytes | null> {
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

const extOf = (mimetype: string) => mimetype.split("/")[1]?.replace("jpeg", "jpg").replace("quicktime", "mov") ?? "bin";

/**
 * Matrix event for an attachment. `mxcUrl` skips the upload (sticker cache).
 * Voice notes carry the MSC3245 marker so Beeper shows a voice-message bubble.
 */
export async function buildMediaEvent(
  upload: Uploader,
  media: MediaDescriptor,
  bytes: MediaBytes,
  opts: { filename?: string; mxcUrl?: string } = {},
): Promise<{ type: string; content: Record<string, unknown>; mxcUrl: string }> {
  // A voice note must carry an audio type or clients won't play it (Zalo mislabels it)
  if (media.kind === "audio" && !bytes.mimetype.startsWith("audio/")) bytes = { ...bytes, mimetype: "audio/aac" };
  const filename = opts.filename ?? media.filename ?? `zalo-${media.kind}.${extOf(bytes.mimetype)}`;
  const mxcUrl = opts.mxcUrl ?? (await upload(bytes.buffer, { type: bytes.mimetype, name: filename }));
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
  if (media.kind === "sticker") return { type: "m.sticker", content: { body: "sticker", url: mxcUrl, info }, mxcUrl };
  const msgtype = { image: "m.image", video: "m.video", file: "m.file", audio: "m.audio" }[media.kind];
  // MSC2530 caption: body = caption, filename = the actual file name (kept distinct)
  const content: Record<string, unknown> = { msgtype, body: media.caption || filename, url: mxcUrl, info };
  if (media.caption || media.kind === "file") content.filename = filename;
  if (media.kind === "audio") {
    content["org.matrix.msc1767.audio"] = duration ? { duration } : {};
    content["org.matrix.msc3245.voice"] = {};
  }
  return { type: "m.room.message", content, mxcUrl };
}

/**
 * com.beeper.linkpreviews entry (mautrix BeeperLinkPreview shape). The thumbnail is
 * uploaded when it still downloads; a preview without an image is still shown.
 */
export async function buildLinkPreview(upload: Uploader, preview: LinkPreview, maxBytes: number, timeoutMs?: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { matched_url: preview.url, "og:url": preview.url };
  if (preview.title) out["og:title"] = preview.title;
  if (preview.description) out["og:description"] = preview.description;
  if (preview.imageUrl) {
    const image = await fetchFirstMedia([preview.imageUrl], maxBytes, timeoutMs);
    if (image?.mimetype.startsWith("image/")) {
      out["og:image"] = await upload(image.buffer, { type: image.mimetype, name: `preview.${extOf(image.mimetype)}` });
      out["og:image:type"] = image.mimetype;
      out["matrix:image:size"] = image.buffer.byteLength;
    }
  }
  return out;
}
