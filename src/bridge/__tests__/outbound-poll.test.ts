// Owner's Matrix polls → Zalo: poll.start creates a group poll, poll.response votes (empty =
// unvote), poll.end locks. DMs are rejected with a notice; bridge-posted and replayed events
// never loop back.
import { describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { MappingStore } from '../mapping-store.ts';
import { OutboundHandler } from '../outbound-handler.ts';
import { SELF_BRIDGE_MARKER } from '../self-bridge.ts';
import { buildPollEnd, buildPollResponse, POLL_END, POLL_RESPONSE, POLL_START } from '../poll-content.ts';
import type { ZaloPoll } from '../../zalo/types.ts';

const OWNER = '@owner:beeper.com';
const GROUP_ROOM = '!group:x';
const DM_ROOM = '!dm:x';

const created: ZaloPoll = {
  pollId: 7,
  question: 'Lunch?',
  creatorId: 'me',
  options: [
    { optionId: 11, content: 'Pho', votes: 0, voters: [] },
    { optionId: 12, content: 'Bun', votes: 0, voters: [] },
  ],
  closed: false,
  multiChoice: false,
  anonymous: false,
};

function setup() {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 'g1', thread_type: 'group', room_id: GROUP_ROOM, name: null });
  store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: DM_ROOM, name: null });
  const sendMessage = vi.fn(async (_room: string, _content: Record<string, unknown>) => ({ event_id: '$notice' }));
  const zalo = {
    ownId: 'me',
    createPoll: vi.fn(async (_groupId: string, _poll: unknown) => created),
    votePoll: vi.fn(async (_pollId: number, _optionIds: number[]) => undefined),
    lockPoll: vi.fn(async (_pollId: number) => undefined),
  };
  const echo = new EchoSuppressor();
  const bridgedEventIds = new Set<string>();
  const outbound = new OutboundHandler({
    bridge: { getIntent: () => ({ sendMessage }) },
    store,
    puppets: { intentFor: vi.fn(), uidFor: vi.fn() },
    zalo,
    echo,
    ownerUserId: OWNER,
    mediaMaxBytes: 1_000_000,
    homeserverUrl: 'http://hs',
    matrixToken: 'tok',
    bridgedEventIds,
  } as never);
  const send = (type: string, content: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    outbound.handle({ type, room_id: GROUP_ROOM, sender: OWNER, event_id: '$e1', content, ...over } as never);
  const notices = () => sendMessage.mock.calls.map((c) => c[1].body as string);
  /** a bridged poll the owner can vote on / end (answer ids as Beeper generates them) */
  const seedPoll = () =>
    store.recordPoll({
      pollId: 7,
      roomId: GROUP_ROOM,
      eventId: '$poll',
      creatorId: 'me',
      options: [
        { optionId: 11, answerId: 'uuid-a', content: 'Pho' },
        { optionId: 12, answerId: 'uuid-b', content: 'Bun' },
      ],
      multi: true,
    });
  return { store, zalo, echo, bridgedEventIds, send, notices, sendMessage, seedPoll };
}

const startContent = (maxSelections = 1) => ({
  [POLL_START]: {
    kind: 'org.matrix.msc3381.poll.disclosed',
    max_selections: maxSelections,
    question: { 'org.matrix.msc1767.text': 'Lunch?' },
    answers: [
      { id: 'uuid-a', 'org.matrix.msc1767.text': 'Pho' },
      { id: 'uuid-b', 'org.matrix.msc1767.text': 'Bun' },
    ],
  },
  'org.matrix.msc1767.text': 'Lunch?\n1. Pho\n2. Bun',
});

