// Polls in an end-to-bridge encrypted portal: what the bridge posts (poll.start / response / end)
// leaves as m.room.encrypted with m.relates_to still readable next to the ciphertext, and the
// owner's encrypted poll events are decrypted, keep their relation and reach Zalo.
// Real createRoomEncryption / installEncryptedSend / prepareIncomingEvent over a fake engine.
import { describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { InboundHandler } from '../inbound-handler.ts';
import { MappingStore } from '../mapping-store.ts';
import { OutboundHandler } from '../outbound-handler.ts';
import { buildPollEnd, buildPollResponse, POLL_END, POLL_RESPONSE, POLL_START } from '../poll-content.ts';
import {
  createRoomEncryption,
  installEncryptedSend,
  prepareIncomingEvent,
  type SendingClient,
} from '../../matrix/crypto.ts';
import type { ZaloPoll } from '../../zalo/types.ts';

const ROOM = '!enc-group:x';
const OWNER = '@owner:beeper.com';

const poll = (voters: string[] = []): ZaloPoll => ({
  pollId: 7,
  question: 'Lunch?',
  creatorId: 'u2',
  options: [
    { optionId: 11, content: 'Pho', votes: voters.length, voters },
    { optionId: 12, content: 'Bun', votes: 0, voters: [] },
  ],
  closed: false,
  multiChoice: false,
  anonymous: false,
});

function setup() {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 'g1', thread_type: 'group', room_id: ROOM, name: null });

  // Fake megolm: ciphertext is a key into a vault of the clear events
  const vault = new Map<string, { type: string; content: Record<string, unknown> }>();
  const rooms = createRoomEncryption(
    {
      isRoomEncrypted: async () => true,
      encryptRoomEvent: async (_roomId, type, content) => {
        const id = `ct${vault.size + 1}`;
        vault.set(id, { type, content: content as Record<string, unknown> });
        return { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: id };
      },
      decryptRoomEvent: async (event) => {
        const id = (event.content as { ciphertext: string }).ciphertext;
        const clear = vault.get(id);
        if (!clear) throw new Error('unknown session');
        return { type: clear.type, content: { ...clear.content } };
      },
      onRoomEvent: async () => undefined,
    },
    async () => undefined,
    [],
  );

  const wire: Array<{ type: string; content: Record<string, unknown> }> = [];
  const post = async (_roomId: string, type: string, content: unknown) => {
    wire.push({ type, content: content as Record<string, unknown> });
    return `$ev${wire.length}`;
  };
  // installEncryptedSend sends the ciphertext through sendRawEvent; an unencrypted send would use sendEvent
  const client = { sendEvent: vi.fn(post), sendRawEvent: vi.fn(post) };
  installEncryptedSend(client as unknown as SendingClient, rooms);
  const intent = () => ({
    sendMessage: vi.fn(async () => ({ event_id: '$notice' })),
    sendEvent: async (_roomId: string, type: string, content: Record<string, unknown>) => ({
      event_id: await client.sendEvent(ROOM, type, content),
    }),
  });
  const ghost = intent();
  const owner = intent();
  const bot = intent();

  const echo = new EchoSuppressor();
  const bridgedEventIds = new Set<string>();
  const detail = { current: poll() };
  const inbound = new InboundHandler({
    bridge: { getIntent: (userId?: string) => (userId === OWNER ? owner : bot) },
    store,
    puppets: { ensurePuppet: vi.fn(async () => ghost), intentFor: () => ghost },
    portals: { ensureGhostInRoom: vi.fn(async () => undefined), ensureBotInRoom: vi.fn(async () => undefined) },
    echo,
    ownerUserId: OWNER,
    mediaMaxBytes: 1,
    resolveGroupName: async () => null,
    resolveStickerUrl: async () => null,
    getOwnZaloId: () => 'me',
    bridgedEventIds,
    getPollDetail: async () => detail.current,
  } as never);
  const zalo = {
    ownId: 'me',
    createPoll: vi.fn(async () => ({ ...poll(), creatorId: 'me' })),
    votePoll: vi.fn(async () => undefined),
    lockPoll: vi.fn(async () => undefined),
  };
  const outbound = new OutboundHandler({
    bridge: { getIntent: () => bot },
    store,
    puppets: { intentFor: vi.fn(), uidFor: () => null },
    zalo,
    echo,
    ownerUserId: OWNER,
    mediaMaxBytes: 1,
    homeserverUrl: 'http://hs',
    matrixToken: 'tok',
    bridgedEventIds,
  } as never);

  /** Delivers an event the owner's Beeper sent encrypted, routed like index.ts does. */
  const deliverEncrypted = async (
    eventId: string,
    type: string,
    content: Record<string, unknown>,
    wireRelation?: unknown,
  ) => {
    vault.set(`own-${eventId}`, { type, content });
    const event = await prepareIncomingEvent(
      {
        type: 'm.room.encrypted',
        room_id: ROOM,
        sender: OWNER,
        event_id: eventId,
        content: {
          algorithm: 'm.megolm.v1.aes-sha2',
          ciphertext: `own-${eventId}`,
          ...(wireRelation ? { 'm.relates_to': wireRelation } : {}),
        },
      },
      { rooms, isBridgeUser: (id) => id.startsWith('@zalo_'), onDecryptFailure: vi.fn() },
    );
    expect(event).not.toBeNull();
    return outbound.handle(event as never);
  };
  const queues = () => (inbound as unknown as { threadQueues: Map<string, unknown> }).threadQueues;
  const runInbound = async (voters: string[]) => {
    detail.current = poll(voters);
    inbound.handlePoll({ threadId: 'g1', action: 'update', actorId: 'u2', creatorId: 'u2', isSelf: false, pollId: 7 });
    await vi.waitFor(() => expect(queues().size).toBe(0));
  };
  return { store, vault, wire, zalo, deliverEncrypted, runInbound, detail, inbound };
}

