import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { InboundHandler } from '../inbound-handler.ts';
import { MappingStore } from '../mapping-store.ts';
import { SELF_BRIDGE_MARKER } from '../self-bridge.ts';
import { installEncryptedSend, type RoomEncryption, type SendingClient } from '../../matrix/crypto.ts';
import type { ZaloContent, ZaloMessage } from '../../zalo/types.ts';

vi.mock('../animated-sticker.ts', () => ({ animatedSticker: vi.fn(async () => null) }));

const ROOM = '!enc:x';
const OWNER = '@owner:beeper.com';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

type Sent = { type: string; content: Record<string, unknown> };

/**
 * Handler wired to a room where every send goes through the real installEncryptedSend patch,
 * so `encrypted` holds what reached the encryption (the plaintext content) and `raw` what
 * would go on the wire.
 */
function setup(options: { encrypted: boolean } = { encrypted: true }) {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: ROOM, name: null });
  store.recordMessage('m0', ROOM, '$parent', 'inbound', null, 'cli0', 't1');

  const encrypted: Sent[] = [];
  const raw: Sent[] = [];
  const uploads: Array<{ buffer: Buffer; type: string }> = [];
  const client = {
    sendEvent: vi.fn(async (_roomId: string, type: string, content: unknown) => {
      raw.push({ type, content: content as Record<string, unknown> });
      return `$ev${raw.length}`;
    }),
    sendRawEvent: vi.fn(async (_roomId: string, type: string, content: unknown) => {
      raw.push({ type, content: content as Record<string, unknown> });
      return `$ev${raw.length}`;
    }),
  } as unknown as SendingClient;
  const rooms = {
    isEncrypted: vi.fn(async () => options.encrypted),
    encrypt: vi.fn(async (_roomId: string, type: string, content: unknown) => {
      encrypted.push({ type, content: content as Record<string, unknown> });
      return { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'c' };
    }),
  } as unknown as RoomEncryption;
  installEncryptedSend(client, rooms);

  const send = async (type: string, content: Record<string, unknown>) => ({
    event_id: await client.sendEvent(ROOM, type, content),
  });
  const intent = {
    opts: {},
    uploadContent: vi.fn(async (buffer: Buffer, uploadOptions: { type: string }) => {
      uploads.push({ buffer, type: uploadOptions.type });
      return `mxc://hs/${uploads.length}`;
    }),
    sendEvent: (_roomId: string, type: string, content: Record<string, unknown>) => send(type, content),
    sendMessage: (_roomId: string, content: Record<string, unknown>) => send('m.room.message', content),
  };

  const deps = {
    bridge: { getIntent: () => intent },
    store,
    puppets: {
      ensurePuppet: vi.fn(async () => intent),
      mxidFor: (uid: string) => `@zalo_${uid}:x`,
    },
    portals: {
      getOrCreatePortal: vi.fn(async () => ({ room_id: ROOM })),
      ensureGhostInRoom: vi.fn(),
    },
    echo: new EchoSuppressor(),
    ownerUserId: OWNER,
    mediaMaxBytes: 1 << 20,
    resolveGroupName: async () => null,
    resolveStickerUrl: async () => 'https://sticker.zdn.vn/s.png',
    getOwnZaloId: () => 'me',
    bridgedEventIds: new Set<string>(),
    isEncrypted: (roomId: string) => rooms.isEncrypted(roomId),
  };
  const handler = new InboundHandler(deps as never);
  let counter = 0;
  const process = (content: ZaloContent, over: Partial<ZaloMessage> = {}) =>
    (handler as unknown as { process(message: ZaloMessage): Promise<void> }).process({
      msgId: `m${++counter}1`,
      threadId: 't1',
      threadType: 'user',
      senderId: 't1',
      timestamp: 1,
      isSelf: false,
      content,
      ...over,
    });
  return { process, encrypted, raw, uploads, intent, store };
}

afterEach(() => vi.restoreAllMocks());

function serveImage() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
  );
}

