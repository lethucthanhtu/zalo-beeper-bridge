import { describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { InboundHandler } from '../inbound-handler.ts';
import { MappingStore } from '../mapping-store.ts';
import { normalizeZaloMessage } from '../../zalo/event-normalizer.ts';
import type { ZaloMessage } from '../../zalo/types.ts';

describe('InboundHandler — chat.delete ("delete for me" on another device)', () => {
  it('redacts the bridged events as the room creator, never as the owner', async () => {
    const store = new MappingStore(':memory:');
    store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!dm:x', name: null });
    store.recordMessage('m1', '!dm:x', '$e1', 'inbound');
    const redactEvent = vi.fn().mockResolvedValue('$redaction');
    const ghostIntent = { matrixClient: { redactEvent } };
    const deps = {
      bridge: { getIntent: vi.fn() },
      store,
      puppets: { intentFor: vi.fn(() => ghostIntent) },
      portals: { getOrCreatePortal: vi.fn() },
      echo: new EchoSuppressor(),
      ownerUserId: '@owner:beeper.com',
      mediaMaxBytes: 1,
      resolveGroupName: async () => null,
      resolveStickerUrl: async () => null,
      getOwnZaloId: () => 'me',
      bridgedEventIds: new Set<string>(),
    };
    const handler = new InboundHandler(deps as never);
    // Live chat.delete item shape (anonymized); m9 was never bridged
    const msg = normalizeZaloMessage({
      type: 0,
      threadId: 't1',
      isSelf: true,
      data: {
        msgId: 'del1',
        msgType: 'chat.delete',
        uidFrom: 'me',
        ts: '1',
        content: [
          {
            type: 0,
            actionType: 0,
            uidFrom: 'me',
            uidTo: 't1',
            clientDelMsgId: '1',
            globalDelMsgId: 'm1',
            destId: 't1',
          },
          {
            type: 0,
            actionType: 0,
            uidFrom: 'me',
            uidTo: 't1',
            clientDelMsgId: '2',
            globalDelMsgId: 'm9',
            destId: 't1',
          },
        ],
      },
    }) as ZaloMessage;
    expect(msg.content).toEqual({ kind: 'delete', msgIds: ['m1', 'm9'] });

    await (handler as unknown as { process(message: ZaloMessage): Promise<void> }).process(msg);

    expect(deps.puppets.intentFor).toHaveBeenCalledWith('t1');
    expect(redactEvent).toHaveBeenCalledTimes(1);
    expect(redactEvent).toHaveBeenCalledWith('!dm:x', '$e1', 'Deleted on Zalo');
    expect(deps.bridge.getIntent).not.toHaveBeenCalled();
    expect(deps.portals.getOrCreatePortal).not.toHaveBeenCalled();
    expect(store.hasMessage('del1')).toBe(true); // a replayed delete is dropped as a duplicate
    store.close();
  });
});
