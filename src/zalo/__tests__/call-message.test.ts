import { describe, expect, it } from 'vitest';
import { describeCall } from '../call-message.ts';
import { normalizeZaloMessage } from '../event-normalizer.ts';

describe('describeCall', () => {
  it('renders answered calls with direction and length', () => {
    expect(describeCall('recommened.calltime', '{"duration":26,"isCaller":0,"calltype":0}')).toBe(
      '📞 Cuộc gọi đến · 0:26',
    );
    expect(describeCall('recommened.calltime', { duration: 65, isCaller: 1, calltype: 1 })).toBe(
      '📹 Cuộc gọi video đi · 1:05',
    );
    expect(describeCall('recommened.calltime', '{"duration":3725,"isCaller":1}')).toBe('📞 Cuộc gọi đi · 1:02:05');
  });

  it('renders missed calls and tolerates bad params', () => {
    expect(describeCall('recommened.misscall', '{"duration":0,"reason":2,"isCaller":0}')).toBe('📞 Cuộc gọi nhỡ');
    expect(describeCall('recommened.misscall', '{"isCaller":1}')).toBe('📞 Cuộc gọi đi không được trả lời');
    expect(describeCall('recommened.calltime', '{broken')).toBe('📞 Cuộc gọi đến');
  });
});

describe('live call bubbles', () => {
  it('normalizes a chat.recommended call bubble to a notice instead of unsupported', () => {
    const normalized = normalizeZaloMessage({
      type: 0,
      threadId: '111',
      isSelf: false,
      data: {
        msgId: '9',
        msgType: 'chat.recommended',
        uidFrom: '111',
        ts: '1',
        content: {
          title: 'sendBubbleMessage',
          description: 'Cuộc gọi',
          href: '',
          action: 'recommened.calltime',
          params: '{"callId":1,"duration":10,"isCaller":0,"calltype":0}',
        },
      },
    });
    expect(normalized?.content).toEqual({ kind: 'notice', text: '📞 Cuộc gọi đến · 0:10' });
  });
});
