// Shared Zalo media → Matrix content, used by the live inbound pipeline AND the history
// importer so a bridged video/file/voice/GIF/sticker/link looks the same either way.
// Callers resolve the bytes (CDN download or backup copy); this module uploads them and
// shapes the event (m.image / m.video / m.file / m.audio voice / m.sticker), and turns a
// Zalo link card into a Beeper link preview (com.beeper.linkpreviews).
import type { EncryptedFile } from '@vector-im/matrix-bot-sdk';
import { adtsToM4a, isAdts } from './audio-remux.ts';
import { makeThumbnail, THUMBNAIL_MAX_SIDE } from './image-thumbnail.ts';
import { fetchMediaCapped, MediaHttpError, sniffMimetype } from './media-fetch.ts';
import { errorMessage } from '../error-message.ts';
import { encryptAttachment } from '../matrix/crypto.ts';
import type { LinkPreview, MediaDescriptor, MediaKind } from '../media-descriptor.ts';

/** Videos and documents routinely exceed the photo cap; Beeper accepts uploads this big */
export const LARGE_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
/** Whole-download timeout for videos / documents: 100 MB needs far more than the 30 s photo timeout */
export const LARGE_MEDIA_TIMEOUT_MS = 180_000;

/** Videos and documents: the kinds that get the large-media cap and timeout. */
export const isLargeMedia = (kind: MediaKind): boolean => kind === 'video' || kind === 'file';

/**
 * Download cap for one attachment, shared by the live bridge and the importer so both accept
 * the same files: the configured cap, raised to LARGE_MEDIA_MAX_BYTES for videos and documents.
 */
export const mediaMaxBytesFor = (kind: MediaKind, configuredMaxBytes: number): number =>
  isLargeMedia(kind) ? Math.max(configuredMaxBytes, LARGE_MEDIA_MAX_BYTES) : configuredMaxBytes;

/** Downloaded (or locally read) media bytes plus their real type and optional dimensions. */
export type MediaBytes = {
  buffer: Buffer;
  mimetype: string;
  width?: number;
  height?: number;
};

/** Plain upload to the Matrix content repo, returning the mxc:// URI (Intent.uploadContent shape). */
export type RawUploader = (buffer: Buffer, options: { type: string; name?: string }) => Promise<string>;

/**
 * Where an uploaded attachment lives: a plain mxc `url` for a plain room, or the encrypted
 * `file` (mxc url plus key, iv and hash) for an encrypted one.
 */
export type Uploaded = { url: string } | { file: EncryptedFile };

/** Uploads media for ONE target room; the room's encryption decides which {@link Uploaded} comes back. */
export type Uploader = (buffer: Buffer, options: { type: string; name: string }) => Promise<Uploaded>;

/**
 * Uploader for one target room. A plain room gets the bytes as they are. An encrypted room gets
 * the ciphertext as an anonymous `application/octet-stream` (the server must not learn the type
 * or name; both travel inside the encrypted event), plus the key material for `content.file`.
 *
 * @param upload - Plain content-repo upload (e.g. Intent.uploadContent).
 * @param encrypted - Whether the target room is encrypted.
 */
export function roomUploader(upload: RawUploader, encrypted: boolean): Uploader {
  if (!encrypted) return async (buffer, options) => ({ url: await upload(buffer, options) });
  return async (buffer) => {
    const { data, file } = encryptAttachment(buffer);
    return { file: { ...file, url: await upload(data, { type: 'application/octet-stream' }) } };
  };
}

/** Pause before the single retry of a transient download failure. */
const MEDIA_RETRY_DELAY_MS = 1_000;

/** Every candidate URL failed; the message lists each host with its error (never the signed path). */
export class MediaDownloadError extends Error {
  readonly failures: string[];
  constructor(failures: string[]) {
    super(failures.length ? failures.join('; ') : 'no download URL');
    this.name = 'MediaDownloadError';
    this.failures = failures;
  }
}

/**
 * Whether a download failure may succeed on a second try: a CDN 5xx or 429, a timeout, or a
 * dropped connection. A 4xx (expired signed link), an error page or the size cap never will.
 *
 * @param err - What {@link fetchMediaCapped} threw.
 */
export function isTransientMediaError(err: unknown): boolean {
  if (err instanceof MediaHttpError) return err.status >= 500 || err.status === 429;
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  // undici reports network failures as TypeError('fetch failed') with the socket error as cause
  const cause = (err as { cause?: { code?: string } }).cause;
  return (err instanceof TypeError && err.message === 'fetch failed') || cause?.code === 'ECONNRESET';
}

/** Host of a media URL for logs: the path and query are a signed token and stay out. */
const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).hostname : 'invalid-url');

/** Options for {@link downloadFirstMedia}. */
export type DownloadOptions = {
  /** Per-request timeout; the media handler's default when omitted. */
  timeoutMs?: number;
  /** What is being downloaded (e.g. `photo <msgId>`), prefixed to every log line. */
  label?: string;
  /** Pause before retrying a transient failure; tests pass 0. */
  retryDelayMs?: number;
};

