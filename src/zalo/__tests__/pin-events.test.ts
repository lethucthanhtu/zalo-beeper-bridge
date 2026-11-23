import { describe, expect, it } from 'vitest';
import { normalizeFriendPinEvent, normalizeGroupPinEvent } from '../pin-events.ts';

// Synthetic fixtures shaped after the zca-js GroupEvent / FriendEvent type definitions.
const topic = (over: Record<string, unknown> = {}) => ({
  type: 2, // GroupTopicType.Message
  id: 'topic1',
  creatorId: 'u2',
  params: { global_msg_id: '9001', client_msg_id: '8001', senderUid: 'u3', title: 'hello' },
  ...over,
});
const groupEvent = (type: string, data: Record<string, unknown>, isSelf = false) => ({
  type,
  act: type,
  threadId: 'g1',
  isSelf,
  data: { actorId: 'u2', groupId: 'g1', boardVersion: 2, oldBoardVersion: 1, ...data },
});

describe('normalizeGroupPinEvent', () => {
  it.each(['new_pin_topic', 'update_pin_topic'])('maps %s of a message topic to a pin', (type) => {
    expect(normalizeGroupPinEvent(groupEvent(type, { topic: topic() }) as never)).toEqual({
      threadId: 'g1',
      threadType: 'group',
      action: 'pin',
      actorId: 'u2',
      isSelf: false,
      msgId: '9001',
      topicId: 'topic1',
    });
  });

  it('maps unpin_topic to an unpin and marks the own account', () => {
    const event = normalizeGroupPinEvent(groupEvent('unpin_topic', { topic: topic() }, true) as never);
    expect(event).toMatchObject({ action: 'unpin', msgId: '9001', isSelf: true });
  });

  it('accepts topic params delivered as a JSON string and numeric ids', () => {
    const params = JSON.stringify({ global_msg_id: 9001, client_msg_id: 1 });
    const event = normalizeGroupPinEvent(groupEvent('new_pin_topic', { topic: topic({ params, id: 77 }) }) as never);
    expect(event).toMatchObject({ msgId: '9001', topicId: '77' });
  });

  it('ignores notes, polls, reorders, other group events and malformed payloads', () => {
    expect(normalizeGroupPinEvent(groupEvent('new_pin_topic', { topic: topic({ type: 0 }) }) as never)).toBeNull();
    expect(normalizeGroupPinEvent(groupEvent('new_pin_topic', { topic: topic({ type: 3 }) }) as never)).toBeNull();
    expect(normalizeGroupPinEvent(groupEvent('reorder_pin_topic', { topic: null, topics: [] }) as never)).toBeNull();
    expect(normalizeGroupPinEvent(groupEvent('update_board', { topic: topic() }) as never)).toBeNull();
    expect(normalizeGroupPinEvent(groupEvent('new_pin_topic', {}) as never)).toBeNull();
    expect(
      normalizeGroupPinEvent(groupEvent('new_pin_topic', { topic: topic({ params: 'not json' }) }) as never),
    ).toBeNull();
  });
});

describe('normalizeFriendPinEvent', () => {
  it('maps PIN_CREATE (11) to a DM pin with the global msg id', () => {
    const event = normalizeFriendPinEvent({
      type: 11,
      threadId: 'u7',
      isSelf: true,
      data: { actorId: 'me', conversationId: 'u7', topic: { id: 'topic9', params: { global_msg_id: '555' } } },
    } as never);
    expect(event).toEqual({
      threadId: 'u7',
      threadType: 'user',
      action: 'pin',
      actorId: 'me',
      isSelf: true,
      msgId: '555',
      topicId: 'topic9',
    });
  });

  it('maps PIN_UNPIN (10) to an unpin that only knows the topic id', () => {
    const event = normalizeFriendPinEvent({
      type: 10,
      threadId: 'u7',
      isSelf: false,
      data: { actorId: 'u7', conversationId: 'u7', topic: { topicId: 'topic9', topicType: 2 } },
    } as never);
    expect(event).toEqual({
      threadId: 'u7',
      threadType: 'user',
      action: 'unpin',
      actorId: 'u7',
      isSelf: false,
      topicId: 'topic9',
    });
  });

  it('ignores other friend events and payloads without a topic', () => {
    expect(normalizeFriendPinEvent({ type: 0, threadId: 'u7', isSelf: false, data: 'u7' } as never)).toBeNull();
    expect(normalizeFriendPinEvent({ type: 11, threadId: 'u7', isSelf: false, data: {} } as never)).toBeNull();
  });
});