describe('OutboundHandler polls: create', () => {
  it('creates a Zalo poll in a group and records the mapping with Beeper answer ids', async () => {
    const t = setup();
    expect(await t.send(POLL_START, startContent(2), { event_id: '$poll' })).toBe(true);

    expect(t.zalo.createPoll).toHaveBeenCalledWith('g1', {
      question: 'Lunch?',
      options: ['Pho', 'Bun'],
      multiChoice: true,
    });
    const row = t.store.getPollByEventId('$poll')!;
    expect(row).toMatchObject({ pollId: 7, roomId: GROUP_ROOM, creatorId: 'me', multi: true, closed: false });
    expect(row.options).toEqual([
      { optionId: 11, answerId: 'uuid-a', content: 'Pho' },
      { optionId: 12, answerId: 'uuid-b', content: 'Bun' },
    ]);
    expect(t.notices()).toEqual([]);
  });

  it('arms the echo guard before calling Zalo, so the update_board echo is skipped', async () => {
    const t = setup();
    t.zalo.createPoll.mockImplementationOnce(async () => {
      expect(t.echo.consumePoll('g1')).toBe(true); // armed while the call is in flight
      t.echo.expectPoll('g1');
      return created;
    });
    await t.send(POLL_START, startContent());
    expect(t.echo.consumePoll('g1')).toBe(true);
  });

  it('rejects a poll in a DM with a notice and never calls Zalo', async () => {
    const t = setup();
    await t.send(POLL_START, startContent(), { room_id: DM_ROOM });
    expect(t.zalo.createPoll).not.toHaveBeenCalled();
    expect(t.notices()).toHaveLength(1);
    expect(t.notices()[0]).toMatch(/group/i);
  });

  it('reports a Zalo failure, disarms the echo guard and allows a retry', async () => {
    const t = setup();
    t.zalo.createPoll.mockRejectedValueOnce(new Error('rate limited'));
    await t.send(POLL_START, startContent(), { event_id: '$poll' });
    expect(t.notices()[0]).toContain('rate limited');
    expect(t.echo.consumePoll('g1')).toBe(false);
    expect(t.store.getPollByEventId('$poll')).toBeNull();

    await t.send(POLL_START, startContent(), { event_id: '$poll' }); // same event, redelivered
    expect(t.zalo.createPoll).toHaveBeenCalledTimes(2);
    expect(t.store.getPollByEventId('$poll')).not.toBeNull();
  });

  it('tells the owner when the poll has no question or answers', async () => {
    const t = setup();
    await t.send(POLL_START, { [POLL_START]: { answers: [] } });
    expect(t.zalo.createPoll).not.toHaveBeenCalled();
    expect(t.notices()).toHaveLength(1);
  });
});

describe('OutboundHandler polls: vote', () => {
  it('maps the chosen answer ids to Zalo option ids and stores the vote first', async () => {
    const t = setup();
    t.seedPoll();
    t.zalo.votePoll.mockImplementationOnce(async () => {
      expect(t.store.getPollById(7)!.votes).toEqual({ me: [11, 12] }); // stored before the call
    });
    await t.send(POLL_RESPONSE, buildPollResponse('$poll', ['uuid-a', 'uuid-b']), { event_id: '$r1' });
    expect(t.zalo.votePoll).toHaveBeenCalledWith(7, [11, 12]);
    expect(t.notices()).toEqual([]);
  });

  it('treats an empty answer list as an unvote', async () => {
    const t = setup();
    t.seedPoll();
    t.store.setPollVotes(7, { me: [11], u3: [12] });
    await t.send(POLL_RESPONSE, buildPollResponse('$poll', []), { event_id: '$r2' });
    expect(t.zalo.votePoll).toHaveBeenCalledWith(7, []);
    expect(t.store.getPollById(7)!.votes).toEqual({ u3: [12] });
  });

  it('ignores answer ids the poll does not have', async () => {
    const t = setup();
    t.seedPoll();
    await t.send(POLL_RESPONSE, buildPollResponse('$poll', ['uuid-a', 'bogus']), { event_id: '$r3' });
    expect(t.zalo.votePoll).toHaveBeenCalledWith(7, [11]);
  });

  it('restores the stored votes and tells the owner when Zalo refuses the vote', async () => {
    const t = setup();
    t.seedPoll();
    t.store.setPollVotes(7, { me: [12] });
    t.zalo.votePoll.mockRejectedValueOnce(new Error('poll locked'));
    await t.send(POLL_RESPONSE, buildPollResponse('$poll', ['uuid-a']), { event_id: '$r4' });
    expect(t.store.getPollById(7)!.votes).toEqual({ me: [12] });
    expect(t.notices()[0]).toContain('poll locked');
  });

  it('ignores a vote on a poll that was never bridged', async () => {
    const t = setup();
    await t.send(POLL_RESPONSE, buildPollResponse('$unknown', ['uuid-a']));
    expect(t.zalo.votePoll).not.toHaveBeenCalled();
    expect(t.notices()).toEqual([]);
  });

  it('does not vote on a poll that is already closed', async () => {
    const t = setup();
    t.seedPoll();
    t.store.closePoll(7);
    await t.send(POLL_RESPONSE, buildPollResponse('$poll', ['uuid-a']));
    expect(t.zalo.votePoll).not.toHaveBeenCalled();
  });
});

