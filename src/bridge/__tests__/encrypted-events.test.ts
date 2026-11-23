import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { MappingStore } from '../mapping-store.ts';
import { OutboundHandler } from '../outbound-handler.ts';
import { SELF_BRIDGE_MARKER } from '../self-bridge.ts';
import { PresenceHandler } from '../presence-handler.ts';
import {
  installEncryptedSend,
  prepareIncomingEvent,
  type RoomEncryption,
  type SendingClient,
} from '../../matrix/crypto.ts';
import type { ZaloReactionEvent } from '../../zalo/types.ts';

// Audit of every event kind in an encrypted portal: what the bridge sends (Zalo -> Matrix)
// goes through the real installEncryptedSend patch, what it receives (Matrix -> Zalo) through
// the real prepareIncomingEvent with a fake room decryption.

const ROOM = '!enc:x';
const OWNER = '@owner:beeper.com';

type Sent = { type: string; content: Record<string, unknown> };

function setup() {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: ROOM, name: null });
  store.recordMessage('m1', ROOM, '$msg1', 'inbound', null, 'cli1', 't1', 'webchat');
  store.recordMessage('o1', ROOM, '$own1', 'outbound', null, 'cliO1', 'me');

  const encrypted: Sent[] = [];
  const raw: Sent[] = [];
  const client = {
    sendEvent: vi.fn(async (_roomId: string, type: string, content: unknown) => {
      raw.push({ type, content: content as Record<string, unknown> });
      return `$ev${raw.length}`;
    }),
    sendRawEvent: vi.fn(async (_roomId: string, type: string, content: unknown) => {
      raw.push({ type, content: content as Record<string, unknown> });
      return `$ev${raw.length}`;
    }),
    redactEvent: vi.fn(async () => '$redaction'),
    sendReadReceipt: vi.fn(async (_roomId: string, _eventId: string) => undefined),
    setTyping: vi.fn(async (_typing: boolean) => undefined),
  };
  // The owner's events arrive as ciphertext; the test supplies the clear event per event id
  const clear = new Map<string, { type: string; content: Record<string, unknown> }>();
  const rooms = {
    isEncrypted: vi.fn(async () => true),
    encrypt: vi.fn(async (_roomId: string, type: string, content: unknown) => {
      encrypted.push({ type, content: content as Record<string, unknown> });
      return { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'c' };
    }),
    decrypt: vi.fn(async (event: Record<string, unknown>) => ({ ...event, ...clear.get(String(event.event_id)) })),
    onStateEvent: vi.fn(async () => undefined),
    markEncrypted: vi.fn(async () => undefined),
  } as unknown as RoomEncryption;
  installEncryptedSend(client as unknown as SendingClient, rooms);

  /** Same surface as an appservice Intent: sendEvent goes through the (patched) client. */
  const intentFor = () => ({
    sendEvent: async (_roomId: string, type: string, content: Record<string, unknown>) => ({
      event_id: await client.sendEvent(ROOM, type, content),
    }),
    sendTyping: vi.fn(async (_roomId: string, typing: boolean) => void client.setTyping(typing)),
    sendReadReceipt: vi.fn(async (roomId: string, eventId: string) => void client.sendReadReceipt(roomId, eventId)),
    matrixClient: client,
  });
  const ghost = intentFor();
  const owner = intentFor();
  const puppets = { intentFor: vi.fn(() => ghost), ensurePuppet: vi.fn(async () => ghost) };
  const zalo = {
    ownId: 'me',
    react: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ msgId: 'z9' }),
    sendSeen: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
  const echo = new EchoSuppressor();
  const bridgedEventIds = new Set<string>();
  const presence = new PresenceHandler(store, puppets as never, zalo as never, OWNER, () => 'me', {
    ownerIntent: () => owner as never,
    bridgedEventIds,
    echo,
  });
  const outbound = new OutboundHandler({
    bridge: { getIntent: () => ({ sendMessage: vi.fn(async () => ({ event_id: '$n' })) }) },
    store,
    puppets: { ...puppets, uidFor: () => null },
    zalo,
    echo,
    ownerUserId: OWNER,
    mediaMaxBytes: 1,
    homeserverUrl: 'http://hs',
    matrixToken: 'tok',
    bridgedEventIds,
  } as never);

  /** Delivers an event the owner's Beeper sent encrypted: decrypt, then route like index.ts. */
  const deliverEncrypted = async (
    eventId: string,
    type: string,
    content: Record<string, unknown>,
    wire: Record<string, unknown> = {},
  ) => {
    clear.set(eventId, { type, content });
    const event = await prepareIncomingEvent(
      {
        type: 'm.room.encrypted',
        room_id: ROOM,
        sender: OWNER,
        event_id: eventId,
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'c', ...wire },
      },
      { rooms, isBridgeUser: (id) => id.startsWith('@zalo_'), onDecryptFailure: vi.fn() },
    );
    expect(event).not.toBeNull();
    return outbound.handle(event as never);
  };
  return { store, client, encrypted, raw, ghost, owner, zalo, presence, outbound, deliverEncrypted };
}

