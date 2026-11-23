import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptAttachment } from '../../matrix/crypto.ts';
import type { StickerMedia } from '../mapping-store.ts';
import { bridgeInboundPhoto, bridgeInboundSticker } from '../media-handler.ts';

vi.mock('../animated-sticker.ts', () => ({ animatedSticker: vi.fn(async () => null) }));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const URL = 'https://photo.zdn.vn/pic.png';

function fakeIntent() {
  const uploads: Array<{ buffer: Buffer; options: { type: string; name?: string } }> = [];
  const sendMessage = vi.fn(async (_roomId: string, _content: Record<string, unknown>) => ({ event_id: '$msg' }));
  const sendEvent = vi.fn(async (_roomId: string, _type: string, _content: Record<string, unknown>) => ({
    event_id: '$evt',
  }));
  const intent = {
    uploadContent: vi.fn(async (buffer: Buffer, options: { type: string; name?: string }) => {
      uploads.push({ buffer, options });
      return `mxc://hs/${uploads.length}`;
    }),
    sendMessage,
    sendEvent,
  };
  return { intent: intent as never, uploads, sendMessage, sendEvent };
}

afterEach(() => vi.restoreAllMocks());

function serveImage() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
  );
}

describe('bridgeInboundPhoto in an encrypted room', () => {
  it('uploads ciphertext and sends the key material as file, with no url', async () => {
    serveImage();
    const { intent, uploads, sendMessage } = fakeIntent();
    await bridgeInboundPhoto(intent, '!r:x', { url: URL, width: 4, height: 3 }, 1 << 20, undefined, true);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.options.type).toBe('application/octet-stream');
    expect(uploads[0]!.buffer.equals(PNG)).toBe(false);
    const content = sendMessage.mock.calls[0]![1] as Record<string, unknown> & {
      file: Parameters<typeof decryptAttachment>[1];
    };
    expect(content).not.toHaveProperty('url');
    expect(content).toMatchObject({ msgtype: 'm.image', info: { mimetype: 'image/png', w: 4, h: 3 } });
    expect(content.file).toMatchObject({ url: 'mxc://hs/1', v: 'v2' });
    expect(decryptAttachment(uploads[0]!.buffer, content.file).equals(PNG)).toBe(true);
  });

  it('keeps a plain room on url', async () => {
    serveImage();
    const { intent, uploads, sendMessage } = fakeIntent();
    await bridgeInboundPhoto(intent, '!r:x', { url: URL }, 1 << 20);
    expect(uploads[0]!.buffer.equals(PNG)).toBe(true);
    const content = sendMessage.mock.calls[0]![1];
    expect(content).toMatchObject({ url: 'mxc://hs/1' });
    expect(content).not.toHaveProperty('file');
  });
});

describe('bridgeInboundSticker', () => {
  it('caches a plain upload and reuses it as url', async () => {
    serveImage();
    const { intent, uploads, sendEvent } = fakeIntent();
    await bridgeInboundSticker(intent, '!a:x', 9001, URL, 1 << 20);
    await bridgeInboundSticker(intent, '!b:x', 9001, URL, 1 << 20);
    expect(uploads).toHaveLength(1);
    expect(sendEvent.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ url: 'mxc://hs/1' }),
      expect.objectContaining({ url: 'mxc://hs/1' }),
    ]);
  });

  it('keeps plain and encrypted uploads apart, and shares one encrypted upload across encrypted rooms', async () => {
    serveImage();
    const { intent, uploads, sendEvent } = fakeIntent();
    await bridgeInboundSticker(intent, '!plain:x', 9002, URL, 1 << 20); // fills the plain cache
    await bridgeInboundSticker(intent, '!enc1:x', 9002, URL, 1 << 20, undefined, true);
    await bridgeInboundSticker(intent, '!enc2:x', 9002, URL, 1 << 20, undefined, true);
    expect(uploads).toHaveLength(2); // one plain, one encrypted

    const encrypted = sendEvent.mock.calls.slice(1).map((call) => call[2]);
    for (const content of encrypted) {
      expect(content).not.toHaveProperty('url');
      expect(content).toMatchObject({
        file: { v: 'v2', url: 'mxc://hs/2' },
        info: { mimetype: 'image/png', 'fi.mau.bridged_sticker': { network: 'zalo', id: '9002' } },
      });
    }
    const [first, second] = encrypted as Array<{ file: Parameters<typeof decryptAttachment>[1] }>;
    expect(second!.file).toEqual(first!.file);
    expect(decryptAttachment(uploads[1]!.buffer, first!.file).equals(PNG)).toBe(true);

    // the encrypted upload did not poison the plain cache
    await bridgeInboundSticker(intent, '!plain2:x', 9002, URL, 1 << 20);
    expect(sendEvent.mock.calls[3]![2]).toMatchObject({ url: 'mxc://hs/1' });
  });

  it('reuses an upload from the persistent store and saves new ones to it', async () => {
    serveImage();
    const stored = new Map<string, StickerMedia>();
    const store = {
      getStickerMedia: vi.fn((id: number | string, enc: boolean) => stored.get(`${enc}:${id}`) ?? null),
      putStickerMedia: vi.fn((id: number | string, enc: boolean, media: StickerMedia) => {
        stored.set(`${enc}:${id}`, media);
      }),
    };
    stored.set('true:9004', { uploaded: { url: 'mxc://hs/earlier' } as never, mimetype: 'image/webp', size: 7 });
    const { intent, uploads, sendEvent } = fakeIntent();
    await bridgeInboundSticker(intent, '!enc:x', 9004, URL, 1 << 20, undefined, true, store);
    expect(uploads).toHaveLength(0);
    expect(sendEvent.mock.calls[0]![2]).toMatchObject({ url: 'mxc://hs/earlier', info: { mimetype: 'image/webp' } });

    await bridgeInboundSticker(intent, '!plain:x', 9005, URL, 1 << 20, undefined, false, store);
    expect(uploads).toHaveLength(1);
    expect(store.putStickerMedia).toHaveBeenCalledWith(9005, false, expect.objectContaining({ mimetype: 'image/png' }));
  });

  it('rejects a body that is not an image, and caches nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('false', { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    );
    const { intent, uploads, sendEvent } = fakeIntent();
    await expect(bridgeInboundSticker(intent, '!a:x', 9003, URL, 1 << 20)).rejects.toThrow(/not an image/);
    expect(uploads).toHaveLength(0);
    expect(sendEvent).not.toHaveBeenCalled();

    serveImage(); // a later good answer is not shadowed by a cached bad one
    await bridgeInboundSticker(intent, '!a:x', 9003, URL, 1 << 20);
    expect(sendEvent.mock.calls[0]![2]).toMatchObject({ info: { mimetype: 'image/png' } });
  });
});
