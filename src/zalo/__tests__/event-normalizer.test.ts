// Fixtures mirror live shapes captured in Phase 1 (spike/raw-events.ndjson,
// documented in plans/.../reports/phase-01-spike-findings.md), identifiers anonymized.
import { describe, expect, it } from 'vitest';
import { normalizeZaloMessage } from '../event-normalizer.ts';
import type { RawZaloMessage } from '../types.ts';

const dmText: RawZaloMessage = {
  type: 0,
  threadId: '1111111111111111111',
  isSelf: false,
  data: {
    msgId: '7998805079701',
    msgType: 'webchat',
    uidFrom: '1111111111111111111',
    dName: 'Test Sender',
    ts: '1782964481836',
    content: 'xin chào',
  },
};

describe('normalizeZaloMessage', () => {
  it('normalizes DM text and captures the quotable payload', () => {
    const normalized = normalizeZaloMessage(dmText);
    expect(normalized).toEqual({
      msgId: '7998805079701',
      threadId: '1111111111111111111',
      threadType: 'user',
      senderId: '1111111111111111111',
      senderName: 'Test Sender',
      timestamp: 1782964481836,
      isSelf: false,
      content: { kind: 'text', text: 'xin chào' },
      rawMsgType: 'webchat',
      quotable: {
        content: 'xin chào',
        msgType: 'webchat',
        propertyExt: null,
        uidFrom: '1111111111111111111',
        msgId: '7998805079701',
        cliMsgId: '',
        ts: '1782964481836',
        ttl: 0,
      },
    });
  });

  it('normalizes group text with type=1', () => {
    const normalized = normalizeZaloMessage({
      ...dmText,
      type: 1,
      threadId: '2222222222222222222',
      data: { ...dmText.data, content: 'Lô' },
    });
    expect(normalized?.threadType).toBe('group');
    expect(normalized?.threadId).toBe('2222222222222222222');
    expect(normalized?.senderId).toBe('1111111111111111111'); // uidFrom stays the puppet key
    expect(normalized?.content).toEqual({ kind: 'text', text: 'Lô' });
  });

  it('normalizes chat.photo with dimensions from params JSON', () => {
    const normalized = normalizeZaloMessage({
      ...dmText,
      data: {
        ...dmText.data,
        msgType: 'chat.photo',
        content: {
          href: 'https://photo-stal-19.zdn.vn/x/y.jpg',
          thumb: 'https://photo-stal-19.zdn.vn/x/y-thumb.jpg',
          params: '{"height":4032,"width":3024,"hd":"https://cdn/hd.jpg"}',
        },
      },
    });
    expect(normalized?.content).toEqual({
      kind: 'photo',
      url: 'https://photo-stal-19.zdn.vn/x/y.jpg',
      thumbUrl: 'https://photo-stal-19.zdn.vn/x/y-thumb.jpg',
      width: 3024,
      height: 4032,
    });
  });

  it('keeps photo without dimensions when params is malformed', () => {
    const normalized = normalizeZaloMessage({
      ...dmText,
      data: { ...dmText.data, msgType: 'chat.photo', content: { href: 'https://cdn/p.jpg', params: '{broken' } },
    });
    expect(normalized?.content).toMatchObject({ kind: 'photo', url: 'https://cdn/p.jpg', width: undefined });
  });

  it('normalizes chat.sticker to id+catId', () => {
    const normalized = normalizeZaloMessage({
      ...dmText,
      data: { ...dmText.data, msgType: 'chat.sticker', content: { id: 18009, catId: 10130, type: 7 } },
    });
    expect(normalized?.content).toEqual({ kind: 'sticker', id: 18009, catId: 10130 });
  });

  it('marks unknown msgTypes unsupported and marks isSelf', () => {
    const normalized = normalizeZaloMessage({
      ...dmText,
      isSelf: true,
      data: { ...dmText.data, msgType: 'chat.todo', content: { something: true } },
    });
    expect(normalized?.isSelf).toBe(true);
    expect(normalized?.content).toEqual({ kind: 'unsupported', msgType: 'chat.todo' });
  });

  it('renders a shared location as a native location with a text fallback', () => {
    const contentOf = (content: unknown) =>
      normalizeZaloMessage({ ...dmText, data: { ...dmText.data, msgType: 'chat.location.new', content } })?.content;
    // Live shapes (anonymized): a picked place, and "my location" (empty title)
    const place = { title: 'Nhà Thuốc A', description: '1 Lê Lợi, Quận 1', href: '', thumb: '', action: '' };
    expect(
      contentOf({
        ...place,
        params: '{"isUserLocation":0,"srcId":"x","latitude":10.772022599999999,"longitude":106.6982839}',
      }),
    ).toEqual({
      kind: 'location',
      latitude: 10.7720226,
      longitude: 106.6982839,
      label: 'Nhà Thuốc A',
      text: '📍 Nhà Thuốc A\n1 Lê Lợi, Quận 1\nhttps://www.google.com/maps?q=10.7720226,106.6982839',
    });
    expect(
      contentOf({ ...place, title: '', params: '{"isUserLocation":1,"latitude":10.77,"longitude":106.69}' }),
    ).toMatchObject({
      kind: 'location',
      label: '1 Lê Lợi, Quận 1',
      text: '📍 1 Lê Lợi, Quận 1\nhttps://www.google.com/maps?q=10.77,106.69',
    });
    // Other key spellings
    expect(contentOf({ title: 'Landmark 81', params: '{"lat":10.795,"lng":106.722}' })).toMatchObject({
      kind: 'location',
      latitude: 10.795,
      longitude: 106.722,
    });
    expect(contentOf({ title: 'Nhà', latitude: '21.03', longitude: '105.85' })).toMatchObject({ kind: 'location' });
    // No coordinates → text only
    expect(contentOf({ description: 'Quận 1' })).toEqual({ kind: 'text', text: '📍 Quận 1' });
  });

  it('renders a contact card (danh thiếp) as its QR code captioned with name, phone and a Zalo link', () => {
    const contentOf = (content: unknown) =>
      normalizeZaloMessage({ ...dmText, data: { ...dmText.data, msgType: 'chat.recommended', content } })?.content;
    // Live shape (anonymized): href is a placeholder, description is JSON
    const card = {
      title: 'Nguyễn Văn A',
      description: '{"phone":"0900000000","qrCodeUrl":"https:\/\/qr-talk.zdn.vn\/2\/1\/a.jpg"}',
      href: 'www.zaloapp.com',
      thumb: 'https://s120.avatar.talk.zdn.vn/a.jpg',
      action: 'recommened.user',
      params: '1234567890',
    };
    expect(contentOf(card)).toEqual({
      kind: 'photo',
      url: 'https://qr-talk.zdn.vn/2/1/a.jpg',
      caption: '👤 Danh thiếp Zalo: Nguyễn Văn A\n📞 0900000000\nMở trong Zalo: https://zalo.me/0900000000',
    });
    // Phone hidden by the contact's privacy settings: the QR is the way in
    expect(contentOf({ ...card, description: '{"qrCodeUrl":"https://qr-talk.zdn.vn/a.jpg"}' })).toEqual({
      kind: 'photo',
      url: 'https://qr-talk.zdn.vn/a.jpg',
      caption: '👤 Danh thiếp Zalo: Nguyễn Văn A\n(quét QR bằng Zalo để mở)',
    });
    // No QR: text with the avatar as link preview
    expect(contentOf({ ...card, description: '{"phone":"0900000000"}' })).toEqual({
      kind: 'text',
      text: '👤 Danh thiếp Zalo: Nguyễn Văn A\n📞 0900000000\nMở trong Zalo: https://zalo.me/0900000000',
      linkPreview: {
        url: 'https://zalo.me/0900000000',
        title: 'Nguyễn Văn A',
        imageUrl: 'https://s120.avatar.talk.zdn.vn/a.jpg',
      },
    });
    expect(contentOf({ ...card, description: '{}' })).toEqual({
      kind: 'text',
      text: '👤 Danh thiếp Zalo: Nguyễn Văn A',
    });
  });

  it('does not use a photo file name as its caption', () => {
    const contentOf = (title: string, description = '') =>
      normalizeZaloMessage({
        ...dmText,
        data: {
          ...dmText.data,
          msgType: 'chat.photo',
          content: { href: 'https://f1.zdn.vn/a.jpg', title, description },
        },
      })?.content;
    expect(contentOf('IMG_0012.JPG')).toMatchObject({ kind: 'photo', caption: undefined });
    expect(contentOf('', 'Screenshot_2026-10-28.png')).toMatchObject({ caption: undefined });
    expect(contentOf('Ảnh đẹp quá')).toMatchObject({ caption: 'Ảnh đẹp quá' });
  });

  it('renders web cards as text (with an href they become link cards)', () => {
    const contentOf = (msgType: string, content: unknown) =>
      normalizeZaloMessage({ ...dmText, data: { ...dmText.data, msgType, content } })?.content;
    expect(contentOf('chat.webcontent', { title: 'Chuyển khoản', description: '500.000đ' })).toEqual({
      kind: 'text',
      text: 'Chuyển khoản\n500.000đ',
    });
    expect(contentOf('chat.webcontent.v2', {})).toEqual({ kind: 'text', text: '[Zalo web card — open Zalo to view]' });
    expect(contentOf('chat.webcontent', { title: 'Mini app', href: 'https://zalo.me/s/123' })).toMatchObject({
      kind: 'text',
      text: 'Mini app\nhttps://zalo.me/s/123',
    });
  });

  it('normalizes video / file / voice / GIF attachments to media descriptors', () => {
    /** Normalizes a DM fixture with the given msgType/content and returns only its content. */
    const contentOf = (msgType: string, content: unknown) =>
      normalizeZaloMessage({ ...dmText, data: { ...dmText.data, msgType, content } })?.content;
    expect(
      contentOf('chat.video.msg', {
        href: 'https://v.dlmd.me/a',
        params: '{"duration":7000,"video_width":576,"video_height":1024,"fileSize":99}',
      }),
    ).toEqual({
      kind: 'media',
      media: {
        kind: 'video',
        urls: ['https://v.dlmd.me/a'],
        filename: 'zalo-video.mp4',
        caption: undefined,
        width: 576,
        height: 1024,
        durationMs: 7000,
        size: 99,
      },
    });
    expect(
      contentOf('share.file', { title: 'a.pdf', href: 'https://f.zdn.vn/a', params: '{"fileSize":"375945"}' }),
    ).toEqual({
      kind: 'media',
      media: { kind: 'file', urls: ['https://f.zdn.vn/a'], filename: 'a.pdf', size: 375945 },
    });
    expect(contentOf('chat.voice', { href: 'https://v.zdn.vn/a.m4a', params: '{"duration":4000}' })).toMatchObject({
      kind: 'media',
      media: { kind: 'audio', durationMs: 4000 },
    });
    expect(
      contentOf('chat.gif', { href: 'https://zalo-gif.zadn.vn/a.gif', thumb: 'https://zalo-gif.zadn.vn/a.jpg' }),
    ).toMatchObject({
      kind: 'media',
      media: { kind: 'image', urls: ['https://zalo-gif.zadn.vn/a.gif', 'https://zalo-gif.zadn.vn/a.jpg'] },
    });
  });

  it('renders link cards as text with a Beeper link preview', () => {
    const normalized = normalizeZaloMessage({
      ...dmText,
      data: {
        ...dmText.data,
        msgType: 'chat.recommended',
        content: {
          href: 'https://lttt.dev/x',
          title: 'https://lttt.dev/x',
          description: 'Mô tả',
          thumb: 'https://photo-link-talk.zadn.vn/t.jpg',
          params: '{"mediaTitle":"Trang X"}',
        },
      },
    });
    expect(normalized?.content).toEqual({
      kind: 'text',
      text: 'https://lttt.dev/x',
      linkPreview: {
        url: 'https://lttt.dev/x',
        title: 'Trang X',
        description: 'Mô tả',
        imageUrl: 'https://photo-link-talk.zadn.vn/t.jpg',
      },
    });
  });

  it('shows the typed text of a link message, previewing the typed URL (not the resolved one)', () => {
    const contentOf = (content: unknown) =>
      normalizeZaloMessage({ ...dmText, data: { ...dmText.data, msgType: 'chat.recommended', content } })?.content;
    // Live shape (shortened): title = typed text, href = resolved URL, mediaTitle = page title
    expect(
      contentOf({
        title: 'https://maps.app.goo.gl/abc?g_st=ic',
        description: 'Find local businesses in Google Maps.',
        href: 'https://www.google.com/maps?geocode=x',
        thumb: 'https://f2001-zpcloud.zdn.vn/t.jpg',
        action: 'recommened.link',
        params: '{"mediaTitle":"Google Maps"}',
      }),
    ).toEqual({
      kind: 'text',
      text: 'https://maps.app.goo.gl/abc?g_st=ic',
      linkPreview: {
        url: 'https://maps.app.goo.gl/abc?g_st=ic',
        title: 'Google Maps',
        description: 'Find local businesses in Google Maps.',
        imageUrl: 'https://f2001-zpcloud.zdn.vn/t.jpg',
      },
    });
    // A page without a title: Zalo echoes the URL as mediaTitle/description — no URL-as-title preview
    expect(
      contentOf({
        title: 'xem https://a.vn/x',
        description: 'https://a.vn/x',
        href: 'https://a.vn/x',
        params: '{"mediaTitle":"https://a.vn/x"}',
      }),
    ).toEqual({ kind: 'text', text: 'xem https://a.vn/x', linkPreview: { url: 'https://a.vn/x' } });
  });

  it('renders rich text (webchat action "rtf") as its plain text', () => {
    const msg = normalizeZaloMessage({
      ...dmText,
      data: {
        ...dmText.data,
        content: {
          title: 'Đợt 1 => @A @B 12k',
          description: '',
          href: '',
          thumb: '',
          childnumber: 0,
          action: 'rtf',
          params: '{"styles":[{"start":0,"len":5,"st":"b"}],"ver":0}',
          type: '',
        },
        mentions: [{ uid: '2', pos: 9, len: 2 }],
      },
    });
    expect(msg?.content).toEqual({ kind: 'text', text: 'Đợt 1 => @A @B 12k' });
    expect(msg?.mentions).toEqual([{ uid: '2', pos: 9, len: 2 }]);
  });

  it('returns null when msgId is missing', () => {
    const normalized = normalizeZaloMessage({ ...dmText, data: { ...dmText.data, msgId: '' } });
    expect(normalized).toBeNull();
  });

  it('never exposes E2EE ciphertext as text (cmd 551 pushes carry an e2ee field)', () => {
    const msg = normalizeZaloMessage({
      type: 0,
      threadId: '111',
      isSelf: false,
      data: {
        msgId: '9',
        msgType: 'webchat',
        uidFrom: '111',
        ts: '1',
        content: 'MwohBQ==',
        e2ee: '{"version":1,"compat_version":0,"iid":603}',
      },
    });
    expect(msg?.content).toEqual({ kind: 'unsupported', msgType: 'e2ee' });
  });
});
