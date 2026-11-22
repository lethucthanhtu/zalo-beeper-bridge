import { describe, expect, it, vi } from 'vitest';

vi.mock('../media-fetch.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media-fetch.ts')>()),
  downloadMatrixMedia: vi.fn(async () => ({ buffer: Buffer.from('ciphertext'), mimetype: 'application/octet-stream' })),
}));

import { EchoSuppressor } from '../echo-suppressor.ts';
import { MappingStore } from '../mapping-store.ts';
import { OutboundHandler } from '../outbound-handler.ts';

const OWNER = '@owner:beeper.com';

function setup(decryptAttachment?: (data: Buffer, file: unknown) => Buffer) {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!dm:x', name: null });
  const noticeSend = vi.fn().mockResolvedValue({ event_id: '$n' });
  const zalo = { ownId: 'me', sendFile: vi.fn().mockResolvedValue(['z1']) };
  const outbound = new OutboundHandler({
    bridge: { getIntent: () => ({ sendMessage: noticeSend }) },
    store,
    puppets: { intentFor: vi.fn(), uidFor: vi.fn() },
    zalo,
    echo: new EchoSuppressor(),
    ownerUserId: OWNER,
    mediaMaxBytes: 1_000_000,
    homeserverUrl: 'http://hs',
    matrixToken: 'tok',
    decryptAttachment,
    bridgedEventIds: new Set<string>(),
  } as never);
  return { store, zalo, noticeSend, outbound };
}

const file = { url: 'mxc://x/enc', key: { k: 'k' }, iv: 'iv', hashes: { sha256: 'h' }, v: 'v2' };
const fileEvent = {
  type: 'm.room.message',
  room_id: '!dm:x',
  sender: OWNER,
  event_id: '$f1',
  content: { msgtype: 'm.file', body: 'doc.pdf', info: { mimetype: 'application/pdf' }, file },
} as never;

describe('outbound media from an encrypted room', () => {
  it('decrypts the downloaded attachment before sending it to Zalo', async () => {
    const decrypt = vi.fn(() => Buffer.from('plaintext'));
    const t = setup(decrypt);
    await t.outbound.handle(fileEvent);
    expect(decrypt).toHaveBeenCalledWith(Buffer.from('ciphertext'), file);
    expect(t.zalo.sendFile).toHaveBeenCalledWith('t1', 'user', Buffer.from('plaintext'), expect.any(String), '');
    t.store.close();
  });

  it('posts a notice instead of sending ciphertext when no decryptor is configured', async () => {
    const t = setup();
    await t.outbound.handle(fileEvent);
    expect(t.zalo.sendFile).not.toHaveBeenCalled();
    expect(t.noticeSend).toHaveBeenCalled();
    t.store.close();
  });
});
