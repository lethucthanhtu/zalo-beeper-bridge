import { describe, expect, it, vi } from 'vitest';

const M4A = Buffer.from('\0\0\0\x1cftypM4A \0\0\0\0');
const ADTS = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]);

vi.mock('../media-fetch.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media-fetch.ts')>()),
  downloadMatrixMedia: vi.fn(async () => ({ buffer: M4A, mimetype: 'audio/mp4' })),
}));
const transcode = vi.fn<(audio: Buffer) => Promise<Buffer | null>>();
vi.mock('../audio-remux.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audio-remux.ts')>()),
  transcodeToAac: (audio: Buffer) => transcode(audio),
}));

import { EchoSuppressor } from '../echo-suppressor.ts';
import { MappingStore } from '../mapping-store.ts';
import { OutboundHandler } from '../outbound-handler.ts';

const OWNER = '@owner:beeper.com';

function setup() {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!dm:x', name: null });
  const zalo = {
    ownId: 'me',
    sendVoice: vi.fn().mockResolvedValue(['z1']),
    sendFile: vi.fn().mockResolvedValue(['z2']),
  };
  const outbound = new OutboundHandler({
    bridge: { getIntent: () => ({ sendMessage: vi.fn().mockResolvedValue({ event_id: '$n' }) }) },
    store,
    puppets: { intentFor: vi.fn(), uidFor: vi.fn() },
    zalo,
    echo: new EchoSuppressor(),
    ownerUserId: OWNER,
    mediaMaxBytes: 1_000_000,
    homeserverUrl: 'http://hs',
    matrixToken: 'tok',
    bridgedEventIds: new Set<string>(),
  } as never);
  return { store, zalo, outbound };
}

const voiceEvent = {
  type: 'm.room.message',
  room_id: '!dm:x',
  sender: OWNER,
  event_id: '$v1',
  content: {
    msgtype: 'm.audio',
    body: 'Voice message',
    url: 'mxc://x/voice',
    info: { mimetype: 'audio/mp4' },
    'org.matrix.msc3245.voice': {},
  },
} as never;

describe('outbound voice notes', () => {
  it('re-encodes a Beeper iOS M4A voice note to ADTS AAC, the format Zalo plays', async () => {
    transcode.mockResolvedValueOnce(ADTS);
    const t = setup();
    await t.outbound.handle(voiceEvent);
    expect(transcode).toHaveBeenCalledWith(M4A);
    expect(t.zalo.sendVoice).toHaveBeenCalledWith('t1', 'user', ADTS, 'voice.aac');
    t.store.close();
  });

  it('falls back to sending the M4A as is when ffmpeg is unavailable', async () => {
    transcode.mockResolvedValueOnce(null);
    const t = setup();
    await t.outbound.handle(voiceEvent);
    expect(t.zalo.sendVoice).toHaveBeenCalledWith('t1', 'user', M4A, 'voice.m4a');
    t.store.close();
  });
});
