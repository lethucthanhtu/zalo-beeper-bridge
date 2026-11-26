import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { InboundHandler } from '../inbound-handler.ts';
import { MappingStore } from '../mapping-store.ts';
import type { ZaloMessage } from '../../zalo/types.ts';

/** Handler wired to fakes; the ghost's send takes `sendMs` real milliseconds. */
function setup(sendMs: number) {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 'alice', thread_type: 'user', room_id: '!dm:x', name: null });
  const ghost = {
    sendMessage: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, sendMs));
      return { event_id: '$e' };
    }),
  };
  const handler = new InboundHandler({
    bridge: { getIntent: vi.fn() },
    store,
    puppets: { ensurePuppet: vi.fn(async () => ghost), mxidFor: vi.fn(() => '@zalo_alice:x') },
    portals: { getOrCreatePortal: vi.fn(async () => store.getPortalByThread('alice')), ensureGhostInRoom: vi.fn() },
    echo: new EchoSuppressor(),
    ownerUserId: '@owner:beeper.com',
    mediaMaxBytes: 1,
    resolveGroupName: async () => null,
    resolveStickerUrl: async () => null,
    getOwnZaloId: () => 'me',
    bridgedEventIds: new Set<string>(),
  } as never);
  const message = {
    msgId: 'm1',
    threadId: 'alice',
    threadType: 'user',
    senderId: 'alice',
    senderName: 'Alice Secret',
    isSelf: false,
    content: { kind: 'text', text: 'private words' },
  } as unknown as ZaloMessage;
  /** Waits until the message is recorded, then a little longer for the timing line. */
  const drain = async () => {
    for (let i = 0; i < 100 && !store.hasMessage('m1'); i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
  };
  return { handler, message, drain };
}

describe('InboundHandler: slow-message timing line', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('logs one [timing] line with the phases and no message content when the message is slow', async () => {
    vi.stubEnv('BRIDGE_SLOW_MS', '20');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { handler, message, drain } = setup(60);
    handler.handle(message);
    await drain();
    const lines = log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[timing]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[timing\] in user text msg=m1 total=\d+ms .*send=\d+ms/);
    expect(lines[0]).not.toContain('private words');
    expect(lines[0]).not.toContain('Alice');
  });

  it('stays silent for a fast message', async () => {
    vi.stubEnv('BRIDGE_SLOW_MS', '60000');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { handler, message, drain } = setup(0);
    handler.handle(message);
    await drain();
    expect(log).not.toHaveBeenCalled();
  });
});
