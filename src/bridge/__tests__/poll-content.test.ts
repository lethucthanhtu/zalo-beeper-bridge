// MSC3381 poll event builders and parsers (pure, no Matrix client).
import { describe, expect, it } from 'vitest';
import {
  answerIdFor,
  buildPollEnd,
  buildPollResponse,
  buildPollStart,
  isPollEventType,
  optionIdFor,
  parsePollEnd,
  parsePollResponse,
  parsePollStart,
  POLL_END,
  POLL_RESPONSE,
  POLL_START,
} from '../poll-content.ts';
import type { ZaloPoll } from '../../zalo/types.ts';

const poll: ZaloPoll = {
  pollId: 7,
  question: 'Lunch?',
  options: [
    { optionId: 11, content: 'Pho', votes: 0, voters: [] },
    { optionId: 12, content: 'Bun', votes: 0, voters: [] },
  ],
  closed: false,
  multiChoice: false,
  anonymous: false,
};

describe('poll ids', () => {
  it('maps option ids to answer ids and back', () => {
    expect(answerIdFor(11)).toBe('o11');
    expect(optionIdFor('o11')).toBe(11);
    expect(optionIdFor('nope')).toBeNull();
    expect(optionIdFor('o1x')).toBeNull();
  });

  it('recognises the three poll event types', () => {
    expect([POLL_START, POLL_RESPONSE, POLL_END].every(isPollEventType)).toBe(true);
    expect(isPollEventType('m.room.message')).toBe(false);
  });
});

describe('buildPollStart', () => {
  it('builds a disclosed single-choice poll with a text fallback', () => {
    const content = buildPollStart(poll);
    expect(content[POLL_START]).toEqual({
      kind: 'org.matrix.msc3381.poll.disclosed',
      max_selections: 1,
      question: { 'org.matrix.msc1767.text': 'Lunch?' },
      answers: [
        { id: 'o11', 'org.matrix.msc1767.text': 'Pho' },
        { id: 'o12', 'org.matrix.msc1767.text': 'Bun' },
      ],
    });
    expect(content['org.matrix.msc1767.text']).toBe('Lunch?\n1. Pho\n2. Bun');
  });

  it('allows every option for a multi-choice poll', () => {
    const content = buildPollStart({ ...poll, multiChoice: true });
    expect((content[POLL_START] as { max_selections: number }).max_selections).toBe(2);
  });

  it('round-trips through the parser', () => {
    expect(parsePollStart(buildPollStart({ ...poll, multiChoice: true }))).toEqual({
      question: 'Lunch?',
      answers: [
        { id: 'o11', text: 'Pho' },
        { id: 'o12', text: 'Bun' },
      ],
      maxSelections: 2,
    });
  });
});

describe('parsePollStart', () => {
  it('reads a poll another client wrote, with defaults', () => {
    expect(
      parsePollStart({
        [POLL_START]: {
          question: { 'org.matrix.msc1767.text': 'Q' },
          answers: [{ id: 'a', 'org.matrix.msc1767.text': 'A' }],
        },
      }),
    ).toEqual({ question: 'Q', answers: [{ id: 'a', text: 'A' }], maxSelections: 1 });
  });

  it('falls back to the plain "body" key', () => {
    expect(
      parsePollStart({
        [POLL_START]: { question: { body: 'Q' }, answers: [{ id: 'a', body: 'A' }], max_selections: 3 },
      }),
    ).toEqual({ question: 'Q', answers: [{ id: 'a', text: 'A' }], maxSelections: 3 });
  });

  it.each([
    {},
    { [POLL_START]: {} },
    { [POLL_START]: { question: { 'org.matrix.msc1767.text': 'Q' }, answers: [] } },
    { [POLL_START]: { question: { 'org.matrix.msc1767.text': '  ' }, answers: [{ id: 'a', body: 'A' }] } },
  ])('rejects a malformed poll %#', (content) => {
    expect(parsePollStart(content)).toBeNull();
  });
});

describe('response and end', () => {
  it('builds and parses a response with its reference', () => {
    const content = buildPollResponse('$start', ['o11']);
    expect(content).toEqual({
      [POLL_RESPONSE]: { answers: ['o11'] },
      'm.relates_to': { rel_type: 'm.reference', event_id: '$start' },
    });
    expect(parsePollResponse(content)).toEqual({ startEventId: '$start', answers: ['o11'] });
  });

  it('parses an empty answer list as an unvote', () => {
    expect(parsePollResponse(buildPollResponse('$start', []))).toEqual({ startEventId: '$start', answers: [] });
  });

  it('rejects a response without a reference or answers array', () => {
    expect(parsePollResponse({ [POLL_RESPONSE]: { answers: [] } })).toBeNull();
    expect(
      parsePollResponse({ [POLL_RESPONSE]: {}, 'm.relates_to': { rel_type: 'm.reference', event_id: '$s' } }),
    ).toBeNull();
  });

  it('builds and parses an end event', () => {
    const content = buildPollEnd('$start', 'Poll closed');
    expect(content[POLL_END]).toEqual({});
    expect(content['org.matrix.msc1767.text']).toBe('Poll closed');
    expect(parsePollEnd(content)).toBe('$start');
    expect(parsePollEnd({ 'm.relates_to': { event_id: '$s' } })).toBeNull();
  });
});
