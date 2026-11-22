import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { animatedSticker, decodePng } from '../animated-sticker.ts';

/** CRC-less PNG chunk: decodePng does not check CRCs, so zeros are enough. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

/** Grey 8-bit PNG of the given size; `idat` overrides the compressed pixel data. */
function png(width: number, height: number, idat?: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // depth
  header.writeUInt8(0, 9); // colour type: greyscale
  const raw = Buffer.alloc((width + 1) * height); // filter byte 0 + zero pixels per row
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', idat ?? deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

afterEach(() => vi.restoreAllMocks());

describe('decodePng', () => {
  it('decodes a small greyscale PNG to RGBA', () => {
    const { width, height, rgba } = decodePng(png(3, 2));
    expect([width, height, rgba.length]).toEqual([3, 2, 3 * 2 * 4]);
  });

  it('refuses an image whose declared size is over the pixel cap', () => {
    expect(() => decodePng(png(100_000, 1_000, deflateSync(Buffer.alloc(10))))).toThrow(/too large/);
  });

  it('refuses pixel data that inflates past the declared size (decompression bomb)', () => {
    expect(() => decodePng(png(2, 2, deflateSync(Buffer.alloc(1_000_000))))).toThrow();
  });
});

describe('animatedSticker', () => {
  it('rejects an oversize sprite download and retries it later instead of caching', async () => {
    // A valid 2-frame sprite padded past the cap: without the cap it would build and be cached
    const padded = Buffer.concat([png(2, 1), Buffer.alloc(6 * 1024 * 1024)]);
    const huge = new Response(padded, { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(huge);
    expect(await animatedSticker(9_000_001)).toBeNull();
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await animatedSticker(9_000_001)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // the failed build was not cached
  });

  it('caches a missing sprite (404) as a still sticker', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    expect(await animatedSticker(9_000_002)).toBeNull();
    expect(await animatedSticker(9_000_002)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