const zaloReaction = (over: Partial<ZaloReactionEvent> = {}): ZaloReactionEvent => ({
  threadId: 't1',
  threadType: 'user',
  senderId: 't1',
  isSelf: false,
  targetMsgId: 'm1',
  icon: '/-heart',
  ...over,
});

afterEach(() => vi.useRealTimers());

describe('Zalo -> Matrix events in an encrypted room', () => {
  it("encrypts a contact's reaction, keeping the annotation inside the ciphertext", async () => {
    const t = setup();
    await t.presence.handleReaction(zaloReaction());
    expect(t.raw.map((e) => e.type)).toEqual(['m.room.encrypted']);
    expect(t.encrypted).toEqual([
      {
        type: 'm.reaction',
        content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$msg1', key: '❤️' } },
      },
    ]);
  });

  it("encrypts the owner's own phone reaction and keeps the loop marker inside the ciphertext", async () => {
    const t = setup();
    await t.presence.handleReaction(zaloReaction({ isSelf: true, senderId: 'me' }));
    expect(t.raw.map((e) => e.type)).toEqual(['m.room.encrypted']);
    expect(t.raw[0]!.content).not.toHaveProperty(SELF_BRIDGE_MARKER);
    expect(t.encrypted[0]!.content).toMatchObject({ [SELF_BRIDGE_MARKER]: true });
  });

  it('removes a reaction with a plain redaction, never through encrypt', async () => {
    const t = setup();
    await t.presence.handleReaction(zaloReaction());
    t.encrypted.length = 0;
    await t.presence.handleReaction(zaloReaction({ icon: '' }));
    expect(t.client.redactEvent).toHaveBeenCalledWith(ROOM, '$ev1', 'Reaction removed on Zalo');
    expect(t.encrypted).toEqual([]);
    expect(t.raw).toHaveLength(1); // only the reaction itself was sent as an event
  });

  it('shows ghost read receipts and typing unencrypted', async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.presence.handleSeen({ threadId: 't1', threadType: 'user', msgId: 'm1', seenUids: [] });
    await t.presence.handleTyping({ threadId: 't1', threadType: 'user', uid: 't1' });
    expect(t.client.sendReadReceipt).toHaveBeenCalledWith(ROOM, '$msg1');
    expect(t.client.setTyping).toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(t.client.setTyping).toHaveBeenLastCalledWith(false);
    expect(t.raw).toEqual([]);
    expect(t.encrypted).toEqual([]);
  });
});

