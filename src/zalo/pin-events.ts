// Zalo pin / unpin events -> ZaloPinEvent. All zca-js payload quirks for pins live here.
// Groups deliver pins as `group_event` (new/update/unpin_topic, data.topic is a GroupTopic);
// DMs deliver them as `friend_event` (PIN_CREATE = 11, PIN_UNPIN = 10). Plain numbers and
// strings are used instead of the zca-js enums: this module must stay free of runtime imports.
import { asId, asRecord, parseParams, type Loose } from '../util.ts';
import type { ZaloPinEvent } from './types.ts';

/** zca-js GroupTopicType.Message — the only topic kind that points at a chat message. */
const TOPIC_TYPE_MESSAGE = 2;
/** zca-js FriendEventType.PIN_UNPIN / PIN_CREATE. */
const FRIEND_PIN_UNPIN = 10;
const FRIEND_PIN_CREATE = 11;

/** Global msgId of the pinned message, from topic params (`global_msg_id`). */
const pinnedMsgId = (params: Loose | null): string | undefined => asId(params?.global_msg_id);

/**
 * Group `new_pin_topic` / `update_pin_topic` / `unpin_topic` -> pin event.
 * Notes, polls, reorders and every other group event are not pins of a message.
 *
 * @param event raw zca-js GroupEvent
 * @returns null when the event is not a message pin or its payload is malformed
 */
export function normalizeGroupPinEvent(event: unknown): ZaloPinEvent | null {
  const raw = asRecord(event);
  const data = asRecord(raw?.data);
  const topic = asRecord(data?.topic);
  if (!raw || !data || !topic) return null;
  let action: ZaloPinEvent['action'];
  if (raw.type === 'new_pin_topic' || raw.type === 'update_pin_topic') action = 'pin';
  else if (raw.type === 'unpin_topic') action = 'unpin';
  else return null;
  if (topic.type !== TOPIC_TYPE_MESSAGE) return null;
  const params = parseParams(topic.params);
  if (typeof topic.params === 'string' && !params) return null;
  const threadId = asId(raw.threadId);
  if (!threadId) return null;
  return {
    threadId,
    threadType: 'group',
    action,
    actorId: asId(data.actorId),
    isSelf: raw.isSelf === true,
    msgId: pinnedMsgId(params),
    topicId: asId(topic.id),
  };
}

/**
 * Friend `PIN_CREATE` / `PIN_UNPIN` -> pin event for a DM. An unpin only carries the
 * topic id (`topic.topicId`), no message id.
 *
 * @param event raw zca-js FriendEvent
 * @returns null for other friend events or a payload without a topic
 */
export function normalizeFriendPinEvent(event: unknown): ZaloPinEvent | null {
  const raw = asRecord(event);
  const data = asRecord(raw?.data);
  const topic = asRecord(data?.topic);
  if (!raw || !data || !topic) return null;
  const threadId = asId(raw.threadId);
  if (!threadId) return null;
  const base = { threadId, threadType: 'user' as const, actorId: asId(data.actorId), isSelf: raw.isSelf === true };
  if (raw.type === FRIEND_PIN_CREATE) {
    return {
      ...base,
      action: 'pin',
      msgId: pinnedMsgId(parseParams(topic.params)),
      topicId: asId(topic.id),
    };
  }
  if (raw.type === FRIEND_PIN_UNPIN) return { ...base, action: 'unpin', topicId: asId(topic.topicId) };
  return null;
}