describe('InboundHandler in an encrypted room', () => {
  it('sends text, mentions and a reply inside the ciphertext', async () => {
    const t = setup();
    await t.process(
      { kind: 'text', text: 'hi Ann' },
      { replyToMsgId: 'm0', mentions: [{ uid: 'a1', pos: 3, len: 3 }] },
    );
    expect(t.raw.map((e) => e.type)).toEqual(['m.room.encrypted']);
    expect(t.raw[0]!.content).not.toHaveProperty('body');
    expect(t.encrypted[0]).toMatchObject({
      type: 'm.room.message',
      content: {
        msgtype: 'm.text',
        body: 'hi Ann',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } },
        'm.mentions': { user_ids: ['@zalo_a1:x'] },
        format: 'org.matrix.custom.html',
      },
    });
  });

  it('keeps notices and unsupported-message notes encrypted too', async () => {
    const t = setup();
    await t.process({ kind: 'notice', text: 'Missed call' });
    await t.process({ kind: 'unsupported', msgType: 'weird' });
    expect(t.raw.map((e) => e.type)).toEqual(['m.room.encrypted', 'm.room.encrypted']);
    expect(t.encrypted.map((e) => e.content.msgtype)).toEqual(['m.notice', 'm.notice']);
  });

  it('keeps the call tile action inside the ciphertext', async () => {
    const t = setup();
    await t.process({
      kind: 'call',
      text: 'Voice call 0:42',
      action: { type: 'call', call_type: 'voice' },
    });
    expect(t.raw.map((e) => e.type)).toEqual(['m.room.encrypted']);
    expect(t.encrypted[0]!.content).toMatchObject({
      msgtype: 'm.text',
      body: 'Voice call 0:42',
      'com.beeper.action_message': { type: 'call', call_type: 'voice' },
    });
  });

  it("marks the owner's own phone messages inside the ciphertext, so the echo is still dropped", async () => {
    const t = setup();
    await t.process({ kind: 'text', text: 'from my phone' }, { isSelf: true, senderId: 'me' });
    expect(t.raw[0]!.type).toBe('m.room.encrypted');
    expect(t.raw[0]!.content).not.toHaveProperty(SELF_BRIDGE_MARKER);
    expect(t.encrypted[0]!.content).toMatchObject({ body: 'from my phone', [SELF_BRIDGE_MARKER]: true });
  });

  it('uploads media encrypted and sends file, never url', async () => {
    serveImage();
    const t = setup();
    await t.process({
      kind: 'media',
      media: { kind: 'video', urls: ['https://v.dlmd.me/clip.mp4'], filename: 'clip.mp4' },
    });
    expect(t.uploads).toHaveLength(1);
    expect(t.uploads[0]!.type).toBe('application/octet-stream');
    expect(t.uploads[0]!.buffer.equals(PNG)).toBe(false);
    const { content } = t.encrypted[0]!;
    expect(content).not.toHaveProperty('url');
    expect(content).toMatchObject({ file: { url: 'mxc://hs/1', v: 'v2' } });
  });

  it('uploads a photo and a sticker encrypted', async () => {
    serveImage();
    const t = setup();
    await t.process({ kind: 'photo', url: 'https://p.zdn.vn/a.png' });
    await t.process({ kind: 'sticker', id: 777, catId: 1 });
    expect(t.encrypted.map((e) => e.type)).toEqual(['m.room.message', 'm.sticker']);
    for (const { content } of t.encrypted) {
      expect(content).not.toHaveProperty('url');
      expect(content).toMatchObject({ file: { v: 'v2' } });
    }
    expect(t.raw.every((e) => e.type === 'm.room.encrypted')).toBe(true);
  });

  it('puts the link preview image into beeper:image:encryption and leaves og:image out', async () => {
    serveImage();
    const t = setup();
    await t.process({
      kind: 'text',
      text: 'see https://example.com',
      linkPreview: { url: 'https://example.com', title: 'Example', imageUrl: 'https://thumb.zdn.vn/t.png' },
    });
    const [preview] = t.encrypted[0]!.content['com.beeper.linkpreviews'] as Array<Record<string, unknown>>;
    expect(preview).toMatchObject({
      matched_url: 'https://example.com',
      'og:title': 'Example',
      'beeper:image:encryption': { url: 'mxc://hs/1', v: 'v2' },
    });
    expect(preview).not.toHaveProperty('og:image');
    expect(t.uploads[0]!.type).toBe('application/octet-stream');
  });

  it('stays byte-identical in a plain room: plain events and url uploads', async () => {
    serveImage();
    const t = setup({ encrypted: false });
    await t.process({
      kind: 'text',
      text: 'plain',
      linkPreview: { url: 'https://e.com', imageUrl: 'https://t.zdn.vn/t.png' },
    });
    await t.process({ kind: 'photo', url: 'https://p.zdn.vn/a.png' });
    expect(t.encrypted).toEqual([]);
    expect(t.raw.map((e) => e.type)).toEqual(['m.room.message', 'm.room.message']);
    expect((t.raw[0]!.content['com.beeper.linkpreviews'] as unknown[])[0]).toMatchObject({ 'og:image': 'mxc://hs/1' });
    expect(t.raw[1]!.content).toMatchObject({ url: 'mxc://hs/2' });
    expect(t.raw[1]!.content).not.toHaveProperty('file');
    expect(t.uploads.every((u) => u.buffer.equals(PNG))).toBe(true);
  });
});