describe('OutboundHandler polls: end', () => {
  it('marks the poll closed, then locks it on Zalo', async () => {
    const t = setup();
    t.seedPoll();
    t.zalo.lockPoll.mockImplementationOnce(async () => {
      expect(t.store.getPollById(7)!.closed).toBe(true); // closed before the call
    });
    await t.send(POLL_END, buildPollEnd('$poll', 'Poll ended'), { event_id: '$end' });
    expect(t.zalo.lockPoll).toHaveBeenCalledWith(7);
    expect(t.store.getPollById(7)!.closed).toBe(true);
    expect(t.notices()).toEqual([]);
  });

  it('reopens the poll and tells the owner when Zalo refuses to lock it', async () => {
    const t = setup();
    t.seedPoll();
    t.zalo.lockPoll.mockRejectedValueOnce(new Error('not the creator'));
    await t.send(POLL_END, buildPollEnd('$poll', 'Poll ended'), { event_id: '$end' });
    expect(t.store.getPollById(7)!.closed).toBe(false);
    expect(t.notices()[0]).toContain('not the creator');
  });

  it('does nothing for a poll that is unknown or already closed', async () => {
    const t = setup();
    await t.send(POLL_END, buildPollEnd('$unknown', 'x'));
    t.seedPoll();
    t.store.closePoll(7);
    await t.send(POLL_END, buildPollEnd('$poll', 'x'), { event_id: '$end2' });
    expect(t.zalo.lockPoll).not.toHaveBeenCalled();
  });
});

describe('OutboundHandler polls: echo suppression', () => {
  it('skips events the bridge posted as the owner (SELF_BRIDGE_MARKER)', async () => {
    const t = setup();
    t.seedPoll();
    await t.send(POLL_START, { ...startContent(), [SELF_BRIDGE_MARKER]: true });
    await t.send(POLL_RESPONSE, { ...buildPollResponse('$poll', ['uuid-a']), [SELF_BRIDGE_MARKER]: true });
    await t.send(POLL_END, { ...buildPollEnd('$poll', 'x'), [SELF_BRIDGE_MARKER]: true });
    expect(t.zalo.createPoll).not.toHaveBeenCalled();
    expect(t.zalo.votePoll).not.toHaveBeenCalled();
    expect(t.zalo.lockPoll).not.toHaveBeenCalled();
  });

  it('skips events remembered in bridgedEventIds', async () => {
    const t = setup();
    t.seedPoll();
    t.bridgedEventIds.add('$mine');
    await t.send(POLL_RESPONSE, buildPollResponse('$poll', ['uuid-a']), { event_id: '$mine' });
    expect(t.zalo.votePoll).not.toHaveBeenCalled();
  });

  it('handles a redelivered event only once', async () => {
    const t = setup();
    t.seedPoll();
    await t.send(POLL_RESPONSE, buildPollResponse('$poll', ['uuid-a']), { event_id: '$r1' });
    await t.send(POLL_RESPONSE, buildPollResponse('$poll', ['uuid-a']), { event_id: '$r1' });
    expect(t.zalo.votePoll).toHaveBeenCalledTimes(1);
  });

  it('ignores poll events from anyone but the owner', async () => {
    const t = setup();
    t.seedPoll();
    await t.send(POLL_START, startContent(), { sender: '@someone:beeper.com' });
    await t.send(POLL_RESPONSE, buildPollResponse('$poll', ['uuid-a']), { sender: '@someone:beeper.com' });
    expect(t.zalo.createPoll).not.toHaveBeenCalled();
    expect(t.zalo.votePoll).not.toHaveBeenCalled();
  });

  it('still reports poll events of rooms without a portal as unhandled', async () => {
    const t = setup();
    expect(await t.send(POLL_START, startContent(), { room_id: '!other:x' })).toBe(false);
  });
});