/**
 * Downloads the first candidate URL that still serves the media. Candidates are tried in
 * order; a transient failure (see {@link isTransientMediaError}) is retried once on the same
 * URL, any other failure moves on to the next candidate. The mimetype is sniffed from the
 * bytes because Zalo's content-type is often wrong.
 *
 * @param urls candidate download URLs, best first
 * @param maxBytes download cap passed to {@link fetchMediaCapped}
 * @param options timeout, log label and retry delay
 * @returns the bytes with the sniffed mimetype
 * @throws MediaDownloadError when no candidate is reachable
 */
export async function downloadFirstMedia(
  urls: string[],
  maxBytes: number,
  options: DownloadOptions = {},
): Promise<MediaBytes> {
  const { timeoutMs, label, retryDelayMs = MEDIA_RETRY_DELAY_MS } = options;
  const prefix = label ? `[media] ${label}:` : '[media]';
  const failures: string[] = [];
  for (const url of urls) {
    for (let attempt = 1; ; attempt++) {
      try {
        const { buffer, mimetype } = await fetchMediaCapped(url, maxBytes, timeoutMs);
        if (attempt > 1 || failures.length)
          console.log(`${prefix} downloaded from ${hostOf(url)} after retry/fallback`);
        return { buffer, mimetype: sniffMimetype(buffer, mimetype) };
      } catch (err) {
        const retry = attempt === 1 && isTransientMediaError(err);
        console.warn(
          `${prefix} download from ${hostOf(url)} failed: ${errorMessage(err)}${retry ? ' (retrying)' : ''}`,
        );
        if (retry) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        failures.push(`${hostOf(url)}: ${errorMessage(err)}`);
        break;
      }
    }
  }
  throw new MediaDownloadError(failures);
}

/**
 * {@link downloadFirstMedia} that returns null instead of throwing when no candidate is reachable.
 *
 * @param urls candidate download URLs, best first
 * @param maxBytes download cap passed to {@link fetchMediaCapped}
 * @param timeoutMs per-request timeout; the media handler's default when omitted
 * @param label what is being downloaded, for the log lines
 * @returns the bytes with the sniffed mimetype, or null when no candidate is reachable
 */
export async function fetchFirstMedia(
  urls: string[],
  maxBytes: number,
  timeoutMs?: number,
  label?: string,
): Promise<MediaBytes | null> {
  try {
    return await downloadFirstMedia(urls, maxBytes, { timeoutMs, label });
  } catch (err) {
    if (err instanceof MediaDownloadError) return null;
    throw err;
  }
}

/**
 * File extension for a mimetype (its subtype, with `jpeg` → `jpg` and `quicktime` → `mov`),
 * used to name uploads that carry no filename; `bin` when the mimetype has no subtype.
 */
export const fileExtensionFor = (mimetype: string) =>
  mimetype.split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov') ?? 'bin';

/**
 * `m.sticker` content for an uploaded sticker image. `info` carries mautrix's
 * `fi.mau.bridged_sticker` marker (network + Zalo sticker id) so clients and tools can tell the
 * same sticker apart from other images.
 *
 * @param image where the image was uploaded, with its type, size and optional dimensions
 * @param stickerId Zalo sticker id, when known
 */
export function stickerContent(
  image: { uploaded: Uploaded; mimetype: string; size: number; w?: number; h?: number },
  stickerId?: number | string,
): Record<string, unknown> {
  return {
    body: 'sticker',
    ...image.uploaded,
    info: {
      mimetype: image.mimetype,
      size: image.size,
      ...(image.w ? { w: image.w } : {}),
      ...(image.h ? { h: image.h } : {}),
      ...(stickerId !== undefined ? { 'fi.mau.bridged_sticker': { network: 'zalo', id: String(stickerId) } } : {}),
    },
  };
}

/**
 * Matrix event for an attachment. `uploaded` skips the upload (sticker cache).
 * Voice notes carry the MSC3245 marker so Beeper shows a voice-message bubble.
 *
 * Side effect: uploads `bytes` through `upload` unless `overrides.uploaded` is given. An encrypted
 * upload puts `file` into the content instead of `url`; an encrypted photo also gets an
 * encrypted JPEG thumbnail (`info.thumbnail_file`).
 *
 * @param upload uploader for the target room (see {@link roomUploader})
 * @param media what the attachment is (kind, caption, dimensions, duration, filename)
 * @param bytes the resolved media bytes; dimensions here are used when `media` lacks them
 * @param overrides `filename` beats the descriptor's name; `uploaded` reuses an earlier upload
 * @returns the event type, its content, and where the media was uploaded (so callers can cache it)
 */
