import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { jpegDimensions, makeThumbnail } from '../image-thumbnail.ts';

// The container image and GitHub's ubuntu runners ship ffmpeg; skip where it is missing
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** A solid-colour test image of the given size, encoded by ffmpeg as PNG or JPEG. */
const testImage = (width: number, height: number, codec: 'png' | 'mjpeg') =>
  spawnSync('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=red:s=${width}x${height}`],
    ...['-frames:v', '1', '-c:v', codec, '-f', 'image2pipe', 'pipe:1'],
  ]).stdout;

describe('jpegDimensions', () => {
  it('reads width and height from the SOF0 segment after other segments', () => {
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20];
    expect(jpegDimensions(Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0, 0]))).toEqual({ width: 800, height: 600 });
  });

  it('rejects bytes that are not a JPEG or have no frame header', () => {
    expect(jpegDimensions(Buffer.from('not a jpeg'))).toBeNull();
    expect(jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]))).toBeNull();
  });
});

describe('makeThumbnail', () => {
  it.skipIf(!hasFfmpeg)('scales the longest side down to 800 px and keeps the aspect ratio', async () => {
    const thumb = await makeThumbnail(testImage(2000, 1000, 'png'));
    expect(thumb).toMatchObject({ width: 800, height: 400 });
    expect(jpegDimensions(thumb!.buffer)).toEqual({ width: 800, height: 400 });
  });

  it.skipIf(!hasFfmpeg)('never upscales a small photo', async () => {
    expect(await makeThumbnail(testImage(300, 200, 'mjpeg'))).toMatchObject({ width: 300, height: 200 });
  });

  it.skipIf(!hasFfmpeg)('returns null for bytes ffmpeg cannot decode', async () => {
    expect(await makeThumbnail(Buffer.from('not an image at all'))).toBeNull();
  });
});
