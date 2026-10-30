// Animated Zalo stickers. Zalo's sticker_detail returns stickerWebpUrl = null for classic
// stickers (only a still PNG + a sprite strip), so there is nothing animated to download:
// Zalo PC itself animates them by stepping through the public sprite strip
//   https://zalo-api.zadn.vn/api/emoticon/sprite?eid=<id>&size=130   (N frames of 130×130)
// every `duration` ms (module "+ou9": setInterval(…, duration || 250)). We do the same and
// encode the frames as a looping animated WebP, which Beeper plays as an m.sticker.
// Frames = sprite width / height. Frame timing comes from assets/zalo-sticker-timing.json
// ({id: [totalFrames, durationMs]}, dumped once from Zalo PC's Core.Sticker table), else
// the medians of that table (≤6 frames 300 ms, ≤24 100 ms, more 60 ms).
// Used by the live bridge and the history importer; needs no Zalo session.
import fs from 'node:fs';
import { inflateSync } from 'node:zlib';
// wasm-webp's package entry uses an extensionless ESM import Node rejects — load the
// emscripten factory directly (the same thing the package's wrapper calls)
// @ts-expect-error -- untyped emscripten module
import WebpWasm from 'wasm-webp/dist/esm/webp-wasm.js';

/** One frame handed to wasm-webp's animation encoder (RGBA pixels + display time). */
type WebpFrame = {
  data: Uint8Array;
  duration: number;
  config: { lossless: number; quality: number };
  has_config: boolean;
};

/** The subset of the wasm-webp emscripten module this file uses. */
type WebpModule = {
  VectorWebPAnimationFrame: new () => { push_back(frame: WebpFrame): void; delete?: () => void };
  encodeAnimation(width: number, height: number, alpha: boolean, frames: unknown): Uint8Array | null;
};

/** An encoded animated sticker, ready to upload as an m.sticker. */
export type StickerImage = {
  buffer: Buffer;
  mimetype: string;
  width: number;
  height: number;
  frames: number;
};

/** Public sprite strip of a sticker (all frames side by side, 130 px high). */
const SPRITE_URL = (id: number) => `https://zalo-api.zadn.vn/api/emoticon/sprite?eid=${id}&size=130`;
const FETCH_TIMEOUT_MS = 15_000;

/** The wasm encoder, instantiated lazily on the first animated sticker. */
let webpModulePromise: Promise<WebpModule> | null = null;
/** Per-sticker timing table: undefined = not loaded yet, null = file missing/unreadable. */
let stickerTiming: Record<string, [number, number]> | null | undefined;

/**
 * Display time of one frame of sticker `id`. Reads the timing table from
 * assets/zalo-sticker-timing.json once (synchronous file read on first call, cached in
 * module state); stickers missing from it get the table's medians by frame count.
 *
 * @param frames number of frames in the sprite strip (selects the median fallback)
 * @returns frame duration in milliseconds
 */
function frameMsFor(id: number, frames: number): number {
  if (stickerTiming === undefined) {
    try {
      stickerTiming = JSON.parse(
        fs.readFileSync(new URL('../../assets/zalo-sticker-timing.json', import.meta.url), 'utf8'),
      ) as Record<string, [number, number]>;
    } catch {
      stickerTiming = null; // optional — fall back to the medians
    }
  }
  const durationMs = stickerTiming?.[String(id)]?.[1];
  if (durationMs && durationMs > 0) return durationMs;
  return frames <= 6 ? 300 : frames <= 24 ? 100 : 60;
}

/**
 * Minimal PNG → RGBA8 decoder (8-bit, colour types 0/2/3/4/6, non-interlaced) — enough for Zalo sprites.
 * Avoids pulling in an image library just to slice sprite strips.
 *
 * @param pngBytes the complete PNG file
 * @returns image size and its pixels as tightly packed RGBA bytes
 * @throws when the data is not a PNG, or uses a bit depth, interlacing or colour type
 *   this decoder does not handle
 */
