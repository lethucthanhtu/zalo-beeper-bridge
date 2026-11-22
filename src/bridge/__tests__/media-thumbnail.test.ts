import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thumbnail } from '../image-thumbnail.ts';
import type { MediaDescriptor } from '../../media-descriptor.ts';

const makeThumbnail = vi.fn<(image: Buffer) => Promise<Thumbnail | null>>();
vi.mock('../image-thumbnail.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../image-thumbnail.ts')>()),
  makeThumbnail: (image: Buffer) => makeThumbnail(image),
}));

const { buildMediaEvent } = await import('../media-content.ts');

const photo = { buffer: Buffer.alloc(5000), mimetype: 'image/jpeg', width: 1600, height: 1200 };
const thumb = { buffer: Buffer.alloc(300), width: 800, height: 600 };
const photoFile = { url: 'mxc://x/photo', v: 'v2' } as never;
const thumbFile = { url: 'mxc://x/thumb', v: 'v2' } as never;
const image: MediaDescriptor = { kind: 'image', urls: [] };

describe('buildMediaEvent thumbnails in an encrypted room', () => {
  const upload = vi.fn(async (_buffer: Buffer, options: { type: string; name: string }) => ({
    file: options.name === 'thumbnail.jpg' ? thumbFile : photoFile,
  }));

  beforeEach(() => {
    upload.mockClear();
    makeThumbnail.mockReset().mockResolvedValue(thumb);
  });

  it('attaches an encrypted JPEG thumbnail to a large photo', async () => {
    const { content } = await buildMediaEvent(upload, image, photo);
    expect(makeThumbnail).toHaveBeenCalledWith(photo.buffer);
    expect(upload).toHaveBeenCalledWith(thumb.buffer, { type: 'image/jpeg', name: 'thumbnail.jpg' });
    expect(content).toMatchObject({
      file: photoFile,
      info: {
        w: 1600,
        h: 1200,
        thumbnail_file: thumbFile,
        thumbnail_info: { mimetype: 'image/jpeg', size: 300, w: 800, h: 600 },
      },
    });
  });

  it('skips photos that already fit the thumbnail size', async () => {
    const { content } = await buildMediaEvent(upload, image, { ...photo, width: 800, height: 600 });
    expect(makeThumbnail).not.toHaveBeenCalled();
    expect(content['info']).not.toHaveProperty('thumbnail_file');
  });

  it('sends the photo without a thumbnail when rendering fails or the result is not smaller', async () => {
    makeThumbnail.mockResolvedValueOnce(null);
    const failed = await buildMediaEvent(upload, image, photo);
    expect(failed.content['info']).not.toHaveProperty('thumbnail_file');

    makeThumbnail.mockResolvedValueOnce({ ...thumb, buffer: Buffer.alloc(6000) });
    const bigger = await buildMediaEvent(upload, image, photo);
    expect(bigger.content['info']).not.toHaveProperty('thumbnail_file');
  });

  it('sends the photo without a thumbnail when the thumbnail upload fails', async () => {
    const flakyUpload = vi.fn(async (_buffer: Buffer, options: { type: string; name: string }) => {
      if (options.name === 'thumbnail.jpg') throw new Error('upload refused');
      return { file: photoFile };
    });
    const { content } = await buildMediaEvent(flakyUpload, image, photo);
    expect(content).toMatchObject({ file: photoFile });
    expect(content['info']).not.toHaveProperty('thumbnail_file');
  });

  it('does not thumbnail plain-room photos, other media kinds or reused uploads', async () => {
    await buildMediaEvent(async () => ({ url: 'mxc://x/plain' }), image, photo);
    await buildMediaEvent(upload, { kind: 'sticker', urls: [], stickerId: 1 }, photo);
    await buildMediaEvent(upload, image, photo, { uploaded: { file: photoFile } });
    expect(makeThumbnail).not.toHaveBeenCalled();
  });
});
