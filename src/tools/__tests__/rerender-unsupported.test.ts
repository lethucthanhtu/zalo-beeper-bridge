import { describe, expect, it } from 'vitest';
import { stickerImageUrl } from '../../bridge/history-import.ts';
import {
  findStillUnsupported,
  isFailedMediaNotice,
  isUnsupportedNotice,
  rerenderStored,
  unsupportedNoticeType,
} from '../rerender-unsupported.ts';

const notice = (msgType: string) => ({
  msgtype: 'm.notice',
  body: `[Zalo message type not supported by bridge: ${msgType}]`,
});
const stored = (msgType: string, content: unknown) =>
  JSON.stringify({
    content,
    msgType,
    propertyExt: null,
    uidFrom: '42',
    msgId: 'm1',
    cliMsgId: '1',
    ts: '1700000000000',
    ttl: 0,
  });

describe('unsupportedNoticeType', () => {
  it('reads the msgType of the bridge notice', () => {
    expect(unsupportedNoticeType(notice('chat.photo'))).toBe('chat.photo');
    expect(isUnsupportedNotice(notice('webchat'))).toBe(true);
  });

  it('never matches the end-to-end encrypted notices', () => {
    const lock = { msgtype: 'm.notice', body: '🔒 Tin nhắn mã hoá đầu cuối của Zalo — bridge không giải mã được.' };
    expect(unsupportedNoticeType(lock)).toBeNull();
    expect(unsupportedNoticeType(notice('e2ee'))).toBeNull();
  });

  it('ignores text messages and other notices', () => {
    expect(unsupportedNoticeType({ msgtype: 'm.text', body: notice('webchat').body })).toBeNull();
    expect(unsupportedNoticeType({ msgtype: 'm.notice', body: 'X pinned a message' })).toBeNull();
    expect(unsupportedNoticeType(undefined)).toBeNull();
  });
});

describe('isFailedMediaNotice', () => {
  it('matches the live "could not be bridged" notices, with or without a caption line', () => {
    const failed = (body: string) => isFailedMediaNotice({ msgtype: 'm.notice', body });
    expect(failed('[Zalo photo could not be bridged: f1.zdn.vn: HTTP 400]')).toBe(true);
    expect(failed('trip\n[Zalo photo could not be bridged: f1.zdn.vn: HTTP 400]')).toBe(true);
    expect(failed('[Zalo file could not be bridged]\nhttps://cdn.example/a.pdf')).toBe(true);
  });

  it('ignores text, other notices and look-alikes mid-line', () => {
    expect(isFailedMediaNotice({ msgtype: 'm.text', body: '[Zalo photo could not be bridged]' })).toBe(false);
    expect(isFailedMediaNotice({ msgtype: 'm.notice', body: 'see [Zalo photo could not be bridged]' })).toBe(false);
    expect(isFailedMediaNotice(notice('chat.photo'))).toBe(false);
    expect(isFailedMediaNotice(undefined)).toBe(false);
  });
});

