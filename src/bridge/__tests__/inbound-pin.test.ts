// Zalo system events: pins become m.room.pinned_events state, other system lines are
// posted as m.notice by the bridge bot (never as a message from a person).
import { describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { InboundHandler } from '../inbound-handler.ts';
import { MappingStore } from '../mapping-store.ts';
import { normalizeFriendPinEvent, normalizeGroupPinEvent } from '../../zalo/pin-events.ts';
import type { ZaloMessage, ZaloPinEvent } from '../../zalo/types.ts';

const PINNED = 'm.room.pinned_events';
const OWNER = '@owner:beeper.com';

type Options = {
  threadType?: 'user' | 'group';
  /** current m.room.pinned_events content (null = never set) */
  pinned?: Record<string, unknown> | null;
  holdMs?: number;
};

/** Handler over a real in-memory store and three recording intents (bot, peer ghost, owner). */
function setup(options: Options = {}) {
  const threadType = options.threadType ?? 'user';
  const threadId = threadType === 'group' ? 'g1' : 't1';
  const roomId = threadType === 'group' ? '!group:x' : '!dm:x';
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: threadId, thread_type: threadType, room_id: roomId, name: null });
  store.recordMessage('m1', roomId, '$e1', 'inbound');
  store.recordMessage('m2', roomId, '$e2', 'inbound');

  const state = { current: options.pinned === undefined ? null : options.pinned };
  /** Intent double that shares one room state and counts what it sent. */
  const makeIntent = (name: string) => ({
    name,
    opts: {},
    sendMessage: vi.fn(async (_room: string, _content: Record<string, unknown>) => ({
      event_id: `$${name}-notice`,
    })),
    getStateEvent: vi.fn(async () => state.current),
    sendStateEvent: vi.fn(async (_room: string, _type: string, _key: string, content: Record<string, unknown>) => {
      state.current = content;
      return { event_id: `$${name}-state` };
    }),
  });
  const bot = makeIntent('bot');
  const ghost = makeIntent('ghost');
  const owner = makeIntent('owner');

  const deps = {
    bridge: { getIntent: vi.fn((userId?: string) => (userId === OWNER ? owner : bot)) },
    store,
    puppets: {
      ensurePuppet: vi.fn(async () => ghost),
      intentFor: vi.fn(() => ghost),
      mxidFor: (uid: string) => `@zalo_${uid}:x`,
    },
    portals: {
      getOrCreatePortal: vi.fn(async () => store.getPortalByThread(threadId)!),
      ensureGhostInRoom: vi.fn(async () => undefined),
      ensureBotInRoom: vi.fn(async (_roomId: string, _peerUid: string) => undefined),
    },
    echo: new EchoSuppressor(),
    ownerUserId: OWNER,
    mediaMaxBytes: 1,
    resolveGroupName: async () => null,
    resolveStickerUrl: async () => null,
    getOwnZaloId: () => 'me',
    bridgedEventIds: new Set<string>(),
    pinBubbleHoldMs: options.holdMs ?? 0,
  };
  const handler = new InboundHandler(deps as never);
  const processMessage = (over: Partial<ZaloMessage> & Pick<ZaloMessage, 'content'>) =>
    (handler as unknown as { process(message: ZaloMessage): Promise<void> }).process({
      msgId: 'n1',
      threadId,
      threadType,
      senderId: 'u2',
      timestamp: 1,
      isSelf: false,
      ...over,
    });
  const pin = (over: Partial<ZaloPinEvent> = {}): ZaloPinEvent => ({
    threadId,
    threadType,
    action: 'pin',
    actorId: 'u2',
    isSelf: false,
    msgId: 'm1',
    ...over,
  });
  const queues = () => (handler as unknown as { threadQueues: Map<string, unknown> }).threadQueues;
  /** Runs one pin event through the same queue the live listener uses and waits for it. */
  const runPin = async (event: ZaloPinEvent) => {
    handler.handlePin(event);
    await vi.waitFor(() => expect(queues().size).toBe(0));
  };
  return { handler, store, deps, bot, ghost, owner, state, roomId, threadId, processMessage, pin, runPin, queues };
}

