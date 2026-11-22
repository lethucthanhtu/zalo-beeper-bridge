import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Thumbnail } from '../image-thumbnail.ts';

const makeThumbnail = vi.fn<(image: Buffer) => Promise<Thumbnail | null>>();
vi.mock('../image-thumbnail.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../image-thumbnail.ts')>()),
  makeThumbnail: (image: Buffer) => makeThumbnail(image),
}));

const { bridgeInboundPhoto } = await import('../media-handler.ts');

// JPEG magic followed by filler: large enough that a 300-byte thumbnail is worth sending
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000)]);

afterEach(() => vi.restoreAllMocks());

describe('bridgeInboundPhoto (live photo)', () => {
  it('sends an encrypted thumbnail and a .jpg file name in an encrypted room', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
    makeThumbnail.mockResolvedValue({ buffer: Buffer.alloc(300), width: 800, height: 600 });
    const names: Array<string | undefined> = [];
    const sendMessage = vi.fn(async (_roomId: string, _content: Record<string, unknown>) => ({ event_id: '$m' }));
    const intent = {
      uploadContent: vi.fn(async (_buffer: Buffer, options: { type: string; name?: string }) => {
        names.push(options.name);
        return `mxc://hs/${names.length}`;
      }),
      sendMessage,
    } as never;

    await bridgeInboundPhoto(
      intent,
      '!r:x',
      { url: 'https://photo.zdn.vn/p.jpg', width: 1600, height: 1200 },
      1 << 20,
      undefined,
      true,
    );

    expect(names).toHaveLength(2); // photo + thumbnail (encrypted uploads carry no name)
    const content = sendMessage.mock.calls[0]![1];
    expect(content).toMatchObject({
      msgtype: 'm.image',
      body: 'zalo-photo.jpg',
      filename: 'zalo-photo.jpg',
      info: { mimetype: 'image/jpeg', w: 1600, h: 1200, thumbnail_info: { w: 800, h: 600 } },
    });
    expect((content.info as Record<string, unknown>).thumbnail_file).toMatchObject({ url: 'mxc://hs/2' });
  });
});
