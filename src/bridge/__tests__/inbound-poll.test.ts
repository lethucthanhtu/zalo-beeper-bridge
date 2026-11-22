// Zalo group polls → MSC3381 events: creation as poll.start from the creator's ghost, votes
// as poll.response from each voter's ghost, lock / removal as poll.end.
import { describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';
import { InboundHandler } from '../inbound-handler.ts';
import { MappingStore } from '../mapping-store.ts';
import { SELF_BRIDGE_MARKER } from '../self-bridge.ts';
import { POLL_END, POLL_RESPONSE, POLL_START } from '../poll-content.ts';
import type { ZaloPoll, ZaloPollEvent } from '../../zalo/types.ts';

const OWNER = '@owner:beeper.com';
const ROOM = '!group:x';

const option = (optionId: number, content: string, voters: string[] = []) => ({
  optionId,
  content,
  votes: voters.length,
  voters,
});
const basePoll = (over: Partial<ZaloPoll> = {}): ZaloPoll => ({
  pollId: 7,
  question: 'Lunch?',
  creatorId: 'u2',
  options: [option(11, 'Pho'), option(12, 'Bun')],
  closed: false,
  multiChoice: false,
  anonymous: false,
  ...over,
});

/** Handler over a real in-memory store with recording intents (bot, creator ghost, voter ghost, owner). */
function setup() {
  const store = new MappingStore(':memory:');
  store.insertPortal({ thread_id: 'g1', thread_type: 'group', room_id: ROOM, name: null });
  store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!dm:x', name: null });
  let counter = 0;
  const makeIntent = (name: string) => ({
    name,
    opts: {},
    sendMessage: vi.fn(async (_room: string, _content: Record<string, unknown>) => ({ event_id: `$${name}-notice` })),
    sendEvent: vi.fn(async (_room: string, _type: string, _content: Record<string, unknown>) => ({
      event_id: `$${name}-${++counter}`,
    })),
  });
  const bot = makeIntent('bot');
  const owner = makeIntent('owner');
  const ghosts = new Map<string, ReturnType<typeof makeIntent>>();
  const ghostOf = (uid: string) => {
    if (!ghosts.has(uid)) ghosts.set(uid, makeIntent(uid));
    return ghosts.get(uid)!;
  };
  const poll = { current: basePoll() as ZaloPoll | null };
  const deps = {
    bridge: { getIntent: vi.fn((userId?: string) => (userId === OWNER ? owner : bot)) },
    store,
    puppets: {
      ensurePuppet: vi.fn(async (uid: string) => ghostOf(uid)),
      intentFor: vi.fn((uid: string) => ghostOf(uid)),
    },
    portals: { ensureGhostInRoom: vi.fn(async () => undefined), ensureBotInRoom: vi.fn(async () => undefined) },
    echo: new EchoSuppressor(),
    ownerUserId: OWNER,
    mediaMaxBytes: 1,
    resolveGroupName: async () => null,
    resolveStickerUrl: async () => null,
    getOwnZaloId: () => 'me',
    bridgedEventIds: new Set<string>(),
    getPollDetail: vi.fn(async (_pollId: number) => poll.current),
  };
  const handler = new InboundHandler(deps as never);
  const event = (over: Partial<ZaloPollEvent> = {}): ZaloPollEvent => ({
    threadId: 'g1',
    action: 'update',
    actorId: 'u2',
    creatorId: 'u2',
    isSelf: false,
    pollId: 7,
    ...over,
  });
  const queues = () => (handler as unknown as { threadQueues: Map<string, unknown> }).threadQueues;
  const run = async (e: ZaloPollEvent) => {
    handler.handlePoll(e);
    await vi.waitFor(() => expect(queues().size).toBe(0));
  };
  return { store, deps, bot, owner, ghostOf, ghosts, poll, event, run };
}

describe('InboundHandler polls: creation', () => {
  it('posts poll.start as the creator ghost and records the mapping', async () => {
    const t = setup();
    await t.run(t.event());

    expect(t.deps.getPollDetail).toHaveBeenCalledWith(7);
    expect(t.deps.puppets.ensurePuppet).toHaveBeenCalledWith('u2', undefined);
    expect(t.deps.portals.ensureGhostInRoom).toHaveBeenCalledWith('u2', ROOM, undefined);
    const creator = t.ghostOf('u2');
    expect(creator.sendEvent).toHaveBeenCalledTimes(1);
    const [room, type, content] = creator.sendEvent.mock.calls[0]!;
    expect(room).toBe(ROOM);
    expect(type).toBe(POLL_START);
    expect(content[POLL_START]).toMatchObject({
      kind: 'org.matrix.msc3381.poll.disclosed',
      max_selections: 1,
      answers: [{ id: 'o11' }, { id: 'o12' }],
    });
    expect(content['org.matrix.msc1767.text']).toBe('Lunch?\n1. Pho\n2. Bun');
    expect(content[SELF_BRIDGE_MARKER]).toBeUndefined();

    const row = t.store.getPollById(7)!;
    expect(row).toMatchObject({ roomId: ROOM, eventId: '$u2-1', creatorId: 'u2', multi: false, closed: false });
    expect(row.options).toEqual([
      { optionId: 11, answerId: 'o11', content: 'Pho' },
      { optionId: 12, answerId: 'o12', content: 'Bun' },
    ]);
  });

  it('allows several selections for a multi-choice poll', async () => {
    const t = setup();
    t.poll.current = basePoll({ multiChoice: true });
    await t.run(t.event());
    const content = t.ghostOf('u2').sendEvent.mock.calls[0]![2];
    expect((content[POLL_START] as { max_selections: number }).max_selections).toBe(2);
  });

  it('posts a poll created on the phone as the owner, tagged and remembered against echo', async () => {
    const t = setup();
    t.poll.current = basePoll({ creatorId: 'me' });
    await t.run(t.event({ isSelf: true, actorId: 'me', creatorId: 'me' }));

    expect(t.owner.sendEvent).toHaveBeenCalledTimes(1);
    expect(t.owner.sendEvent.mock.calls[0]![2][SELF_BRIDGE_MARKER]).toBe(true);
    expect(t.deps.bridgedEventIds.has('$owner-1')).toBe(true);
    expect(t.deps.puppets.ensurePuppet).not.toHaveBeenCalled();
  });

  it('skips the echo of a poll the owner just created from Beeper', async () => {
    const t = setup();
    t.deps.echo.expectPoll('g1');
    await t.run(t.event({ isSelf: true, actorId: 'me', creatorId: 'me' }));
    expect(t.deps.getPollDetail).not.toHaveBeenCalled();
    expect(t.owner.sendEvent).not.toHaveBeenCalled();
    expect(t.store.getPollById(7)).toBeNull();
  });

  it('does not post a poll twice when Zalo repeats its event', async () => {
    const t = setup();
    await t.run(t.event());
    await t.run(t.event());
    expect(t.ghostOf('u2').sendEvent).toHaveBeenCalledTimes(1);
  });

  it('ignores polls of threads without a portal and DM threads', async () => {
    const t = setup();
    await t.run(t.event({ threadId: 'nobody' }));
    await t.run(t.event({ threadId: 't1' }));
    expect(t.deps.getPollDetail).not.toHaveBeenCalled();
    expect(t.ghosts.size).toBe(0);
  });

  it('drops an event whose poll detail cannot be read', async () => {
    const t = setup();
    t.poll.current = null;
    await t.run(t.event());
    expect(t.store.getPollById(7)).toBeNull();
    expect(t.bot.sendEvent).not.toHaveBeenCalled();
  });
});

describe('InboundHandler polls: votes', () => {
  it('posts a poll.response from each voter ghost with their full selection', async () => {
    const t = setup();
    await t.run(t.event());
    t.poll.current = basePoll({
      options: [option(11, 'Pho', ['u3', 'u4']), option(12, 'Bun', ['u3'])],
      multiChoice: true,
    });
    await t.run(t.event({ actorId: 'u3' }));

    const u3 = t.ghostOf('u3').sendEvent.mock.calls[0]!;
    expect(u3[1]).toBe(POLL_RESPONSE);
    expect(u3[2]).toEqual({
      [POLL_RESPONSE]: { answers: ['o11', 'o12'] },
      'm.relates_to': { rel_type: 'm.reference', event_id: '$u2-1' },
    });
    expect(t.ghostOf('u4').sendEvent.mock.calls[0]![2][POLL_RESPONSE]).toEqual({ answers: ['o11'] });
    expect(t.deps.portals.ensureGhostInRoom).toHaveBeenCalledWith('u3', ROOM, undefined);
    expect(t.store.getPollById(7)!.votes).toEqual({ u3: [11, 12], u4: [11] });
  });

  it('sends only what changed: a moved vote, then a withdrawn vote as an empty response', async () => {
    const t = setup();
    t.poll.current = basePoll({ options: [option(11, 'Pho', ['u3']), option(12, 'Bun')] });
    await t.run(t.event()); // creation also bridges the vote already in place
    expect(t.ghostOf('u3').sendEvent).toHaveBeenCalledTimes(1);

    await t.run(t.event()); // nothing changed
    expect(t.ghostOf('u3').sendEvent).toHaveBeenCalledTimes(1);

    t.poll.current = basePoll({ options: [option(11, 'Pho'), option(12, 'Bun', ['u3'])] });
    await t.run(t.event({ actorId: 'u3' }));
    expect(t.ghostOf('u3').sendEvent.mock.calls[1]![2][POLL_RESPONSE]).toEqual({ answers: ['o12'] });

    t.poll.current = basePoll();
    await t.run(t.event({ actorId: 'u3' }));
    expect(t.ghostOf('u3').sendEvent.mock.calls[2]![2][POLL_RESPONSE]).toEqual({ answers: [] });
    expect(t.store.getPollById(7)!.votes).toEqual({});
  });

  it('bridges the account own vote as the owner, tagged against echo', async () => {
    const t = setup();
    await t.run(t.event());
    t.poll.current = basePoll({ options: [option(11, 'Pho', ['me']), option(12, 'Bun')] });
    await t.run(t.event({ isSelf: true, actorId: 'me' }));
    const call = t.owner.sendEvent.mock.calls[0]!;
    expect(call[1]).toBe(POLL_RESPONSE);
    expect(call[2][SELF_BRIDGE_MARKER]).toBe(true);
    expect(t.deps.bridgedEventIds.has('$owner-2')).toBe(true);
  });

  it('stays quiet when a vote the owner made from Beeper is echoed back', async () => {
    const t = setup();
    await t.run(t.event());
    // OutboundHandler stores the owner vote before calling Zalo
    t.store.setPollVotes(7, { me: [11] });
    t.poll.current = basePoll({ options: [option(11, 'Pho', ['me']), option(12, 'Bun')] });
    await t.run(t.event({ isSelf: true, actorId: 'me' }));
    expect(t.owner.sendEvent).not.toHaveBeenCalled();
  });

  it('posts a bot notice with the tallies when the poll is anonymous', async () => {
    const t = setup();
    t.poll.current = basePoll({ anonymous: true });
    await t.run(t.event());
    t.poll.current = basePoll({
      anonymous: true,
      options: [{ optionId: 11, content: 'Pho', votes: 2, voters: [] }, option(12, 'Bun')],
    });
    await t.run(t.event({ actorId: 'u3' }));

    expect(t.ghosts.has('u3')).toBe(false);
    expect(t.bot.sendMessage).toHaveBeenCalledTimes(1);
    const notice = t.bot.sendMessage.mock.calls[0]![1];
    expect(notice).toMatchObject({ msgtype: 'm.notice' });
    expect(notice.body).toContain('Lunch?');
    expect(notice.body).toContain('Pho: 2');
    expect(notice.body).toContain('Bun: 0');

    await t.run(t.event({ actorId: 'u3' })); // same tallies again
    expect(t.bot.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('InboundHandler polls: end', () => {
  it('posts poll.end once when Zalo reports the poll locked, after the last votes', async () => {
    const t = setup();
    await t.run(t.event());
    t.poll.current = basePoll({ closed: true, options: [option(11, 'Pho', ['u3']), option(12, 'Bun')] });
    await t.run(t.event({ actorId: 'u2' }));

    const sent = t.ghostOf('u2').sendEvent.mock.calls.map((c) => c[1]);
    expect(sent).toEqual([POLL_START, POLL_END]);
    expect(t.ghostOf('u3').sendEvent.mock.calls[0]![1]).toBe(POLL_RESPONSE);
    const end = t.ghostOf('u2').sendEvent.mock.calls[1]![2];
    expect(end['m.relates_to']).toEqual({ rel_type: 'm.reference', event_id: '$u2-1' });
    expect(t.store.getPollById(7)!.closed).toBe(true);

    await t.run(t.event()); // a replay posts nothing more
    expect(t.ghostOf('u2').sendEvent).toHaveBeenCalledTimes(2);
  });

  it('posts poll.end when the poll is removed, without reading its detail', async () => {
    const t = setup();
    await t.run(t.event());
    t.deps.getPollDetail.mockClear();
    await t.run(t.event({ action: 'remove' }));

    expect(t.deps.getPollDetail).not.toHaveBeenCalled();
    expect(t.ghostOf('u2').sendEvent.mock.calls[1]![1]).toBe(POLL_END);
    expect(t.store.getPollById(7)!.closed).toBe(true);
  });

  it('ignores the removal of a poll that was never bridged', async () => {
    const t = setup();
    await t.run(t.event({ action: 'remove' }));
    expect(t.bot.sendEvent).not.toHaveBeenCalled();
    expect(t.ghosts.size).toBe(0);
  });

  it('does not repeat poll.end for a poll the owner already locked from Beeper', async () => {
    const t = setup();
    await t.run(t.event());
    t.store.closePoll(7); // OutboundHandler marks it closed before calling lockPoll
    t.poll.current = basePoll({ closed: true });
    await t.run(t.event({ isSelf: true, actorId: 'me' }));
    expect(t.ghostOf('u2').sendEvent).toHaveBeenCalledTimes(1);
  });

  it('falls back to the bot for poll.end when the creator may not post it', async () => {
    const t = setup();
    await t.run(t.event());
    t.ghostOf('u2').sendEvent.mockRejectedValueOnce(new Error('M_FORBIDDEN'));
    await t.run(t.event({ action: 'remove' }));
    expect(t.bot.sendEvent.mock.calls[0]![1]).toBe(POLL_END);
  });
});
