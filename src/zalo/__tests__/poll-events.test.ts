import { describe, expect, it } from 'vitest';
import { normalizeGroupPollEvent, normalizePollDetail } from '../poll-events.ts';

// Synthetic fixtures shaped after the zca-js GroupEvent / TGroupEventBoard type definitions.
const topic = (over: Record<string, unknown> = {}) => ({
  type: 3, // GroupTopicType.Poll
  id: 'topic1',
  creatorId: 'u2',
  params: JSON.stringify({ pollId: 4242, title: 'Lunch?' }),
  ...over,
});
const boardEvent = (type: string, data: Record<string, unknown> = {}, isSelf = false) => ({
  type,
  act: type,
  threadId: 'g1',
  isSelf,
  data: { sourceId: 'u3', groupId: 'g1', groupName: 'Team', creatorId: 'u2', groupTopic: topic(), ...data },
});

describe('normalizeGroupPollEvent', () => {
  it('maps update_board of a poll topic, with the actor from sourceId', () => {
    expect(normalizeGroupPollEvent(boardEvent('update_board') as never)).toEqual({
      threadId: 'g1',
      action: 'update',
      actorId: 'u3',
      creatorId: 'u2',
      isSelf: false,
      pollId: 4242,
      title: 'Lunch?',
    });
  });

  it('maps remove_board to a remove and marks the own account', () => {
    const event = normalizeGroupPollEvent(boardEvent('remove_board', {}, true) as never);
    expect(event).toMatchObject({ action: 'remove', pollId: 4242, isSelf: true });
  });

  it('accepts params as an object and a string poll id', () => {
    const groupTopic = topic({ params: { pollId: '77', title: 'x' } });
    expect(normalizeGroupPollEvent(boardEvent('update_board', { groupTopic }) as never)).toMatchObject({
      pollId: 77,
      title: 'x',
    });
  });

  it('ignores notes and other board topics', () => {
    const note = topic({ type: 0, params: JSON.stringify({ title: 'a note' }) });
    expect(normalizeGroupPollEvent(boardEvent('update_board', { groupTopic: note }) as never)).toBeNull();
  });

  it('ignores other group events', () => {
    expect(normalizeGroupPollEvent(boardEvent('new_pin_topic') as never)).toBeNull();
  });

  it.each([
    ['no payload', { type: 'update_board' }],
    ['no topic', boardEvent('update_board', { groupTopic: undefined })],
    ['unparseable params', boardEvent('update_board', { groupTopic: topic({ params: '{oops' }) })],
    ['no poll id', boardEvent('update_board', { groupTopic: topic({ params: '{"title":"t"}' }) })],
    ['no thread id', { ...boardEvent('update_board'), threadId: '' }],
    ['not an object', 'x'],
  ])('returns null for %s', (_label, event) => {
    expect(normalizeGroupPollEvent(event as never)).toBeNull();
  });
});

describe('normalizePollDetail', () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    creator: 'u2',
    question: 'Lunch?',
    poll_id: 4242,
    closed: false,
    allow_multi_choices: true,
    is_anonymous: false,
    options: [
      { option_id: 1, content: 'Pho', votes: 2, voted: false, voters: ['u3', 7] },
      { option_id: 2, content: 'Bun', votes: 0, voted: false, voters: [] },
    ],
    ...over,
  });

  it('maps the options, voters and settings', () => {
    expect(normalizePollDetail(detail())).toEqual({
      pollId: 4242,
      question: 'Lunch?',
      creatorId: 'u2',
      closed: false,
      multiChoice: true,
      anonymous: false,
      options: [
        { optionId: 1, content: 'Pho', votes: 2, voters: ['u3', '7'] },
        { optionId: 2, content: 'Bun', votes: 0, voters: [] },
      ],
    });
  });

  it('reads the closed flag and tolerates options without voters', () => {
    const poll = normalizePollDetail(detail({ closed: true, options: [{ option_id: 5, content: 'A', votes: 3 }] }));
    expect(poll).toMatchObject({ closed: true, options: [{ optionId: 5, votes: 3, voters: [] }] });
  });

  it.each([[null], [{}], [detail({ options: undefined })], [detail({ poll_id: undefined })]])(
    'returns null for a payload without poll id or options (%#)',
    (value) => {
      expect(normalizePollDetail(value)).toBeNull();
    },
  );
});
