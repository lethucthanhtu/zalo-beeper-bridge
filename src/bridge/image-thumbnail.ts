// Element and Beeper cannot use server-side thumbnails in encrypted rooms: without
// `info.thumbnail_file` they download and decrypt every full-size photo just to draw the
// timeline. makeThumbnail scales a photo down with ffmpeg so the bridge can attach a small
// encrypted JPEG preview, as the mautrix bridges do.
import { spawn } from 'node:child_process';
import { errorMessage } from '../error-message.ts';

/** Longest side of a thumbnail, in pixels. */
export const THUMBNAIL_MAX_SIDE = 800;

/** Upper bound for one thumbnail render. */
const THUMBNAIL_TIMEOUT_MS = 15_000;

export type Thumbnail = { buffer: Buffer; width: number; height: number };

/**
 * Width and height from a JPEG's start-of-frame segment.
 *
 * @returns the dimensions, or null when the bytes are not a JPEG with a frame header
 */
export function jpegDimensions(jpeg: Buffer): { width: number; height: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) return null;
    const marker = jpeg[offset + 1]!;
    if (marker === 0xff) {
      offset++; // fill byte
      continue;
    }
    const length = jpeg.readUInt16BE(offset + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > jpeg.length) return null;
      return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * Renders a JPEG thumbnail (longest side at most {@link THUMBNAIL_MAX_SIDE}, never upscaled) of
 * the first frame of an image ffmpeg can read. Needs `ffmpeg` on PATH (installed in the
 * container image).
 *
 * Renders run one at a time: a burst of photos (a history import, a flood of live messages)
 * would otherwise start one ffmpeg each and push them past the timeout together.
 *
 * @returns the JPEG and its size, or null when ffmpeg is missing, fails or times out (logged)
 */
export function makeThumbnail(image: Buffer): Promise<Thumbnail | null> {
  const render = queue.then(() => renderThumbnail(image));
  queue = render;
  return render;
}

/** The last queued render; renders never reject. */
let queue: Promise<unknown> = Promise.resolve();

function renderThumbnail(image: Buffer): Promise<Thumbnail | null> {
  return new Promise((resolve) => {
    let settled = false;
    /** Resolves once (ffmpeg emits both `error` and `close` when it cannot start). */
    const finish = (result: Thumbnail | null, problem?: string) => {
      if (settled) return;
      settled = true;
      if (problem) console.warn(`[media] thumbnail failed: ${problem}`);
      resolve(result);
    };
    const side = String(THUMBNAIL_MAX_SIDE);
    const ffmpeg = spawn(
      'ffmpeg',
      [
        ...['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1'],
        ...['-vf', `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`],
        ...['-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'mjpeg', 'pipe:1'],
      ],
      { timeout: THUMBNAIL_TIMEOUT_MS },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    ffmpeg.on('error', (err) => finish(null, errorMessage(err)));
    ffmpeg.on('close', (code) => {
      const jpeg = Buffer.concat(chunks);
      const size = code === 0 ? jpegDimensions(jpeg) : null;
      if (size) finish({ buffer: jpeg, ...size });
      else finish(null, `ffmpeg exit ${code}: ${stderr.trim().slice(0, 200)}`);
    });
    ffmpeg.stdin.on('error', () => undefined); // EPIPE when ffmpeg exits before reading everything
    ffmpeg.stdin.end(image);
  });
}