export async function buildMediaEvent(
  upload: Uploader,
  media: MediaDescriptor,
  bytes: MediaBytes,
  overrides: { filename?: string; uploaded?: Uploaded } = {},
): Promise<{ type: string; content: Record<string, unknown>; uploaded: Uploaded }> {
  let durationMs = media.durationMs;
  let voiceFilename: string | undefined;
  if (media.kind === 'audio') {
    // Zalo voice notes are raw ADTS AAC mislabelled image/jpeg: repackage them as M4A
    // (Beeper's own voice-note container) so every client can play them; keep the raw
    // stream as audio/aac when it is not clean ADTS
    const remuxed = isAdts(bytes.buffer) ? adtsToM4a(bytes.buffer) : null;
    if (remuxed) {
      bytes = { ...bytes, buffer: remuxed.m4a, mimetype: 'audio/mp4' };
      durationMs ??= remuxed.durationMs;
      voiceFilename = 'Voice message.m4a';
    } else if (!bytes.mimetype.startsWith('audio/')) {
      bytes = { ...bytes, mimetype: 'audio/aac' };
      voiceFilename = 'Voice message.aac';
    }
  }
  // The name must match the actual container (players pick a parser from it)
  const filename =
    overrides.filename ?? voiceFilename ?? media.filename ?? `zalo-${media.kind}.${fileExtensionFor(bytes.mimetype)}`;
  const uploaded = overrides.uploaded ?? (await upload(bytes.buffer, { type: bytes.mimetype, name: filename }));
  const width = media.width ?? bytes.width;
  const height = media.height ?? bytes.height;
  const duration = durationMs ? Math.round(durationMs) : undefined;
  const info = {
    mimetype: bytes.mimetype,
    size: bytes.buffer.byteLength,
    ...(width ? { w: width } : {}),
    ...(height ? { h: height } : {}),
    ...(duration ? { duration } : {}),
    ...(media.kind === 'image' && 'file' in uploaded && !overrides.uploaded
      ? await encryptedThumbnail(upload, bytes.buffer, width, height)
      : {}),
  };
  if (media.kind === 'sticker')
    return {
      type: 'm.sticker',
      content: stickerContent(
        { uploaded, mimetype: info.mimetype, size: info.size, w: width, h: height },
        media.stickerId,
      ),
      uploaded,
    };
  const msgtype = { image: 'm.image', video: 'm.video', file: 'm.file', audio: 'm.audio' }[media.kind];
  // MSC2530 caption: body = caption, filename = the actual file name. Always set so a
  // caption-less attachment (body === filename) shows no caption instead of the name
  const content: Record<string, unknown> = { msgtype, body: media.caption || filename, filename, ...uploaded, info };
  if (media.kind === 'audio') {
    // MSC1767 audio: duration in ms + waveform (MSC3246: values 0–1024) for the voice bubble
    content['org.matrix.msc1767.audio'] = {
      ...(duration ? { duration } : {}),
      waveform: media.waveform ?? [],
    };
    content['org.matrix.msc3245.voice'] = {};
  }
  return { type: 'm.room.message', content, uploaded };
}

/**
 * `info.thumbnail_file` / `info.thumbnail_info` for a photo in an encrypted room. Clients
 * cannot thumbnail encrypted media on the server, so without this they download and decrypt
 * the full photo for every timeline tile. Photos already within the thumbnail size get none.
 * A failed render or upload is logged and the photo is sent without a thumbnail.
 *
 * Side effect: uploads the thumbnail through `upload` (encrypted for an encrypted room).
 */
async function encryptedThumbnail(
  upload: Uploader,
  image: Buffer,
  width: number | undefined,
  height: number | undefined,
): Promise<Record<string, unknown>> {
  if (width && height && width <= THUMBNAIL_MAX_SIDE && height <= THUMBNAIL_MAX_SIDE) return {};
  const thumbnail = await makeThumbnail(image);
  if (!thumbnail || thumbnail.buffer.byteLength >= image.byteLength) return {};
  try {
    const uploaded = await upload(thumbnail.buffer, { type: 'image/jpeg', name: 'thumbnail.jpg' });
    if (!('file' in uploaded)) return {};
    return {
      thumbnail_file: uploaded.file,
      thumbnail_info: {
        mimetype: 'image/jpeg',
        size: thumbnail.buffer.byteLength,
        w: thumbnail.width,
        h: thumbnail.height,
      },
    };
  } catch (err) {
    console.warn(`[media] thumbnail upload failed: ${errorMessage(err)}`);
    return {};
  }
}

/**
 * com.beeper.linkpreviews entry (mautrix BeeperLinkPreview shape). The thumbnail is
 * uploaded when it still downloads; a preview without an image is still shown. For an
 * encrypted upload the mxc and its key go into `beeper:image:encryption` and `og:image`
 * stays unset, as mautrix does.
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
      const uploaded = await upload(image.buffer, {
        type: image.mimetype,
        name: `preview.${fileExtensionFor(image.mimetype)}`,
      });
      if ('file' in uploaded) previewEntry['beeper:image:encryption'] = uploaded.file;
      else previewEntry['og:image'] = uploaded.url;
      previewEntry['og:image:type'] = image.mimetype;
      previewEntry['matrix:image:size'] = image.buffer.byteLength;
    }
  }
  return previewEntry;
}
