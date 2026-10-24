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
import fs from "node:fs";
import { inflateSync } from "node:zlib";
// wasm-webp's package entry uses an extensionless ESM import Node rejects — load the
// emscripten factory directly (the same thing the package's wrapper calls)
// @ts-expect-error -- untyped emscripten module
import WebpWasm from "wasm-webp/dist/esm/webp-wasm.js";

interface WebpFrame {
  data: Uint8Array;
  duration: number;
  config: { lossless: number; quality: number };
  has_config: boolean;
}

interface WebpModule {
  VectorWebPAnimationFrame: new () => { push_back(frame: WebpFrame): void; delete?: () => void };
  encodeAnimation(width: number, height: number, alpha: boolean, frames: unknown): Uint8Array | null;
}

export interface StickerImage {
  buffer: Buffer;
  mimetype: string;
  width: number;
  height: number;
  frames: number;
}

const SPRITE_URL = (id: number) => `https://zalo-api.zadn.vn/api/emoticon/sprite?eid=${id}&size=130`;
const FETCH_TIMEOUT_MS = 15_000;

let webp: Promise<WebpModule> | null = null;
let timing: Record<string, [number, number]> | null | undefined;

function frameMsFor(id: number, frames: number): number {
  if (timing === undefined) {
    try {
      timing = JSON.parse(fs.readFileSync(new URL("../../assets/zalo-sticker-timing.json", import.meta.url), "utf8")) as Record<string, [number, number]>;
    } catch {
      timing = null; // optional — fall back to the medians
    }
  }
  const ms = timing?.[String(id)]?.[1];
  if (ms && ms > 0) return ms;
  return frames <= 6 ? 300 : frames <= 24 ? 100 : 60;
}

/** Minimal PNG → RGBA8 decoder (8-bit, colour types 0/2/3/4/6, non-interlaced) — enough for Zalo sprites. */
export function decodePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let o = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    const d = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
      depth = d.readUInt8(8);
      colourType = d.readUInt8(9);
      interlace = d.readUInt8(12);
    } else if (type === "PLTE") plte = d;
    else if (type === "tRNS") trns = d;
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG depth=${depth} interlace=${interlace}`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colourType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colourType}`);

  // Undo the per-row PNG filters (none / sub / up / average / paeth)
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (cur[x - channels] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= channels ? (prev[x - channels] ?? 0) : 0;
      let v = src[x] ?? 0;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  if (colourType === 6) return { width, height, rgba: px };

  const rgba = new Uint8Array(width * height * 4);
  const at = (arr: Uint8Array | null, i: number) => arr?.[i] ?? 0;
  for (let i = 0; i < width * height; i++) {
    let r: number;
    let g: number;
    let b: number;
    let alpha = 255;
    if (colourType === 0) {
      r = g = b = at(px, i);
      if (trns && trns.readUInt16BE(0) === r) alpha = 0;
    } else if (colourType === 4) {
      r = g = b = at(px, i * 2);
      alpha = at(px, i * 2 + 1);
    } else if (colourType === 2) {
      r = at(px, i * 3);
      g = at(px, i * 3 + 1);
      b = at(px, i * 3 + 2);
    } else {
      const k = at(px, i);
      r = at(plte, k * 3);
      g = at(plte, k * 3 + 1);
      b = at(plte, k * 3 + 2);
      if (trns && k < trns.length) alpha = at(trns, k);
    }
    rgba.set([r, g, b, alpha], i * 4);
  }
  return { width, height, rgba };
}

async function encodeAnimation(width: number, height: number, frames: WebpFrame[]): Promise<Uint8Array | null> {
  const m = await (webp ??= (WebpWasm as () => Promise<WebpModule>)());
  const vec = new m.VectorWebPAnimationFrame();
  for (const f of frames) vec.push_back(f);
  try {
    return m.encodeAnimation(width, height, true, vec);
  } finally {
    vec.delete?.();
  }
}

/** Sprite strip → looping animated WebP; null for single-frame stickers or a missing sprite. */
async function build(id: number): Promise<StickerImage | null> {
  const res = await fetch(SPRITE_URL(id), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const { width, height, rgba } = decodePng(Buffer.from(await res.arrayBuffer()));
  const frames = Math.round(width / height);
  if (frames <= 1 || frames * height !== width) return null;
  const frameMs = frameMsFor(id, frames);
  const out: WebpFrame[] = [];
  for (let f = 0; f < frames; f++) {
    const data = new Uint8Array(height * height * 4);
    for (let y = 0; y < height; y++) {
      const start = (y * width + f * height) * 4;
      data.set(rgba.subarray(start, start + height * 4), y * height * 4);
    }
    out.push({ data, duration: frameMs, config: { lossless: 1, quality: 75 }, has_config: true });
  }
  const encoded = await encodeAnimation(height, height, out);
  if (!encoded) throw new Error(`webp encode failed for sticker ${id}`);
  return { buffer: Buffer.from(encoded), mimetype: "image/webp", width: height, height, frames };
}

const cache = new Map<number, Promise<StickerImage | null>>();

/** Animated WebP for a multi-frame sticker (cached per id); null → use the still image. */
export function animatedSticker(id: number): Promise<StickerImage | null> {
  let p = cache.get(id);
  if (!p) {
    p = build(id).catch(() => null);
    cache.set(id, p);
  }
  return p;
}
