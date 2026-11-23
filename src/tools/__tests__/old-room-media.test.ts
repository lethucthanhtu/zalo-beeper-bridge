import { describe, expect, it } from 'vitest';
import { isMediaKind, mediaKindOf, mediaRef, messageKind } from '../old-room-media.ts';

describe('mediaKindOf', () => {
  it('maps a Matrix media kind to the media descriptor kind', () => {
    expect(mediaKindOf('m.image')).toBe('image');
    expect(mediaKindOf('m.video')).toBe('video');
    expect(mediaKindOf('m.audio')).toBe('audio');
    expect(mediaKindOf('m.file')).toBe('file');
    expect(mediaKindOf('m.sticker')).toBe('sticker');
  });

  it('is null for kinds without media', () => {
    for (const kind of ['m.text', 'm.notice', 'unknown']) expect(mediaKindOf(kind)).toBeNull();
  });
});

describe('messageKind', () => {
  it('is the msgtype of a message and m.sticker for a sticker event', () => {
    expect(messageKind({ type: 'm.room.message', content: { msgtype: 'm.image' } })).toBe('m.image');
    expect(messageKind({ type: 'm.sticker', content: { url: 'mxc://s/1' } })).toBe('m.sticker');
    expect(messageKind({ type: 'm.room.message', content: {} })).toBe('unknown');
  });

  it('treats images, videos, audio, files and stickers as media', () => {
    for (const kind of ['m.image', 'm.video', 'm.audio', 'm.file', 'm.sticker']) expect(isMediaKind(kind)).toBe(true);
    for (const kind of ['m.text', 'm.notice', 'm.emote', 'unknown']) expect(isMediaKind(kind)).toBe(false);
  });
});

describe('mediaRef', () => {
  it('reads the mxc url, mimetype and size of a plain media event', () => {
    const ref = mediaRef({
      type: 'm.room.message',
      content: { msgtype: 'm.image', url: 'mxc://s/a', info: { mimetype: 'image/jpeg', w: 4, h: 3 } },
    });
    expect(ref).toEqual({ mxc: 'mxc://s/a', mimetype: 'image/jpeg', width: 4, height: 3 });
  });

  it('reads the encrypted file of a media event in an encrypted room', () => {
    const file = { url: 'mxc://s/b', key: { k: 'x' }, iv: 'y', hashes: { sha256: 'z' }, v: 'v2' };
    const ref = mediaRef({ type: 'm.sticker', content: { file, info: { mimetype: 'image/webp' } } });
    expect(ref).toEqual({ mxc: 'mxc://s/b', file, mimetype: 'image/webp' });
  });

  it('is null for text and for media events without a url', () => {
    expect(mediaRef({ type: 'm.room.message', content: { msgtype: 'm.text', body: 'hi' } })).toBeNull();
    expect(mediaRef({ type: 'm.room.message', content: { msgtype: 'm.image' } })).toBeNull();
  });
});