describe('rerenderStored', () => {
  it('renders rich text as m.text', () => {
    const result = rerenderStored(stored('webchat', { action: 'rtf', title: 'hello' }), 'm1', 'webchat');
    expect(result).toEqual({
      via: 'import',
      kind: 'text',
      content: { msgtype: 'm.text', body: 'hello' },
      system: false,
    });
  });

  it('renders a system webchat bubble as a bot notice', () => {
    const result = rerenderStored(stored('webchat', { title: 'A pinned a message', href: '' }), 'm1', 'webchat');
    expect(result).toMatchObject({ via: 'import', kind: 'notice', content: { msgtype: 'm.notice' }, system: true });
  });

  it('renders a photo as image media with a text fallback', () => {
    const content = {
      href: 'https://cdn.example/p.jpg',
      thumb: 'https://cdn.example/t.jpg',
      title: 'trip',
      params: '{"width":800,"height":600}',
    };
    const result = rerenderStored(stored('chat.photo', content), 'm1', 'chat.photo');
    expect(result).toMatchObject({
      via: 'import',
      kind: 'photo',
      media: {
        kind: 'image',
        urls: ['https://cdn.example/p.jpg', 'https://cdn.example/t.jpg'],
        width: 800,
        height: 600,
        caption: 'trip',
      },
      system: false,
    });
    expect(result?.via === 'import' && result.content.body).toContain('trip');
  });

  it('tries the photo hd link between the original and the thumbnail', () => {
    const content = {
      href: 'https://cdn.example/p.jpg',
      thumb: 'https://cdn.example/t.jpg',
      params: '{"hd":"https://cdn.example/hd.jpg"}',
    };
    const result = rerenderStored(stored('chat.photo', content), 'm1', 'chat.photo');
    expect(result?.via === 'import' && result.media?.urls).toEqual([
      'https://cdn.example/p.jpg',
      'https://cdn.example/hd.jpg',
      'https://cdn.example/t.jpg',
    ]);
  });

  it('renders a sticker with the sticker image url', () => {
    const result = rerenderStored(stored('chat.sticker', { id: 28408, catId: 10 }), 'm1', 'chat.sticker');
    expect(result).toMatchObject({ media: { kind: 'sticker', urls: [stickerImageUrl(28408)], stickerId: 28408 } });
  });

  it('renders a file as file media', () => {
    const content = { href: 'https://cdn.example/f.pdf', title: 'report.pdf', params: '{"fileSize":1000}' };
    const result = rerenderStored(stored('share.file', content), 'm1', 'share.file');
    expect(result).toMatchObject({ kind: 'media', media: { kind: 'file', filename: 'report.pdf' } });
    expect(result?.via === 'import' && result.content.body).toContain('report.pdf');
  });

  it('renders a location as a native m.location event', () => {
    const content = { title: 'Cafe', description: '1 Street', params: '{"latitude":10.5,"longitude":106.7}' };
    const result = rerenderStored(stored('chat.location.new', content), 'm1', 'chat.location.new');
    expect(result).toMatchObject({
      via: 'event',
      type: 'm.room.message',
      content: {
        msgtype: 'm.location',
        geo_uri: 'geo:10.5,106.7',
        'org.matrix.msc3488.location': { description: 'Cafe' },
      },
    });
  });

  it('renders a call log as a call tile', () => {
    const content = { action: 'recommened.misscall', title: 'sendBubbleMessage', params: '{"calltype":0}' };
    const result = rerenderStored(stored('chat.recommended', content), 'm1', 'chat.recommended');
    expect(result).toMatchObject({ kind: 'call', content: { msgtype: 'm.text' } });
    expect(result?.via === 'import' && result.content['com.beeper.action_message']).toBeTruthy();
  });

  it('keeps the old notice when the payload is still unsupported, a recall, unreadable or of another type', () => {
    expect(rerenderStored(stored('chat.mystery', { foo: 1 }), 'm1', 'chat.mystery')).toBeNull();
    expect(rerenderStored(stored('chat.undo', { deleteMsg: 1, globalMsgId: '5' }), 'm1', 'chat.undo')).toBeNull();
    expect(rerenderStored('{not json', 'm1', 'webchat')).toBeNull();
    expect(rerenderStored(null, 'm1', 'webchat')).toBeNull();
    // the payload was stored for a different msgType than the notice names
    expect(rerenderStored(stored('webchat', { action: 'rtf', title: 'x' }), 'm1', 'chat.photo')).toBeNull();
  });
});

describe('findStillUnsupported', () => {
  const photo = stored('chat.photo', { href: 'https://cdn.example/p.jpg', title: '' });
  const quotes: Record<string, string> = {
    $notice: photo,
    $rebuilt: photo,
    $mystery: stored('chat.mystery', { foo: 1 }),
  };
  const events: Record<string, Record<string, unknown>> = {
    $notice: notice('chat.photo'),
    $rebuilt: { msgtype: 'm.image', body: 'p.jpg' },
    $mystery: notice('chat.mystery'),
  };

  it('lists notices whose payload renders today, reading only those events', async () => {
    const read: string[] = [];
    const found = await findStillUnsupported(
      [
        { msgId: 'a', eventId: '$notice', msgType: 'chat.photo' },
        { msgId: 'b', eventId: '$rebuilt', msgType: 'chat.photo' },
        { msgId: 'c', eventId: '$mystery', msgType: 'chat.mystery' },
        { msgId: 'd', eventId: null, msgType: 'chat.photo' },
        { msgId: 'e', eventId: '$text', msgType: 'webchat' },
      ],
      (eventId) => quotes[eventId] ?? null,
      async (eventId) => {
        read.push(eventId);
        return events[eventId];
      },
    );
    expect(found).toEqual(['a']);
    expect(read).toEqual(['$notice', '$rebuilt']);
  });
});
