import { describe, expect, it } from 'vitest';
import { isLargeMedia, LARGE_MEDIA_MAX_BYTES, mediaMaxBytesFor } from '../media-content.ts';
import {
  E2EE_NOTICE_BODY,
  formatBytes,
  locationContent,
  mediaGoneBody,
  UNSUPPORTED_NOTICE_PREFIX,
  unsupportedNoticeBody,
} from '../zalo-render.ts';

const GONE = 'không còn trên máy chủ Zalo';

describe('unsupportedNoticeBody', () => {
  it('starts with the prefix the re-render parses back', () => {
    expect(unsupportedNoticeBody('chat.todo')).toBe(`${UNSUPPORTED_NOTICE_PREFIX} chat.todo]`);
  });

  it('explains end-to-end encrypted messages instead of naming the type', () => {
    expect(unsupportedNoticeBody('e2ee')).toBe(E2EE_NOTICE_BODY);
  });
});

describe('locationContent', () => {
  it('builds a native m.location with the MSC3488 pin', () => {
    const content = locationContent({
      kind: 'location',
      latitude: 10.5,
      longitude: 106.7,
      label: 'Home',
      text: 'Home, HCMC',
    });
    expect(content).toEqual({
      msgtype: 'm.location',
      body: 'Home, HCMC',
      geo_uri: 'geo:10.5,106.7',
      'org.matrix.msc3488.location': { uri: 'geo:10.5,106.7', description: 'Home' },
      'org.matrix.msc3488.asset': { type: 'm.pin' },
      'org.matrix.msc1767.text': 'Home, HCMC',
    });
  });
});

describe('formatBytes', () => {
  it('rounds to KB below 1 MB and to one decimal MB above', () => {
    expect(formatBytes(100)).toBe('1 KB');
    expect(formatBytes(367 * 1024)).toBe('367 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('is empty for unknown sizes', () => {
    for (const value of [0, -1, NaN, Infinity]) expect(formatBytes(value)).toBe('');
  });
});

describe('mediaGoneBody', () => {
  it('keeps photo dimensions and caption', () => {
    expect(mediaGoneBody({ kind: 'image', urls: [], width: 10, height: 20, caption: 'cap' })).toBe(
      `📷 [Ảnh 10×20 — ${GONE}]\ncap`,
    );
    expect(mediaGoneBody({ kind: 'image', urls: [] })).toBe(`📷 [Ảnh — ${GONE}]`);
  });

  it('keeps voice and video length', () => {
    expect(mediaGoneBody({ kind: 'audio', urls: [], durationMs: 4400 })).toBe(`🎤 [Tin nhắn thoại 4s — ${GONE}]`);
    expect(mediaGoneBody({ kind: 'video', urls: [], durationMs: 77_000, caption: 'trip' })).toBe(
      `🎬 [Video 77s — ${GONE}]\ntrip`,
    );
  });

  it('keeps the file name and size', () => {
    expect(mediaGoneBody({ kind: 'file', urls: [], filename: 'a.pdf', size: 367 * 1024 })).toBe(
      `📎 [Tệp] a.pdf (367 KB) — ${GONE}`,
    );
    expect(mediaGoneBody({ kind: 'file', urls: [] })).toBe(`📎 [Tệp] zalo-file — ${GONE}`);
  });

  it('says only [Sticker] for a sticker', () => {
    expect(mediaGoneBody({ kind: 'sticker', urls: [] })).toBe('[Sticker]');
  });
});

describe('mediaMaxBytesFor', () => {
  it('raises the cap for videos and documents only', () => {
    expect(isLargeMedia('video')).toBe(true);
    expect(isLargeMedia('image')).toBe(false);
    expect(mediaMaxBytesFor('file', 1000)).toBe(LARGE_MEDIA_MAX_BYTES);
    expect(mediaMaxBytesFor('image', 1000)).toBe(1000);
  });

  it('never lowers a configured cap above the large-media cap', () => {
    expect(mediaMaxBytesFor('video', LARGE_MEDIA_MAX_BYTES * 2)).toBe(LARGE_MEDIA_MAX_BYTES * 2);
  });
});