describe('polls in an encrypted room: Zalo -> Matrix', () => {
  it('encrypts poll.start and poll.response, leaving only the relation readable on the wire', async () => {
    const t = setup();
    await t.runInbound([]);
    await t.runInbound(['u3']);

    expect(t.wire.map((e) => e.type)).toEqual(['m.room.encrypted', 'm.room.encrypted']);
    // nothing of the poll leaks into the wire content
    expect(JSON.stringify(t.wire[0]!.content)).not.toContain('Lunch?');
    expect(t.wire[0]!.content).not.toHaveProperty(POLL_START);

    const start = t.vault.get('ct1')!;
    expect(start.type).toBe(POLL_START);
    expect(start.content[POLL_START]).toMatchObject({ answers: [{ id: 'o11' }, { id: 'o12' }] });

    const relation = { rel_type: 'm.reference', event_id: '$ev1' };
    expect(t.wire[1]!.content['m.relates_to']).toEqual(relation);
    expect(t.vault.get('ct2')).toEqual({
      type: POLL_RESPONSE,
      content: { [POLL_RESPONSE]: { answers: ['o11'] }, 'm.relates_to': relation },
    });
  });

  it('encrypts poll.end too, with its reference intact', async () => {
    const t = setup();
    await t.runInbound([]);
    t.detail.current = { ...poll(), closed: true };
    t.inbound.handlePoll({ threadId: 'g1', action: 'remove', isSelf: false, pollId: 7 });
    await vi.waitFor(() => expect(t.wire).toHaveLength(2));
    expect(t.wire[1]!.type).toBe('m.room.encrypted');
    expect(t.wire[1]!.content['m.relates_to']).toEqual({ rel_type: 'm.reference', event_id: '$ev1' });
    expect(t.vault.get('ct2')!.type).toBe(POLL_END);
  });
});

describe('polls in an encrypted room: Matrix -> Zalo', () => {
  it('decrypts the owner poll.start and creates the Zalo poll', async () => {
    const t = setup();
    await t.deliverEncrypted('$own-poll', POLL_START, {
      [POLL_START]: {
        kind: 'org.matrix.msc3381.poll.disclosed',
        max_selections: 1,
        question: { 'org.matrix.msc1767.text': 'Lunch?' },
        answers: [
          { id: 'a1', 'org.matrix.msc1767.text': 'Pho' },
          { id: 'a2', 'org.matrix.msc1767.text': 'Bun' },
        ],
      },
    });
    expect(t.zalo.createPoll).toHaveBeenCalledWith('g1', {
      question: 'Lunch?',
      options: ['Pho', 'Bun'],
      multiChoice: false,
    });
    expect(t.store.getPollByEventId('$own-poll')).not.toBeNull();
  });

  it('keeps m.relates_to when it only travels next to the ciphertext (vote and end)', async () => {
    const t = setup();
    t.store.recordPoll({
      pollId: 7,
      roomId: ROOM,
      eventId: '$poll',
      creatorId: 'me',
      options: [
        { optionId: 11, answerId: 'a1', content: 'Pho' },
        { optionId: 12, answerId: 'a2', content: 'Bun' },
      ],
      multi: false,
    });
    const relation = { rel_type: 'm.reference', event_id: '$poll' };

    // relation outside the ciphertext only: the clear content has none
    const voteBody: Record<string, unknown> = { ...buildPollResponse('$poll', ['a2']) };
    delete voteBody['m.relates_to'];
    await t.deliverEncrypted('$vote', POLL_RESPONSE, voteBody, relation);
    expect(t.zalo.votePoll).toHaveBeenCalledWith(7, [12]);

    // relation inside the ciphertext only
    await t.deliverEncrypted('$end', POLL_END, buildPollEnd('$poll', 'done'));
    expect(t.zalo.lockPoll).toHaveBeenCalledWith(7);
  });

  it('does not loop a poll event the bridge itself encrypted back to Zalo', async () => {
    const t = setup();
    t.store.recordPoll({
      pollId: 7,
      roomId: ROOM,
      eventId: '$poll',
      creatorId: 'u2',
      options: [{ optionId: 11, answerId: 'o11', content: 'Pho' }],
      multi: false,
    });
    // a ghost's own encrypted event is dropped by prepareIncomingEvent before routing
    const event = await prepareIncomingEvent(
      { type: 'm.room.encrypted', room_id: ROOM, sender: '@zalo_u3:beeper.local', event_id: '$g', content: {} },
      {
        rooms: createRoomEncryption({} as never, async () => undefined),
        isBridgeUser: () => true,
        onDecryptFailure: vi.fn(),
      },
    );
    expect(event).toBeNull();
    expect(t.zalo.votePoll).not.toHaveBeenCalled();
  });
});
