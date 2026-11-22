// MSC3381 polls on the wire: content builders for the events the bridge posts and parsers
// for the ones Beeper sends. Pure functions, no Matrix client. Uses the unstable
// `org.matrix.msc3381.*` names (what Beeper / mautrix speak), with the MSC1767 text fallback.
import type { ZaloPoll } from '../zalo/types.ts';
import { isRecord } from '../util.ts';

export const POLL_START = 'org.matrix.msc3381.poll.start';
export const POLL_RESPONSE = 'org.matrix.msc3381.poll.response';
export const POLL_END = 'org.matrix.msc3381.poll.end';
const TEXT = 'org.matrix.msc1767.text';
const DISCLOSED = 'org.matrix.msc3381.poll.disclosed';

/** True for the three event types that make up a poll. */
export function isPollEventType(type: string): boolean {
  return type === POLL_START || type === POLL_RESPONSE || type === POLL_END;
}

/** Matrix answer id of a Zalo option (deterministic, so a vote can be mapped without a lookup). */
export const answerIdFor = (optionId: number): string => `o${optionId}`;

/** Zalo option id behind an answer id built by `answerIdFor`, or null for any other id. */
export function optionIdFor(answerId: string): number | null {
  const match = /^o(\d+)$/.exec(answerId);
  return match ? Number(match[1]) : null;
}

const reference = (eventId: string) => ({ rel_type: 'm.reference', event_id: eventId });

/** `poll.start` content of a Zalo poll: disclosed, with a numbered text fallback. */
export function buildPollStart(poll: ZaloPoll): Record<string, unknown> {
  const fallback = [poll.question, ...poll.options.map((option, i) => `${i + 1}. ${option.content}`)].join('\n');
  return {
    [POLL_START]: {
      kind: DISCLOSED,
      max_selections: poll.multiChoice ? Math.max(poll.options.length, 1) : 1,
      question: { [TEXT]: poll.question },
      answers: poll.options.map((option) => ({ id: answerIdFor(option.optionId), [TEXT]: option.content })),
    },
    [TEXT]: fallback,
  };
}

/** `poll.response` content: the voter's full current selection (empty = vote removed). */
export function buildPollResponse(startEventId: string, answerIds: string[]): Record<string, unknown> {
  return { [POLL_RESPONSE]: { answers: answerIds }, 'm.relates_to': reference(startEventId) };
}

/** `poll.end` content with its text fallback. */
export function buildPollEnd(startEventId: string, text: string): Record<string, unknown> {
  return { [POLL_END]: {}, [TEXT]: text, 'm.relates_to': reference(startEventId) };
}

export type ParsedPollStart = {
  question: string;
  answers: Array<{ id: string; text: string }>;
  maxSelections: number;
};

/** Text of an MSC1767 message part, accepting the `body` key some clients use. */
function textOf(part: unknown): string {
  if (!isRecord(part)) return '';
  const text = part[TEXT] ?? part.body;
  return typeof text === 'string' ? text.trim() : '';
}

/** Reads a `poll.start`; null when it has no question or no usable answer. */
export function parsePollStart(content: Record<string, unknown>): ParsedPollStart | null {
  const start = content[POLL_START];
  if (!isRecord(start)) return null;
  const question = textOf(start.question);
  const answers = Array.isArray(start.answers)
    ? start.answers.flatMap((answer) => {
        const text = textOf(answer);
        const id = isRecord(answer) ? answer.id : undefined;
        return text && typeof id === 'string' ? [{ id, text }] : [];
      })
    : [];
  if (!question || answers.length === 0) return null;
  const max = start.max_selections;
  return { question, answers, maxSelections: typeof max === 'number' && max >= 1 ? max : 1 };
}

/** The event a poll event refers to (`m.relates_to.event_id`), or null. */
function relatedEventId(content: Record<string, unknown>): string | null {
  const relation = content['m.relates_to'];
  return isRecord(relation) && typeof relation.event_id === 'string' ? relation.event_id : null;
}

/** Reads a `poll.response`: the poll it votes on and the chosen answer ids; null when malformed. */
export function parsePollResponse(
  content: Record<string, unknown>,
): { startEventId: string; answers: string[] } | null {
  const response = content[POLL_RESPONSE];
  const startEventId = relatedEventId(content);
  if (!isRecord(response) || !startEventId || !Array.isArray(response.answers)) return null;
  return { startEventId, answers: response.answers.filter((id): id is string => typeof id === 'string') };
}

/** The poll a `poll.end` closes, or null when it does not reference one. */
export function parsePollEnd(content: Record<string, unknown>): string | null {
  return content[POLL_END] === undefined ? null : relatedEventId(content);
}
