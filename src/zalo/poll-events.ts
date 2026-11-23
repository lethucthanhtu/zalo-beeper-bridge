// Zalo group polls -> ZaloPollEvent / ZaloPoll. All zca-js payload quirks for polls live here.
// Polls are delivered as `group_event` board events (update_board = create / vote / lock,
// remove_board = delete) whose groupTopic (type 3) carries `params` = {pollId, title}. Plain
// strings and numbers are used instead of the zca-js enums: this module must stay free of
// runtime imports.
import { asId, asRecord, parseParams } from '../util.ts';
import type { ZaloPoll, ZaloPollEvent } from './types.ts';

/** zca-js GroupTopicType.Poll. */
const TOPIC_TYPE_POLL = 3;

/** A numeric poll / option id (zca-js sends them as numbers, JSON params may stringify them). */
const asNumericId = (value: unknown): number | undefined => {
  const id = typeof value === 'string' && value !== '' ? Number(value) : value;
  return typeof id === 'number' && Number.isFinite(id) ? id : undefined;
};

/**
 * Group `update_board` / `remove_board` of a poll topic -> poll event. Notes and every other
 * group event are not polls.
 *
 * @param event raw zca-js GroupEvent
 * @returns null when the event is not a poll event or its payload is malformed
 */
export function normalizeGroupPollEvent(event: unknown): ZaloPollEvent | null {
  const raw = asRecord(event);
  const data = asRecord(raw?.data);
  const topic = asRecord(data?.groupTopic);
  if (!raw || !data || !topic) return null;
  let action: ZaloPollEvent['action'];
  if (raw.type === 'update_board') action = 'update';
  else if (raw.type === 'remove_board') action = 'remove';
  else return null;
  if (topic.type !== TOPIC_TYPE_POLL) return null;
  const params = parseParams(topic.params);
  const pollId = asNumericId(params?.pollId);
  const threadId = asId(raw.threadId);
  if (pollId === undefined || !threadId) return null;
  return {
    threadId,
    action,
    actorId: asId(data.sourceId),
    creatorId: asId(data.creatorId),
    isSelf: raw.isSelf === true,
    pollId,
    title: typeof params?.title === 'string' ? params.title : undefined,
  };
}

/**
 * zca-js PollDetail (getPollDetail / createPoll) -> ZaloPoll.
 *
 * @returns null when the payload has no poll id or options
 */
export function normalizePollDetail(detail: unknown): ZaloPoll | null {
  const raw = asRecord(detail);
  const pollId = asNumericId(raw?.poll_id);
  if (!raw || pollId === undefined || !Array.isArray(raw.options)) return null;
  const options = raw.options.flatMap((entry) => {
    const option = asRecord(entry);
    const optionId = asNumericId(option?.option_id);
    if (!option || optionId === undefined) return [];
    const voters = Array.isArray(option.voters) ? option.voters.flatMap((v) => asId(v) ?? []) : [];
    return [
      {
        optionId,
        content: typeof option.content === 'string' ? option.content : '',
        votes: asNumericId(option.votes) ?? voters.length,
        voters,
      },
    ];
  });
  return {
    pollId,
    question: typeof raw.question === 'string' ? raw.question : '',
    creatorId: asId(raw.creator),
    options,
    closed: raw.closed === true,
    multiChoice: raw.allow_multi_choices === true,
    anonymous: raw.is_anonymous === true,
  };
}