describe('Matrix -> Zalo events arriving encrypted', () => {
  it('sends a decrypted text message', async () => {
    const t = setup();
    await t.deliverEncrypted('$e1', 'm.room.message', { msgtype: 'm.text', body: 'xin chao' });
    expect(t.zalo.sendText).toHaveBeenCalledWith(
      't1',
      'user',
      'xin chao',
      undefined,
      expect.any(Function),
      [],
      undefined,
    );
  });

  it('sends a decrypted edit as the corrected text, reading m.new_content from inside the ciphertext', async () => {
    const t = setup();
    const relation = { rel_type: 'm.replace', event_id: '$own1' };
    await t.deliverEncrypted(
      '$e2',
      'm.room.message',
      {
        msgtype: 'm.text',
        body: '* fixed',
        'm.new_content': { msgtype: 'm.text', body: 'fixed' },
        'm.relates_to': relation,
      },
      { 'm.relates_to': relation },
    );
    expect(t.zalo.sendText.mock.calls[0]![2]).toBe('fixed');
  });

  it('maps a decrypted reply to the Zalo quote, stripping the fallback', async () => {
    const t = setup();
    const quote = { msgId: 'm1', content: 'orig' };
    t.store.recordMessage('m2', ROOM, '$quoted', 'inbound', JSON.stringify(quote), 'cli2', 't1');
    await t.deliverEncrypted('$e3', 'm.room.message', {
      msgtype: 'm.text',
      body: '> <@a:x> orig\n\nanswer',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$quoted' } },
    });
    expect(t.zalo.sendText.mock.calls[0]!.slice(2, 4)).toEqual(['answer', quote]);
  });

  it('maps a decrypted reaction to a Zalo reaction', async () => {
    const t = setup();
    const relation = { rel_type: 'm.annotation', event_id: '$msg1', key: '❤️' };
    await t.deliverEncrypted('$e4', 'm.reaction', { 'm.relates_to': relation }, { 'm.relates_to': relation });
    expect(t.zalo.react).toHaveBeenCalledWith('t1', 'user', 'm1', 'cli1', '/-heart');
    expect(t.store.getReactionByEventId('$e4')).not.toBeNull();
  });

  it('drops a decrypted reaction carrying the loop marker', async () => {
    const t = setup();
    await t.deliverEncrypted('$e5', 'm.reaction', {
      'm.relates_to': { rel_type: 'm.annotation', event_id: '$msg1', key: '❤️' },
      [SELF_BRIDGE_MARKER]: true,
    });
    expect(t.zalo.react).not.toHaveBeenCalled();
  });

  it('drops a decrypted message carrying the loop marker', async () => {
    const t = setup();
    await t.deliverEncrypted('$e6', 'm.room.message', { msgtype: 'm.text', body: 'mine', [SELF_BRIDGE_MARKER]: true });
    expect(t.zalo.sendText).not.toHaveBeenCalled();
  });

  it('recalls on a redaction, which is never encrypted, and removes a reaction the same way', async () => {
    const t = setup();
    const redaction = (redacts: string) =>
      ({ type: 'm.room.redaction', room_id: ROOM, sender: OWNER, event_id: '$red', redacts, content: {} }) as never;
    // the redaction passes through the incoming pipeline untouched
    const rooms = { decrypt: vi.fn() } as unknown as RoomEncryption;
    const prepared = await prepareIncomingEvent(redaction('$own1') as never, {
      rooms,
      isBridgeUser: () => false,
      onDecryptFailure: vi.fn(),
    });
    expect(rooms.decrypt).not.toHaveBeenCalled();
    await t.outbound.handle(prepared as never);
    expect(t.zalo.recall).toHaveBeenCalledWith('t1', 'user', 'o1', 'cliO1');

    const relation = { rel_type: 'm.annotation', event_id: '$msg1', key: '👍' };
    await t.deliverEncrypted('$e7', 'm.reaction', { 'm.relates_to': relation });
    t.zalo.react.mockClear();
    await t.outbound.handle(redaction('$e7'));
    expect(t.zalo.react.mock.calls[0]![4]).toBe('');
  });

  it("passes the owner's receipts and typing (ephemeral, never encrypted) to Zalo", async () => {
    const t = setup();
    await t.presence.handleOwnerReceipt(ROOM, { $msg1: { 'm.read': { [OWNER]: { ts: 1 } } } });
    await t.presence.handleOwnerTyping(ROOM, [OWNER]);
    expect(t.zalo.sendSeen).toHaveBeenCalledWith('t1', 'user', 'm1', 'cli1', 't1', 'webchat');
    expect(t.zalo.sendTyping).toHaveBeenCalledWith('t1', 'user');
  });
});