describe('InboundHandler pins', () => {
  it('pins through a group_event as the pinner ghost and keeps the other pins', async () => {
    const t = setup({ threadType: 'group', pinned: { pinned: ['$other'] } });
    const event = normalizeGroupPinEvent({
      type: 'new_pin_topic',
      act: 'new_pin_topic',
      threadId: 'g1',
      isSelf: false,
      data: { actorId: 'u2', groupId: 'g1', topic: { type: 2, id: 'tp', params: { global_msg_id: 'm1' } } },
    } as never)!;
    await t.runPin(event);

    expect(t.deps.puppets.ensurePuppet).toHaveBeenCalledWith('u2', undefined);
    expect(t.deps.portals.ensureGhostInRoom).toHaveBeenCalledWith('u2', '!group:x', undefined);
    expect(t.ghost.getStateEvent).toHaveBeenCalledWith('!group:x', PINNED, '', true);
    expect(t.ghost.sendStateEvent).toHaveBeenCalledWith('!group:x', PINNED, '', { pinned: ['$other', '$e1'] });
    expect(t.bot.sendMessage).not.toHaveBeenCalled();
    expect(t.ghost.sendMessage).not.toHaveBeenCalled();
  });

  it('pins through a friend_event in a DM, starting from an unset state', async () => {
    const t = setup({ pinned: null });
    const event = normalizeFriendPinEvent({
      type: 11,
      threadId: 't1',
      isSelf: false,
      data: { actorId: 't1', conversationId: 't1', topic: { id: 'tp', params: { global_msg_id: 'm2' } } },
    } as never)!;
    await t.runPin(event);
    expect(t.ghost.sendStateEvent).toHaveBeenCalledWith('!dm:x', PINNED, '', { pinned: ['$e2'] });
  });

  it("acts as the owner for the account's own pins", async () => {
    const t = setup({ pinned: { pinned: [] } });
    await t.runPin(t.pin({ isSelf: true, actorId: 'me' }));
    expect(t.owner.sendStateEvent).toHaveBeenCalledWith('!dm:x', PINNED, '', { pinned: ['$e1'] });
    expect(t.deps.puppets.ensurePuppet).not.toHaveBeenCalled();
  });

  it('does not rewrite the state when the message is already pinned', async () => {
    const t = setup({ pinned: { pinned: ['$e1'] } });
    await t.runPin(t.pin());
    expect(t.ghost.sendStateEvent).not.toHaveBeenCalled();
  });

  it('unpins only that event and keeps other state fields', async () => {
    const t = setup({ threadType: 'group', pinned: { pinned: ['$e1', '$e2'], extra: true } });
    await t.runPin(t.pin({ action: 'unpin' }));
    expect(t.ghost.sendStateEvent).toHaveBeenCalledWith('!group:x', PINNED, '', { pinned: ['$e2'], extra: true });
  });

  it('unpins a DM message known only by its topic id, learned from the earlier pin', async () => {
    const t = setup({ pinned: { pinned: [] } });
    await t.runPin(t.pin({ topicId: 'tp9' }));
    expect(t.state.current).toEqual({ pinned: ['$e1'] });
    await t.runPin(t.pin({ action: 'unpin', msgId: undefined, topicId: 'tp9' }));
    expect(t.state.current).toEqual({ pinned: [] });
    expect(t.ghost.sendStateEvent).toHaveBeenCalledTimes(2);
  });

  it('falls back to the room creator when the pinner may not set state', async () => {
    const t = setup({ threadType: 'group', pinned: { pinned: [] } });
    t.ghost.sendStateEvent.mockRejectedValueOnce(new Error('M_FORBIDDEN'));
    await t.runPin(t.pin());
    expect(t.bot.sendStateEvent).toHaveBeenCalledWith('!group:x', PINNED, '', { pinned: ['$e1'] });
  });

  it('posts a bot notice instead of state when the pinned message was never bridged', async () => {
    const t = setup({ pinned: { pinned: [] } });
    await t.runPin(t.pin({ msgId: 'unknown' }));
    expect(t.ghost.sendStateEvent).not.toHaveBeenCalled();
    expect(t.bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(t.bot.sendMessage.mock.calls[0]![1]).toMatchObject({ msgtype: 'm.notice' });
    expect(t.ghost.sendMessage).not.toHaveBeenCalled();
  });

  it('stays silent for an unpin of a message that was never bridged', async () => {
    const t = setup({ pinned: { pinned: ['$e1'] } });
    await t.runPin(t.pin({ action: 'unpin', msgId: 'unknown' }));
    expect(t.bot.sendMessage).not.toHaveBeenCalled();
    expect(t.ghost.sendStateEvent).not.toHaveBeenCalled();
  });

  it('ignores pins of threads without a portal and never creates one', async () => {
    const t = setup();
    await t.runPin(t.pin({ threadId: 'nobody' }));
    expect(t.deps.portals.getOrCreatePortal).not.toHaveBeenCalled();
    expect(t.bot.sendMessage).not.toHaveBeenCalled();
  });

  it('applies a pin after the message it points at, in thread order', async () => {
    const t = setup({ pinned: { pinned: [] } });
    t.ghost.sendMessage.mockResolvedValueOnce({ event_id: '$fresh' });
    t.handler.handle({
      msgId: 'fresh1',
      threadId: 't1',
      threadType: 'user',
      senderId: 't1',
      timestamp: 1,
      isSelf: false,
      content: { kind: 'text', text: 'hi' },
    });
    await t.runPin(t.pin({ msgId: 'fresh1' }));
    expect(t.state.current).toEqual({ pinned: ['$fresh'] });
  });
});

describe('InboundHandler system notices', () => {
  it('posts a system line as an m.notice from the bot, not from the sender ghost', async () => {
    const t = setup({ threadType: 'group' });
    await t.processMessage({ content: { kind: 'notice', text: 'Someone joined the group' } });
    expect(t.bot.sendMessage).toHaveBeenCalledWith('!group:x', {
      msgtype: 'm.notice',
      body: 'Someone joined the group',
    });
    expect(t.ghost.sendMessage).not.toHaveBeenCalled();
    expect(t.deps.puppets.ensurePuppet).not.toHaveBeenCalled();
    expect(t.store.hasMessage('n1')).toBe(true);
    expect(t.store.getEventIdByMsgId('n1')).toBe('$bot-notice');
  });

  it("does not double-puppet the owner for the account's own system lines", async () => {
    const t = setup();
    await t.processMessage({ isSelf: true, senderId: 'me', content: { kind: 'notice', text: 'x' } });
    expect(t.owner.sendMessage).not.toHaveBeenCalled();
    expect(t.bot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('brings the bot into an older DM it is not in, then posts as the bot', async () => {
    const t = setup();
    t.bot.sendMessage.mockRejectedValueOnce(new Error('M_FORBIDDEN'));
    await t.processMessage({ content: { kind: 'notice', text: 'x' } });
    expect(t.deps.portals.ensureBotInRoom).toHaveBeenCalledWith('!dm:x', 't1');
    expect(t.bot.sendMessage).toHaveBeenCalledTimes(2);
    expect(t.ghost.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to the DM peer ghost when the bot cannot be added', async () => {
    const t = setup();
    t.bot.sendMessage.mockRejectedValue(new Error('M_FORBIDDEN'));
    t.deps.portals.ensureBotInRoom.mockRejectedValue(new Error('cannot invite'));
    await t.processMessage({ content: { kind: 'notice', text: 'x' } });
    expect(t.ghost.sendMessage).toHaveBeenCalledWith('!dm:x', { msgtype: 'm.notice', body: 'x' });
    expect(t.store.hasMessage('n1')).toBe(true);
  });

  it('does not mask a failing bot send in a group', async () => {
    const t = setup({ threadType: 'group' });
    t.bot.sendMessage.mockRejectedValue(new Error('boom'));
    await expect(t.processMessage({ content: { kind: 'notice', text: 'x' } })).rejects.toThrow('boom');
    expect(t.ghost.sendMessage).not.toHaveBeenCalled();
  });
});

describe('InboundHandler pin bubble de-duplication', () => {
  const bubble = { content: { kind: 'notice', text: 'u2 pinned a message' } } as const;

  it('drops the bubble Zalo sends after a pin event it already bridged as state', async () => {
    const t = setup({ pinned: { pinned: [] } });
    await t.runPin(t.pin());
    await t.processMessage({ ...bubble });
    expect(t.bot.sendMessage).not.toHaveBeenCalled();
    expect(t.store.hasMessage('n1')).toBe(true); // a replayed bubble stays dropped
  });

  it('drops the bubble when it arrives before the pin event', async () => {
    const t = setup({ pinned: { pinned: [] }, holdMs: 500 });
    const pending = t.processMessage({ ...bubble });
    t.handler.handlePin(t.pin());
    await pending;
    expect(t.bot.sendMessage).not.toHaveBeenCalled();
  });

  it('suppresses the bubble of an unresolvable pin too, since the bot notice replaces it', async () => {
    const t = setup({ pinned: { pinned: [] } });
    await t.runPin(t.pin({ msgId: 'unknown' }));
    await t.processMessage({ ...bubble });
    expect(t.bot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a system line from somebody else, and a second bubble of the same pinner', async () => {
    const t = setup({ pinned: { pinned: [] } });
    await t.runPin(t.pin());
    await t.processMessage({ ...bubble, msgId: 'n2', senderId: 'u9' });
    expect(t.bot.sendMessage).toHaveBeenCalledTimes(1);
    await t.processMessage({ ...bubble, msgId: 'n3' }); // consumed by the pin
    await t.processMessage({ ...bubble, msgId: 'n4' }); // nothing left to consume
    expect(t.bot.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('posts a bubble that no pin event ever claims once the hold elapses', async () => {
    const t = setup({ holdMs: 20 });
    await t.processMessage({ ...bubble });
    expect(t.bot.sendMessage).toHaveBeenCalledTimes(1);
  });
});
