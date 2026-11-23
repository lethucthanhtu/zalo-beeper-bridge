import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ZaloPollEvent } from '../types.ts';
import { ZaloClient } from '../zalo-client.ts';

/** A logged-in client whose zca-js api is a stub. */
function clientWith(api: Record<string, unknown>) {
  const client = new ZaloClient({ credsPath: 'unused-poll-test.json', messagesPerMinute: 600, burst: 10 });
  (client as unknown as { api: unknown }).api = api;
  return client;
}

const DETAIL = {
  creator: 'u2',
  question: 'Lunch?',
  poll_id: 4242,
  closed: false,
  allow_multi_choices: false,
  is_anonymous: false,
  options: [
    { option_id: 1, content: 'Pho', votes: 1, voted: false, voters: ['u3'] },
    { option_id: 2, content: 'Bun', votes: 0, voted: false, voters: [] },
  ],
};

describe('ZaloClient poll events', () => {
  it('re-emits a poll group_event as a poll event, next to the pin wiring', () => {
    const listener = new EventEmitter();
    const client = clientWith({ listener });
    (client as unknown as { listenerManager: unknown }).listenerManager = { start: vi.fn() };
    const polls: ZaloPollEvent[] = [];
    const pins: unknown[] = [];
    client.on('poll', (event) => polls.push(event));
    client.on('pin', (event) => pins.push(event));
    client.startListening();

    listener.emit('group_event', {
      type: 'update_board',
      act: 'update_board',
      threadId: 'g1',
      isSelf: false,
      data: {
        sourceId: 'u3',
        groupId: 'g1',
        creatorId: 'u2',
        groupTopic: { type: 3, params: '{"pollId":4242,"title":"Lunch?"}' },
      },
    });
    listener.emit('group_event', { type: 'join', threadId: 'g1', isSelf: false, data: {} });
    expect(polls).toEqual([
      {
        threadId: 'g1',
        action: 'update',
        actorId: 'u3',
        creatorId: 'u2',
        isSelf: false,
        pollId: 4242,
        title: 'Lunch?',
      },
    ]);
    expect(pins).toEqual([]);
  });
});

describe('ZaloClient poll API', () => {
  it('createPoll maps the settings and returns the normalized poll', async () => {
    const api = { createPoll: vi.fn().mockResolvedValue(DETAIL) };
    const poll = await clientWith(api).createPoll('g1', {
      question: 'Lunch?',
      options: ['Pho', 'Bun'],
      multiChoice: true,
    });
    expect(api.createPoll).toHaveBeenCalledWith(
      { question: 'Lunch?', options: ['Pho', 'Bun'], allowMultiChoices: true },
      'g1',
    );
    expect(poll).toMatchObject({ pollId: 4242, options: [{ optionId: 1 }, { optionId: 2 }] });
  });

  it('getPollDetail normalizes the detail and returns null for a malformed one', async () => {
    const getPollDetail = vi.fn().mockResolvedValueOnce(DETAIL).mockResolvedValueOnce({});
    const client = clientWith({ getPollDetail });
    expect(await client.getPollDetail(4242)).toMatchObject({ pollId: 4242, question: 'Lunch?' });
    expect(getPollDetail).toHaveBeenCalledWith(4242);
    expect(await client.getPollDetail(4242)).toBeNull();
  });

  it('votePoll passes the option ids (empty list = unvote); lockPoll locks', async () => {
    const api = { votePoll: vi.fn().mockResolvedValue({ options: [] }), lockPoll: vi.fn().mockResolvedValue('') };
    const client = clientWith(api);
    await client.votePoll(4242, [1, 2]);
    await client.votePoll(4242, []);
    await client.lockPoll(4242);
    expect(api.votePoll.mock.calls).toEqual([
      [4242, [1, 2]],
      [4242, []],
    ]);
    expect(api.lockPoll).toHaveBeenCalledWith(4242);
  });

  it('throws without a session and rejects a malformed createPoll reply', async () => {
    const out = new ZaloClient({ credsPath: 'unused.json', messagesPerMinute: 600, burst: 10 });
    await expect(out.votePoll(1, [])).rejects.toThrow('Not logged in');
    await expect(out.getPollDetail(1)).rejects.toThrow('Not logged in');
    const bad = clientWith({ createPoll: vi.fn().mockResolvedValue({}) });
    await expect(bad.createPoll('g1', { question: 'q', options: ['a'], multiChoice: false })).rejects.toThrow(
      'unexpected poll',
    );
  });
});