export function decodePng(pngBytes: Buffer): { width: number; height: number; rgba: Uint8Array } {
  if (pngBytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const imageDataChunks: Buffer[] = [];
  while (offset < pngBytes.length) {
    const chunkLength = pngBytes.readUInt32BE(offset);
    const chunkType = pngBytes.toString('latin1', offset + 4, offset + 8);
    const chunkData = pngBytes.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      depth = chunkData.readUInt8(8);
      colourType = chunkData.readUInt8(9);
      interlace = chunkData.readUInt8(12);
    } else if (chunkType === 'PLTE') palette = chunkData;
    else if (chunkType === 'tRNS') transparency = chunkData;
    else if (chunkType === 'IDAT') imageDataChunks.push(chunkData);
    else if (chunkType === 'IEND') break;
    offset += 12 + chunkLength;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG depth=${depth} interlace=${interlace}`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colourType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colourType}`);

  // Undo the per-row PNG filters (none / sub / up / average / paeth)
  const filtered = inflateSync(Buffer.concat(imageDataChunks));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  let previousRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)] ?? 0;
    const filteredRow = filtered.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const currentRow = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      // a / b / c / p / pa / pb / pc are the names the PNG spec uses for the filter inputs:
      // left, above, upper-left neighbour bytes and the Paeth predictor terms
      const a = x >= channels ? (currentRow[x - channels] ?? 0) : 0;
      const b = previousRow[x] ?? 0;
      const c = x >= channels ? (previousRow[x - channels] ?? 0) : 0;
      let value = filteredRow[x] ?? 0;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      currentRow[x] = value & 255;
    }
    previousRow = currentRow;
  }
  if (colourType === 6) return { width, height, rgba: pixels };

  const rgba = new Uint8Array(width * height * 4);
  /** Byte `i` of `bytes`, 0 when out of range or the chunk is absent. */
  const byteAt = (bytes: Uint8Array | null, i: number) => bytes?.[i] ?? 0;
  for (let i = 0; i < width * height; i++) {
    let red: number;
    let green: number;
    let blue: number;
    let alpha = 255;
    if (colourType === 0) {
      red = green = blue = byteAt(pixels, i);
      if (transparency && transparency.readUInt16BE(0) === red) alpha = 0;
    } else if (colourType === 4) {
      red = green = blue = byteAt(pixels, i * 2);
      alpha = byteAt(pixels, i * 2 + 1);
    } else if (colourType === 2) {
      red = byteAt(pixels, i * 3);
      green = byteAt(pixels, i * 3 + 1);
      blue = byteAt(pixels, i * 3 + 2);
    } else {
      const paletteIndex = byteAt(pixels, i);
      red = byteAt(palette, paletteIndex * 3);
      green = byteAt(palette, paletteIndex * 3 + 1);
      blue = byteAt(palette, paletteIndex * 3 + 2);
      if (transparency && paletteIndex < transparency.length) alpha = byteAt(transparency, paletteIndex);
    }
    rgba.set([red, green, blue, alpha], i * 4);
  }
  return { width, height, rgba };
}

/**
 * Encodes frames as a looping animated WebP with alpha. Loads the wasm module on first
 * use (cached in module state) and frees the native frame vector afterwards.
 *
 * @returns the WebP bytes, or null when the encoder reports failure
 */
async function encodeAnimation(width: number, height: number, frames: WebpFrame[]): Promise<Uint8Array | null> {
  const webpModule = await (webpModulePromise ??= (WebpWasm as () => Promise<WebpModule>)());
  const frameVector = new webpModule.VectorWebPAnimationFrame();
  for (const frame of frames) frameVector.push_back(frame);
  try {
    return webpModule.encodeAnimation(width, height, true, frameVector);
  } finally {
    frameVector.delete?.();
  }
}

/**
 * Sprite strip → looping animated WebP; null for single-frame stickers, a missing sprite (non-2xx),
 * or a strip that is not a whole number of square frames.
 * Downloads the public sprite (network), cuts it into square frames of the strip's height
 * and encodes them with the sticker's frame timing.
 *
 * @throws on network/decode errors, or when the WebP encoder fails
 */
async function build(id: number): Promise<StickerImage | null> {
  const response = await fetch(SPRITE_URL(id), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;
  const { width, height, rgba } = decodePng(Buffer.from(await response.arrayBuffer()));
  const frames = Math.round(width / height);
  if (frames <= 1 || frames * height !== width) return null;
  const frameMs = frameMsFor(id, frames);
  const webpFrames: WebpFrame[] = [];
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    const data = new Uint8Array(height * height * 4);
    for (let y = 0; y < height; y++) {
      const start = (y * width + frameIndex * height) * 4;
      data.set(rgba.subarray(start, start + height * 4), y * height * 4);
    }
    webpFrames.push({ data, duration: frameMs, config: { lossless: 1, quality: 75 }, has_config: true });
  }
  const encoded = await encodeAnimation(height, height, webpFrames);
  if (!encoded) throw new Error(`webp encode failed for sticker ${id}`);
  return { buffer: Buffer.from(encoded), mimetype: 'image/webp', width: height, height, frames };
}

/** One build per sticker id for the process lifetime (a still sticker caches as null). */
const animatedStickerCache = new Map<number, Promise<StickerImage | null>>();

/**
 * Animated WebP for a multi-frame sticker (cached per id); null → use the still image.
 * Never rejects: a build error yields null and is not cached, so a transient CDN
 * failure doesn't freeze that sticker as a still image until restart.
 */
export function animatedSticker(id: number): Promise<StickerImage | null> {
  let pending = animatedStickerCache.get(id);
  if (!pending) {
    pending = build(id).catch(() => {
      animatedStickerCache.delete(id);
      return null;
    });
    animatedStickerCache.set(id, pending);
  }
  return pending;
}
