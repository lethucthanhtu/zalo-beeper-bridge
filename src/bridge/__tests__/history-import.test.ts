import { describe, expect, it } from 'vitest';
import {
  dropShadowCopies,
  jxlToJpgUrl,
  parseReactionSidecar,
  parseThreadKey,
  quoteFallback,
  renderExportRow,
  stickerImageUrl,
  type ExportRow,
} from '../history-import.ts';

const base = { msgId: '100', cliMsgId: '200', sendDttm: '1700000000000' };

describe('parseReactionSidecar', () => {
  it('flattens each message into one entry per reactor and reaction type', () => {
    const text = JSON.stringify([
      { rMsgId: '11', rCli: '22', reactions: { '0': { '5': 1 }, '777': { '3': 2, '0': 1 } } },
    ]);
    expect(parseReactionSidecar(text)).toEqual([
      {
        msgId: '11',
        cliMsgId: '22',
        reactions: [
          { reactor: '0', rType: '5' },
          { reactor: '777', rType: '0' },
          { reactor: '777', rType: '3' },
        ],
      },
    ]);
  });

  it('treats a "0" id as absent and keeps an entry with only a cliMsgId', () => {
    const text = JSON.stringify([{ rMsgId: '0', rCli: 22, reactions: { '777': { '5': 1 } } }]);
    expect(parseReactionSidecar(text)).toEqual([
      { msgId: '', cliMsgId: '22', reactions: [{ reactor: '777', rType: '5' }] },
    ]);
  });

  it('drops entries without any id, without reactions or with zero counts', () => {
    const text = JSON.stringify([
      { rMsgId: '0', rCli: '0', reactions: { '777': { '5': 1 } } },
      { rMsgId: '11', rCli: '22', reactions: {} },
      { rMsgId: '12', rCli: '23', reactions: { '777': { '5': 0 } } },
      { rMsgId: '13', rCli: '24' },
    ]);
    expect(parseReactionSidecar(text)).toEqual([]);
  });

  it('rejects a sidecar that is not an array', () => {
    expect(() => parseReactionSidecar('{}')).toThrow('not an array');
  });
});

describe('parseThreadKey', () => {
  it('splits group (g-prefixed) and DM keys', () => {
    expect(parseThreadKey('g123')).toEqual({ threadId: '123', threadType: 'group' });
    expect(parseThreadKey('456')).toEqual({ threadId: '456', threadType: 'user' });
  });
});

