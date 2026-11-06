import { describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { MappingStore } from '../mapping-store.ts';
import { OutboundHandler, SELF_BRIDGE_MARKER } from '../outbound-handler.ts';
import { PresenceHandler } from '../presence-handler.ts';
import type { ZaloReactionEvent } from '../../zalo/types.ts';

const OWNER = '@owner:beeper.com';

function setup() {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!dm:x', name: null });
  store.recordMessage('m1', '!dm:x', '$msg1', 'inbound', null, 'cli1', 't1');
  const echo = new EchoSuppressor();
  const bridgedEventIds = new Set<string>();
  const ownerSend = vi.fn().mockResolvedValue({ event_id: '$ownReaction' });
  const ownerRedact = vi.fn().mockResolvedValue('$r');
  const ownerIntent = { sendEvent: ownerSend, matrixClient: { redactEvent: ownerRedact } };
  const ghostSend = vi.fn().mockResolvedValue({ event_id: '$ghostReaction' });
  const ghostRedact = vi.fn().mockResolvedValue('$r');
  const ghostIntent = { sendEvent: ghostSend, matrixClient: { redactEvent: ghostRedact } };
  const puppets = { intentFor: vi.fn(() => ghostIntent), ensurePuppet: vi.fn(async () => ghostIntent) };
  const zalo = { ownId: 'me', react: vi.fn().mockResolvedValue(undefined) };
  const presence = new PresenceHandler(store, puppets as never, zalo as never, OWNER, () => 'me', {
    ownerIntent: () => ownerIntent as never,
    bridgedEventIds,
    echo,
  });
  const noticeSend = vi.fn().mockResolvedValue({ event_id: '$n' });
  const outbound = new OutboundHandler({
    bridge: { getIntent: () => ({ sendMessage: noticeSend }) },
    store,
    puppets,
    zalo,
    echo,
    ownerUserId: OWNER,
    mediaMaxBytes: 1,
    homeserverUrl: 'http://hs',
    matrixToken: 'tok',
    bridgedEventIds,
  } as never);
  return { store, echo, bridgedEventIds, ownerSend, ownerRedact, ghostSend, ghostRedact, zalo, presence, outbound };
}

function zaloReaction(over: Partial<ZaloReactionEvent>): ZaloReactionEvent {
  return {
    threadId: 't1',
    threadType: 'user',
    senderId: 't1',
    isSelf: false,
    targetMsgId: 'm1',
    icon: '/-heart',
    ...over,
  };
}

function matrixReaction(eventId: string, key: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'm.reaction',
    room_id: '!dm:x',
    sender: OWNER,
    event_id: eventId,
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$msg1', key }, ...extra },
  } as never;
}

function matrixRedaction(redacts: string) {
  return { type: 'm.room.redaction', room_id: '!dm:x', sender: OWNER, event_id: '$red', redacts, content: {} } as never;
}

describe('reaction sync — Zalo → Beeper', () => {
  it("posts the owner's own phone reaction as the owner, marked so it is not sent back", async () => {
    const t = setup();
    await t.presence.handleReaction(zaloReaction({ isSelf: true, senderId: 'me' }));
    expect(t.ownerSend).toHaveBeenCalledWith('!dm:x', 'm.reaction', {
      'm.relates_to': { rel_type: 'm.annotation', event_id: '$msg1', key: '❤️' },
      [SELF_BRIDGE_MARKER]: true,
    });
    expect(t.bridgedEventIds.has('$ownReaction')).toBe(true);
    expect(t.store.getReactions('m1', 'me')).toHaveLength(1);
    // Beeper delivers it back to the appservice → never re-sent to Zalo
    await t.outbound.handle(matrixReaction('$ownReaction', '❤️', { [SELF_BRIDGE_MARKER]: true }));
    expect(t.zalo.react).not.toHaveBeenCalled();
  });

  it("redacts a contact's reaction when they remove it on Zalo", async () => {
    const t = setup();
    await t.presence.handleReaction(zaloReaction({}));
    expect(t.ghostSend).toHaveBeenCalledTimes(1);
    await t.presence.handleReaction(zaloReaction({ icon: '' }));
    expect(t.ghostRedact).toHaveBeenCalledWith('!dm:x', '$ghostReaction', 'Reaction removed on Zalo');
    expect(t.store.getReactions('m1', 't1')).toHaveLength(0);
  });

  it("redacts the owner's reaction when removed on the phone", async () => {
    const t = setup();
    await t.presence.handleReaction(zaloReaction({ isSelf: true, senderId: 'me' }));
    await t.presence.handleReaction(zaloReaction({ isSelf: true, senderId: 'me', icon: '' }));
    expect(t.ownerRedact).toHaveBeenCalledWith('!dm:x', '$ownReaction', 'Reaction removed on Zalo');
    // the redaction echoes to the appservice: the row is gone, so nothing goes to Zalo
    await t.outbound.handle(matrixRedaction('$ownReaction'));
    expect(t.zalo.react).not.toHaveBeenCalled();
  });
});

describe('reaction sync — Beeper → Zalo', () => {
  it('sends the reaction and ignores its Zalo echo', async () => {
    const t = setup();
    await t.outbound.handle(matrixReaction('$beeperReaction', '❤️'));
    expect(t.zalo.react).toHaveBeenCalledWith('t1', 'user', 'm1', 'cli1', '/-heart');
    await t.presence.handleReaction(zaloReaction({ isSelf: true, senderId: 'me' }));
    expect(t.ownerSend).not.toHaveBeenCalled();
  });

  it('removes the reaction on Zalo and keeps the remaining ones', async () => {
    const t = setup();
    await t.outbound.handle(matrixReaction('$heart', '❤️'));
    await t.outbound.handle(matrixReaction('$like', '👍'));
    t.zalo.react.mockClear();
    await t.outbound.handle(matrixRedaction('$heart'));
    expect(t.zalo.react.mock.calls.map((call) => call[4])).toEqual(['', '/-strong']);
    expect(t.store.getReactionByEventId('$heart')).toBeNull();
    // Zalo's echo of the removal must not redact the remaining Beeper reaction
    await t.presence.handleReaction(zaloReaction({ isSelf: true, senderId: 'me', icon: '' }));
    expect(t.ownerRedact).not.toHaveBeenCalled();
    expect(t.store.getReactionByEventId('$like')).not.toBeNull();
  });

  it('forgets the reaction when Zalo rejects it', async () => {
    const t = setup();
    t.zalo.react.mockRejectedValueOnce(new Error('boom'));
    await t.outbound.handle(matrixReaction('$heart', '❤️'));
    expect(t.store.getReactionByEventId('$heart')).toBeNull();
  });
});

describe('linkPreviewHint', () => {
  it("reads Beeper's preview of the link in the body", async () => {
    const { linkPreviewHint } = await import('../outbound-handler.ts');
    const content = {
      'com.beeper.linkpreviews': [
        { matched_url: 'https://other.vn', 'og:title': 'Other' },
        { matched_url: 'https://a.vn/x', 'og:title': ' Title ', 'og:description': '', 'og:image': 'mxc://x/y' },
      ],
    };
    expect(linkPreviewHint(content, 'xem https://a.vn/x')).toEqual({
      url: 'https://a.vn/x',
      title: 'Title',
      description: undefined,
    });
    expect(linkPreviewHint({ 'com.beeper.linkpreviews': [] }, 'https://a.vn')).toBeNull();
    expect(linkPreviewHint({}, 'https://a.vn')).toBeUndefined();
  });
});
