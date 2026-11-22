import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { InboundHandler } from '../inbound-handler.ts';
import { MappingStore } from '../mapping-store.ts';
import type { ZaloMessage } from '../../zalo/types.ts';

const ROOM = '!r:x';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** Handler in a plain DM room whose sends and redactions are recorded. */
function setup() {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: ROOM, name: null });
  const sent: Array<{ type: string; content: Record<string, unknown> }> = [];
  const redacted: Array<{ eventId: string; by: string }> = [];
  const send = async (type: string, content: Record<string, unknown>) => {
    sent.push({ type, content });
    return { event_id: `$ev${sent.length}` };
  };
  const makeIntent = (name: string) => ({
    opts: {},
    uploadContent: vi.fn(async () => 'mxc://hs/1'),
    sendEvent: (_roomId: string, type: string, content: Record<string, unknown>) => send(type, content),
    sendMessage: (_roomId: string, content: Record<string, unknown>) => send('m.room.message', content),
    matrixClient: {
      redactEvent: vi.fn(async (_roomId: string, eventId: string) => {
        redacted.push({ eventId, by: name });
        return '$redaction';
      }),
    },
  });
  const ghost = makeIntent('ghost');
  const bot = makeIntent('bot');
  const onMediaFailure = vi.fn();
  const deps = {
    bridge: { getIntent: () => bot },
    store,
    puppets: {
      ensurePuppet: vi.fn(async () => ghost),
      intentFor: vi.fn(() => ghost),
      mxidFor: (uid: string) => `@zalo_${uid}:x`,
    },
    portals: {
      getOrCreatePortal: vi.fn(async () => store.getPortalByThread('t1')),
      ensureGhostInRoom: vi.fn(),
    },
    echo: new EchoSuppressor(),
    ownerUserId: '@owner:x',
    mediaMaxBytes: 1 << 20,
    resolveGroupName: async () => null,
    resolveStickerUrl: async () => null,
    getOwnZaloId: () => 'me',
    bridgedEventIds: new Set<string>(),
    onMediaFailure,
  };
  const handler = new InboundHandler(deps as never);
  const message = (url: string): ZaloMessage => ({
    msgId: 'm1',
    threadId: 't1',
    threadType: 'user',
    senderId: 't1',
    timestamp: 1,
    isSelf: false,
    content: { kind: 'media', media: { kind: 'file', urls: [url], filename: 'a.pdf' } },
  });
  const process = (msg: ZaloMessage) => (handler as unknown as { process(m: ZaloMessage): Promise<void> }).process(msg);
  return { store, handler, sent, redacted, onMediaFailure, message, process };
}

/** Serves 403 for urls containing "dead" and a PNG otherwise. */
function serve() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    String(input).includes('dead')
      ? new Response('no', { status: 403 })
      : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('InboundHandler media repair', () => {
  it('posts a notice without the signed link and reports the failure', async () => {
    serve();
    const t = setup();
    await t.process(t.message('https://f1.zdn.vn/dead/a.pdf?sig=secret'));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.content).toMatchObject({ msgtype: 'm.notice', body: '[Zalo file could not be bridged: a.pdf]' });
    expect(JSON.stringify(t.sent[0]!.content)).not.toContain('sig=secret');
    expect(t.store.getOpenMediaFailure('m1')).toMatchObject({ roomId: ROOM, eventId: '$ev1', kind: 'file' });
    expect(t.onMediaFailure).toHaveBeenCalledWith(expect.objectContaining({ msgId: 'm1' }));
  });

  it('replaces the notice with the file, repoints the mapping and redacts as the ghost', async () => {
    serve();
    const t = setup();
    await t.process(t.message('https://f1.zdn.vn/dead/a.pdf'));
    await expect(t.handler.repairMedia(t.message('https://f1.zdn.vn/ok/a.pdf'))).resolves.toEqual({
      status: 'repaired',
    });
    expect(t.sent[1]!.content).toMatchObject({ msgtype: 'm.file', url: 'mxc://hs/1' });
    expect(t.store.getEventIdByMsgId('m1')).toBe('$ev2');
    expect(t.store.getOpenMediaFailure('m1')).toBeNull();
    expect(t.store.listOpenMediaFailures()).toEqual([]);
    expect(t.redacted).toEqual([{ eventId: '$ev1', by: 'ghost' }]);
  });

  it('leaves the failure open while the download still fails', async () => {
    serve();
    const t = setup();
    await t.process(t.message('https://f1.zdn.vn/dead/a.pdf'));
    const outcome = await t.handler.repairMedia(t.message('https://f1.zdn.vn/dead/a.pdf'));
    expect(outcome.status).toBe('failed');
    expect(t.sent).toHaveLength(1);
    expect(t.redacted).toEqual([]);
    expect(t.store.getOpenMediaFailure('m1')).not.toBeNull();
  });

  it('reports closed when nothing is left to repair', async () => {
    serve();
    const t = setup();
    await expect(t.handler.repairMedia(t.message('https://f1.zdn.vn/ok/a.pdf'))).resolves.toEqual({
      status: 'closed',
    });
    expect(t.sent).toEqual([]);
  });
});