describe('renderExportRow', () => {
  it('maps fromUid 0 to the owner and keeps the original timestamp', () => {
    const event = renderExportRow({ ...base, fromUid: '0', msgType: 1, message: 'chào' }, 'user', '456');
    expect(event).toMatchObject({ msgId: '100', cliMsgId: '200', timestamp: 1700000000000, sender: { kind: 'owner' } });
    expect(event?.content).toEqual({ msgtype: 'm.text', body: 'chào' });
  });

  describe('polls (msgType 26)', () => {
    const poll = (message: unknown): ExportRow => ({ ...base, fromUid: '789', dName: 'Bob', msgType: 26, message });

    it('renders the question and numbered options as a notice', () => {
      const event = renderExportRow(
        poll({ title: 'Lunch?', params: { options: [{ content: 'Pho' }, { content: 'Bun' }] } }),
        'group',
        '123',
      );
      expect(event?.content).toEqual({ msgtype: 'm.notice', body: '📊 [Bình chọn] Lunch?\n1. Pho\n2. Bun' });
      expect(event?.sender).toEqual({ kind: 'ghost', uid: '789', name: 'Bob' });
      expect(event?.rawMsgType).toBe('26');
    });

    it('reads options given as strings or as a JSON string, and the question from params', () => {
      const fromStrings = renderExportRow(poll({ options: ['A', 'B'], params: '{"question":"Pick"}' }), 'group', '123');
      expect(fromStrings?.content.body).toBe('📊 [Bình chọn] Pick\n1. A\n2. B');
      const fromJson = renderExportRow(poll({ title: 'Q', options: '[{"text":"X"}]' }), 'group', '123');
      expect(fromJson?.content.body).toBe('📊 [Bình chọn] Q\n1. X');
    });

    it('still shows the question when no options were exported', () => {
      expect(renderExportRow(poll({ title: 'Lunch?' }), 'group', '123')?.content.body).toBe('📊 [Bình chọn] Lunch?');
    });

    it('falls back to a generic label for a row with neither', () => {
      const event = renderExportRow(poll({}), 'group', '123');
      expect(event?.content).toEqual({ msgtype: 'm.notice', body: '[Bình chọn]' });
    });
  });

  it('attributes group messages to the sender ghost with its dName', () => {
    const event = renderExportRow({ ...base, fromUid: '789', dName: 'Bob', msgType: 1, message: 'hi' }, 'group', '123');
    expect(event?.sender).toEqual({ kind: 'ghost', uid: '789', name: 'Bob' });
  });

  it('sends system rows as the bot in groups and DMs, never as a person', () => {
    const row: ExportRow = { ...base, msgType: -4, message: 'Rabbit đã rời khỏi nhóm', act: 'leave' };
    expect(renderExportRow(row, 'group', '123')?.sender).toEqual({ kind: 'bot' });
    expect(renderExportRow(row, 'user', '456')?.sender).toEqual({ kind: 'bot' });
    expect(renderExportRow(row, 'group', '123')?.content.msgtype).toBe('m.notice');
  });

  it('attributes a pin row to the bot even though it names the pinner as fromUid', () => {
    const pin: ExportRow = {
      ...base,
      fromUid: '789',
      dName: 'Bob',
      msgType: -1909,
      message: { title: 'Bob pinned a message', action: 'pin' },
    };
    for (const [type, thread] of [
      ['group', '123'],
      ['user', '456'],
    ] as const) {
      const event = renderExportRow(pin, type, thread);
      expect(event?.sender).toEqual({ kind: 'bot' });
      expect(event?.content.msgtype).toBe('m.notice');
    }
  });

  it('still attributes sender-less non-system DM rows to the peer', () => {
    const row: ExportRow = { ...base, msgType: 1, message: 'hello' };
    expect(renderExportRow(row, 'user', '456')?.sender).toEqual({ kind: 'ghost', uid: '456' });
    expect(renderExportRow(row, 'group', '123')?.sender).toEqual({ kind: 'bot' });
  });

  it('keeps call tiles and recalled-message placeholders with their person', () => {
    const call = renderExportRow(
      {
        ...base,
        fromUid: '789',
        msgType: 6,
        message: { action: 'recommened.calltime', title: 'x', params: '{"duration":10,"isCaller":0,"calltype":0}' },
      },
      'group',
      '123',
    );
    expect(call?.sender).toEqual({ kind: 'ghost', uid: '789', name: undefined });
    const recalled = renderExportRow(
      { ...base, fromUid: '789', msgType: 20, message: 'Tin nhắn đã bị thu hồi' },
      'group',
      '123',
    );
    expect(recalled?.sender).toMatchObject({ kind: 'ghost', uid: '789' });
  });

  it('renders recalled and deleted rows with an object payload as markers, never the payload', () => {
    const payload = { title: 'removed text', href: 'https://f1.zdn.vn/a.jpg' };
    const recalled = renderExportRow({ ...base, fromUid: '789', msgType: 20, message: payload }, 'group', '123');
    expect(recalled?.content).toEqual({ msgtype: 'm.notice', body: '[Tin nhắn đã thu hồi]' });
    expect(recalled?.media).toBeUndefined();
    const deleted = renderExportRow({ ...base, fromUid: '789', msgType: -27, message: payload }, 'group', '123');
    expect(deleted?.content).toEqual({ msgtype: 'm.notice', body: '[Tin nhắn đã xoá]' });
  });

  it('describes photos as image media with a text fallback', () => {
    const event = renderExportRow(
      {
        ...base,
        fromUid: '789',
        msgType: 2,
        message: { title: 'cap', hdUrl: 'https://f1.zdn.vn/a.jpg', params: '{"width":10,"height":20}' },
      },
      'group',
      '123',
    );
    expect(event?.content.body).toBe('📷 [Ảnh 10×20 — không còn trên máy chủ Zalo]\ncap');
    expect(event?.media).toEqual({
      kind: 'image',
      urls: ['https://f1.zdn.vn/a.jpg'],
      caption: 'cap',
      width: 10,
      height: 20,
      size: undefined,
    });
  });

  it('rewrites JPEG XL photo URLs to their JPEG twin', () => {
    expect(jxlToJpgUrl('https://photo-stal-12.zdn.vn/no/jxl/9c59/2aOb.jxl?jxlstatus=1')).toBe(
      'https://photo-stal-12.zdn.vn/no/jpg/9c59/2aOb.jpg',
    );
    const event = renderExportRow(
      {
        ...base,
        fromUid: '789',
        msgType: 2,
        message: {
          hdUrl: 'https://p.zdn.vn/no/jxl/a/b.jxl?jxlstatus=1',
          oriUrl: 'https://p.zdn.vn/no/jxl/a/b.jxl?jxlstatus=1',
        },
      },
      'user',
      '789',
    );
    expect(event?.media?.urls).toEqual(['https://p.zdn.vn/no/jpg/a/b.jpg']);
  });

  it('describes stickers, videos, files and voice as native media', () => {
    const sticker = renderExportRow(
      { ...base, fromUid: '789', msgType: 4, message: { id: 28408, catId: 10788, type: 7 } },
      'user',
      '789',
    );
    expect(sticker?.media).toEqual({ kind: 'sticker', urls: [stickerImageUrl(28408)], stickerId: 28408 });
    const video = renderExportRow(
      {
        ...base,
        fromUid: '789',
        msgType: 18,
        message: {
          duration: 77000,
          oriUrl: 'https://v.dlmd.me/x',
          params: '{"video_width":576,"video_height":1024,"fileSize":11184731}',
        },
      },
      'user',
      '789',
    );
    expect(video?.content.body).toBe('🎬 [Video 77s — không còn trên máy chủ Zalo]');
    expect(video?.media).toMatchObject({
      kind: 'video',
      urls: ['https://v.dlmd.me/x'],
      width: 576,
      height: 1024,
      durationMs: 77000,
    });
    const file = renderExportRow(
      {
        ...base,
        fromUid: '789',
        msgType: 19,
        message: { title: 'a.pdf', href: 'https://x.zdn.vn/y', params: '{"fileSize":"375945"}' },
      },
      'user',
      '789',
    );
    expect(file?.content.body).toBe('📎 [Tệp] a.pdf (367 KB) — không còn trên máy chủ Zalo');
    expect(file?.media).toEqual({ kind: 'file', urls: ['https://x.zdn.vn/y'], filename: 'a.pdf', size: 375945 });
    const voice = renderExportRow(
      { ...base, fromUid: '789', msgType: 3, message: { params: '{"m4a":"https://v.zdn.vn/a.m4a","duration":4000}' } },
      'user',
      '789',
    );
    expect(voice?.media).toMatchObject({ kind: 'audio', urls: ['https://v.zdn.vn/a.m4a'], durationMs: 4000 });
  });

  it('keeps person mentions and drops uid-less @All ranges', () => {
    const event = renderExportRow(
      {
        ...base,
        fromUid: '789',
        msgType: 1,
        message: '@All @Bob hi',
        mentions: [
          { pos: 0, len: 4 },
          { uid: '42', pos: 5, len: 4 },
        ],
      },
      'group',
      '123',
    );
    expect(event?.mentions).toEqual([{ uid: '42', pos: 5, len: 4 }]);
  });

  it('fills system templates from highlight names', () => {
    const params = JSON.stringify({
      msg: { vi: '%1$s đã ghim tin nhắn %2$s.' },
      highLightsV2: [{ dpn: 'Hà' }, { dpn: 'abc' }],
    });
    const event = renderExportRow(
      { ...base, fromUid: '1', msgType: -1909, message: { title: '', params } },
      'group',
      '123',
    );
    expect(event?.content.body).toBe('Hà đã ghim tin nhắn abc.');
  });

  it('keeps the quote target for a Matrix reply, with a text fallback', () => {
    const event = renderExportRow(
      {
        ...base,
        fromUid: '0',
        msgType: 1,
        message: 'ok',
        quote: { fromD: 'Cody', msg: 'line1\nline2', globalMsgId: 77 },
      },
      'user',
      '456',
    );
    expect(event?.content.body).toBe('ok');
    expect(event?.quote).toEqual({ msgId: '77', fromName: 'Cody', text: 'line1' });
    expect(quoteFallback(event!.quote!)).toBe('> Cody: line1\n\n');
    const media = renderExportRow(
      { ...base, fromUid: '0', msgType: 1, message: 'ok', quote: { fromD: 'Cody', msg: { title: '' } } },
      'user',
      '456',
    );
    expect(media?.quote).toEqual({ msgId: undefined, fromName: 'Cody', text: '[đính kèm]' });
  });

  it('turns link cards into a link preview and calls into a call action message', () => {
    const event = renderExportRow(
      {
        ...base,
        fromUid: '0',
        msgType: 6,
        message: {
          action: 'recommened.link',
          title: 'https://a.vn/x',
          href: 'https://a.vn/x',
          description: 'tóm tắt',
          thumb: 'https://photo-link-talk.zadn.vn/t',
          params: '{"mediaTitle":"Trang A"}',
        },
      },
      'user',
      '456',
    );
    expect(event?.content.body).toBe('Trang A\nhttps://a.vn/x');
    expect(event?.linkPreview).toEqual({
      url: 'https://a.vn/x',
      title: 'Trang A',
      description: 'tóm tắt',
      imageUrl: 'https://photo-link-talk.zadn.vn/t',
    });
    const call = renderExportRow(
      {
        ...base,
        fromUid: '0',
        msgType: 6,
        message: {
          action: 'recommened.calltime',
          title: 'sendBubbleMessage',
          params: '{"duration":10,"isCaller":1,"calltype":0}',
        },
      },
      'user',
      '456',
    );
    expect(call?.content).toEqual({
      msgtype: 'm.text',
      body: 'Cuộc gọi đi · 0:10',
      'com.beeper.action_message': { type: 'call', call_type: 'voice' },
    });
  });

  it("drops the owner's shadow copies (msgId_NNN with the real row present)", () => {
    const rows: ExportRow[] = [
      { ...base, msgId: '8274827362096_001', cliMsgId: '1789650453500', fromUid: '0', msgType: 1, message: 'Ơ' },
      { ...base, msgId: '8274829777338', cliMsgId: '1789650453500', fromUid: '0', msgType: 1, message: 'Ơ' },
      { ...base, msgId: '907083683716_000', cliMsgId: '1', fromUid: '0', msgType: 6, message: {} }, // only copy
    ];
    expect(dropShadowCopies(rows).map((row) => row.msgId)).toEqual(['8274829777338', '907083683716_000']);
  });

  it('drops rows without ids or content', () => {
    expect(renderExportRow({ ...base, msgId: '', msgType: 1, message: 'x' }, 'user', '1')).toBeNull();
    expect(renderExportRow({ ...base, msgType: 1, message: '  ' }, 'user', '1')).toBeNull();
  });
});
