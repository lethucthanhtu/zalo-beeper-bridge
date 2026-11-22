import { describe, expect, it, vi } from 'vitest';
import { adtsDurationMs, adtsToM4a, isAdts } from '../audio-remux.ts';
import { decryptAttachment } from '../../matrix/crypto.ts';
import {
  buildLinkPreview,
  buildMediaEvent,
  downloadFirstMedia,
  isTransientMediaError,
  MediaDownloadError,
  roomUploader,
} from '../media-content.ts';
import { toMatrixWaveform } from '../../media-descriptor.ts';
import { assertZaloMediaUrl, fetchMediaCapped, MediaHttpError, sniffMimetype } from '../media-fetch.ts';
import { aacVoiceFilename } from '../outbound-handler.ts';

/** Buffer starting with the given signature bytes, zero-padded by 16 bytes so offset reads stay in range. */
const bytes = (...leadingBytes: number[]) => Buffer.from([...leadingBytes, ...new Array(16).fill(0)]);

describe('sniffMimetype', () => {
  it("trusts the bytes over Zalo's content-type", () => {
    expect(sniffMimetype(Buffer.from('GIF89a........'), 'image/jpeg')).toBe('image/gif');
    expect(sniffMimetype(bytes(0xff, 0xd8, 0xff), 'application/octet-stream')).toBe('image/jpeg');
    expect(sniffMimetype(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/jpeg')).toBe('image/png');
    expect(sniffMimetype(Buffer.from('RIFF\0\0\0\0WEBPVP8X'), '')).toBe('image/webp');
    expect(sniffMimetype(Buffer.from('\0\0\0\x20ftypisom....'), 'image/jpeg')).toBe('video/mp4');
  });

  it('recognises raw ADTS AAC voice notes Zalo serves as image/jpeg', () => {
    expect(sniffMimetype(bytes(0xff, 0xf9, 0x50, 0x60), 'image/jpeg')).toBe('audio/aac');
    expect(sniffMimetype(bytes(0xff, 0xf1, 0x50, 0x80), 'image/jpeg')).toBe('audio/aac');
    expect(sniffMimetype(Buffer.from('#!AMR\n........'), 'image/jpeg')).toBe('audio/amr');
  });

  it('keeps the fallback for unknown bytes', () => {
    expect(sniffMimetype(Buffer.from('hello world.....'), 'text/plain')).toBe('text/plain');
  });
});

describe('buildMediaEvent', () => {
  const upload = vi.fn(async () => ({ url: 'mxc://x/y' }));

  it('marks voice notes as MSC3245 voice with an audio type and a name matching it', async () => {
    const { type, content } = await buildMediaEvent(
      upload,
      { kind: 'audio', urls: [], filename: 'Voice message.m4a', durationMs: 5474.4 },
      { buffer: Buffer.alloc(10), mimetype: 'image/jpeg' },
    );
    expect(type).toBe('m.room.message');
    expect(content).toMatchObject({
      msgtype: 'm.audio',
      body: 'Voice message.aac',
      info: { mimetype: 'audio/aac', size: 10, duration: 5474 },
      'org.matrix.msc3245.voice': {},
      'org.matrix.msc1767.audio': { duration: 5474, waveform: [] },
    });
  });

  it('repackages a Zalo ADTS voice note as M4A and keeps its waveform', async () => {
    const adts = adtsStream(10, 44100);
    const { content } = await buildMediaEvent(
      upload,
      { kind: 'audio', urls: [], filename: 'Voice message.m4a', waveform: [0, 512, 1024] },
      { buffer: adts, mimetype: 'image/jpeg' },
    );
    expect(content).toMatchObject({
      body: 'Voice message.m4a',
      info: { mimetype: 'audio/mp4', duration: Math.round((10 * 1024 * 1000) / 44100) },
      'org.matrix.msc1767.audio': { waveform: [0, 512, 1024] },
    });
  });
});

/**
 * A synthetic ADTS AAC-LC stream (mono, given rate) of `frameCount` frames, each with a
 * 7-byte header (no CRC) and a 20-byte dummy payload — enough to exercise the remuxer.
 */
function adtsStream(frameCount: number, sampleRate: number): Buffer {
  const rateIndex = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000].indexOf(sampleRate);
  const frames: Buffer[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const frameLength = 7 + 20;
    const header = Buffer.from([
      0xff,
      0xf1, // sync, MPEG-4, layer 0, no CRC
      (1 << 6) | (rateIndex << 2) | 0, // profile AAC-LC (1), rate index, private 0, channel bit 2 = 0
      (1 << 6) | ((frameLength >> 11) & 0x03), // channel config 1 (mono), frame length bits 12-11
      (frameLength >> 3) & 0xff, // frame length bits 10-3
      ((frameLength & 0x07) << 5) | 0x1f, // frame length bits 2-0, buffer fullness high bits
      0xfc, // buffer fullness low bits, 1 raw data block
    ]);
    frames.push(header, Buffer.alloc(20, frame));
  }
  return Buffer.concat(frames);
}

/** Top-level box types of an MP4 file, in order. */
function topLevelBoxes(file: Buffer): string[] {
  const types: string[] = [];
  for (let offset = 0; offset + 8 <= file.length; offset += file.readUInt32BE(offset)) {
    types.push(file.toString('latin1', offset + 4, offset + 8));
  }
  return types;
}

describe('adtsToM4a', () => {
  it('remuxes ADTS frames into a fast-start M4A with one sample per frame', () => {
    const result = adtsToM4a(adtsStream(235, 44100));
    expect(result).not.toBeNull();
    expect(adtsDurationMs(adtsStream(235, 44100))).toBe(5457);
    expect(adtsDurationMs(Buffer.from('not audio at all'))).toBeNull();
    expect(result!.durationMs).toBe(5457); // 235 × 1024 samples at 44.1 kHz, like a real Zalo voice note
    expect(topLevelBoxes(result!.m4a)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(result!.m4a.toString('latin1', 8, 12)).toBe('M4A ');
    // mdat holds exactly the 235 payloads (headers stripped)
    const mdatOffset = result!.m4a.lastIndexOf(Buffer.from('mdat', 'latin1')) - 4;
    expect(result!.m4a.readUInt32BE(mdatOffset)).toBe(8 + 235 * 20);
    // AudioSpecificConfig for AAC-LC / 44.1 kHz / mono is 0x12 0x08
    expect(result!.m4a.includes(Buffer.from([0x05, 0x02, 0x12, 0x08]))).toBe(true);
  });

  it('rejects streams that are not clean ADTS', () => {
    expect(isAdts(Buffer.from('not audio at all'))).toBe(false);
    expect(adtsToM4a(Buffer.from('not audio at all'))).toBeNull();
    expect(adtsToM4a(adtsStream(3, 44100).subarray(0, 30))).toBeNull(); // truncated frame
  });
});

describe('toMatrixWaveform', () => {
  it('scales Zalo amplitudes to 0–1024 and ignores unusable input', () => {
    expect(toMatrixWaveform([11000, 15600, 7800])).toEqual([722, 1024, 512]);
    expect(toMatrixWaveform('[1, 2]')).toEqual([512, 1024]);
    expect(toMatrixWaveform('nope')).toBeUndefined();
    expect(toMatrixWaveform([0, 0])).toBeUndefined();
    expect(toMatrixWaveform(undefined)).toBeUndefined();
    const long = toMatrixWaveform(Array.from({ length: 1000 }, (_, i) => i + 1))!;
    expect(long).toHaveLength(100); // long sample lists are reduced to peaks
    expect(long.at(-1)).toBe(1024);
  });
});

describe('buildMediaEvent (stickers and files)', () => {
  const upload = vi.fn(async () => ({ url: 'mxc://x/y' }));

  it('builds stickers, files with names and reuses a cached mxc', async () => {
    upload.mockClear();
    const sticker = await buildMediaEvent(
      upload,
      { kind: 'sticker', urls: [], stickerId: 1 },
      { buffer: Buffer.alloc(4), mimetype: 'image/webp', width: 130, height: 130 },
      { uploaded: { url: 'mxc://x/cached' } },
    );
    expect(upload).not.toHaveBeenCalled();
    expect(sticker).toMatchObject({
      type: 'm.sticker',
      content: { body: 'sticker', url: 'mxc://x/cached', info: { w: 130, h: 130 } },
    });
    const file = await buildMediaEvent(
      upload,
      { kind: 'file', urls: [], filename: 'a.pdf' },
      { buffer: Buffer.alloc(3), mimetype: 'application/pdf' },
    );
    expect(file.content).toMatchObject({ msgtype: 'm.file', body: 'a.pdf', filename: 'a.pdf', url: 'mxc://x/y' });
  });
});

describe('roomUploader', () => {
  it('uploads plain rooms as they are and returns the url', async () => {
    const raw = vi.fn(async () => 'mxc://x/plain');
    const uploaded = await roomUploader(raw, false)(Buffer.from('abc'), { type: 'image/png', name: 'a.png' });
    expect(uploaded).toEqual({ url: 'mxc://x/plain' });
    expect(raw).toHaveBeenCalledWith(Buffer.from('abc'), { type: 'image/png', name: 'a.png' });
  });

  it('uploads ciphertext as an opaque blob for encrypted rooms and returns the key as file', async () => {
    const raw = vi.fn(async (_buffer: Buffer, _options: { type: string; name?: string }) => 'mxc://x/enc');
    const plain = Buffer.from('secret picture bytes');
    const uploaded = await roomUploader(raw, true)(plain, { type: 'image/png', name: 'a.png' });
    expect(raw).toHaveBeenCalledTimes(1);
    const [sent, options] = raw.mock.calls[0]!;
    expect(options).toEqual({ type: 'application/octet-stream' });
    expect(sent.equals(plain)).toBe(false);
    if (!('file' in uploaded)) throw new Error('expected an encrypted upload');
    expect(uploaded.file).toMatchObject({ url: 'mxc://x/enc', v: 'v2' });
    expect(decryptAttachment(sent, uploaded.file).equals(plain)).toBe(true);
  });
});

describe('buildMediaEvent in an encrypted room', () => {
  const file = { url: 'mxc://x/enc', v: 'v2' } as never;
  const upload = vi.fn(async () => ({ file }));

  it('puts the key in content.file and leaves content.url out, for media and stickers', async () => {
    const image = await buildMediaEvent(
      upload,
      { kind: 'image', urls: [] },
      { buffer: Buffer.alloc(4), mimetype: 'image/png', width: 2, height: 3 },
    );
    expect(image.content).toMatchObject({ msgtype: 'm.image', file, info: { mimetype: 'image/png', w: 2, h: 3 } });
    expect(image.content).not.toHaveProperty('url');
    expect(image.uploaded).toEqual({ file });

    const sticker = await buildMediaEvent(
      upload,
      { kind: 'sticker', urls: [], stickerId: 1 },
      { buffer: Buffer.alloc(4), mimetype: 'image/webp' },
    );
    expect(sticker.content).toMatchObject({ body: 'sticker', file });
    expect(sticker.content).not.toHaveProperty('url');
  });

  it('encrypts the M4A of a voice note, not the raw ADTS stream', async () => {
    upload.mockClear();
    await buildMediaEvent(
      upload,
      { kind: 'audio', urls: [], filename: 'Voice message.m4a' },
      { buffer: adtsStream(10, 44100), mimetype: 'image/jpeg' },
    );
    expect(upload).toHaveBeenCalledWith(expect.any(Buffer), { type: 'audio/mp4', name: 'Voice message.m4a' });
  });
});

describe('buildLinkPreview', () => {
  it('keeps a text-only preview when there is no thumbnail', async () => {
    const preview = await buildLinkPreview(
      vi.fn(),
      { url: 'https://a.vn/x', title: 'Trang A', description: 'tóm tắt' },
      1000,
    );
    expect(preview).toEqual({
      matched_url: 'https://a.vn/x',
      'og:url': 'https://a.vn/x',
      'og:title': 'Trang A',
      'og:description': 'tóm tắt',
    });
  });
});

describe('buildLinkPreview thumbnails', () => {
  const png = new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), {
    headers: { 'content-type': 'image/png' },
  });
  const preview = { url: 'https://a.vn/x', title: 'A', imageUrl: 'https://f1.zdn.vn/t.png' };

  it('sets og:image for a plain upload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(png.clone());
    const entry = await buildLinkPreview(async () => ({ url: 'mxc://x/t' }), preview, 1000);
    fetchMock.mockRestore();
    expect(entry).toMatchObject({ 'og:image': 'mxc://x/t', 'og:image:type': 'image/png', 'matrix:image:size': 12 });
    expect(entry).not.toHaveProperty('beeper:image:encryption');
  });

  it('uses beeper:image:encryption and no og:image for an encrypted upload, like mautrix', async () => {
    const file = { url: 'mxc://x/t', v: 'v2' } as never;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(png.clone());
    const entry = await buildLinkPreview(async () => ({ file }), preview, 1000);
    fetchMock.mockRestore();
    expect(entry).toMatchObject({ 'beeper:image:encryption': file, 'og:image:type': 'image/png' });
    expect(entry).not.toHaveProperty('og:image');
  });
});

describe('aacVoiceFilename', () => {
  it('sends AAC voice notes as Zalo voice and leaves other codecs as files', () => {
    expect(aacVoiceFilename('audio/x-m4a', Buffer.from('\0\0\0\x20ftypM4A '))).toBe('voice.m4a');
    expect(aacVoiceFilename('audio/mp4', Buffer.alloc(8))).toBe('voice.m4a');
    expect(aacVoiceFilename('application/octet-stream', bytes(0xff, 0xf1, 0x50, 0x80))).toBe('voice.aac');
    expect(aacVoiceFilename('audio/ogg; codecs=opus', Buffer.from('OggS....'))).toBeNull();
  });
});

describe('media URL guard', () => {
  it('only allows https URLs on Zalo CDN hosts', () => {
    expect(() => assertZaloMediaUrl('https://f1.zdn.vn/a.jpg')).not.toThrow();
    expect(() => assertZaloMediaUrl('http://f1.zdn.vn/a.jpg')).toThrow(/non-https/);
    expect(() => assertZaloMediaUrl('https://evil.example/a.jpg')).toThrow(/outside Zalo CDN/);
  });

  it('re-checks every redirect hop, so a CDN redirect cannot reach another host', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } }));
    await expect(fetchMediaCapped('https://f1.zdn.vn/a.jpg', 1000)).rejects.toThrow(/outside Zalo CDN/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    fetchMock.mockRestore();
  });

  it('follows redirects that stay on Zalo hosts', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://f2.zadn.vn/b.jpg' } }))
      .mockResolvedValueOnce(
        new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } }),
      );
    const media = await fetchMediaCapped('https://f1.zdn.vn/a.jpg', 1000);
    expect(media.mimetype).toBe('image/jpeg');
    expect(fetchMock.mock.calls[1]![0]).toBe('https://f2.zadn.vn/b.jpg');
    fetchMock.mockRestore();
  });

  it('follows the video / file CDN hand-off (dlmd.me → mdchat.me, dlfl.vn → flchat.vn)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: 'https://file-stal-22.flchat.vn/gr/a/b' } }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://file-stal-22-te-vnso-ne-1.flchat.vn/gr/a/b' },
        }),
      )
      .mockResolvedValueOnce(new Response(Buffer.from('%PDF-1.7'), { headers: { 'content-type': 'application/pdf' } }));
    const media = await fetchMediaCapped('https://file-stal-22.dlfl.vn/gr/a/b', 1000);
    expect(media.mimetype).toBe('application/pdf');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockRestore();
    expect(() => assertZaloMediaUrl('https://video-stal-15-te-vnso-cm-15.mdchat.me/gr/a/b')).not.toThrow();
  });
});

describe('isTransientMediaError', () => {
  it('retries server hiccups and dropped connections, not expired links', () => {
    expect(isTransientMediaError(new MediaHttpError(503))).toBe(true);
    expect(isTransientMediaError(new MediaHttpError(429))).toBe(true);
    expect(isTransientMediaError(new MediaHttpError(400))).toBe(false);
    expect(isTransientMediaError(new MediaHttpError(404))).toBe(false);
    expect(isTransientMediaError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientMediaError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientMediaError(Object.assign(new Error('socket'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isTransientMediaError(new Error('media download returned an error page'))).toBe(false);
    expect(isTransientMediaError('nope')).toBe(false);
  });
});

describe('downloadFirstMedia', () => {
  const jpeg = () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg' } });
  const status = (code: number) => new Response(null, { status: code });
  const quiet = () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  };

  it('falls back to the next candidate when the first link has expired (4xx, no retry)', async () => {
    quiet();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(status(400)).mockResolvedValueOnce(jpeg());
    const media = await downloadFirstMedia(['https://f1.zdn.vn/href.jpg', 'https://f1.zdn.vn/hd.jpg'], 1000, {
      retryDelayMs: 0,
    });
    expect(media.mimetype).toBe('image/jpeg');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://f1.zdn.vn/href.jpg',
      'https://f1.zdn.vn/hd.jpg',
    ]);
    vi.restoreAllMocks();
  });

  it('retries a transient failure once on the same URL', async () => {
    quiet();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(status(503)).mockResolvedValueOnce(jpeg());
    await downloadFirstMedia(['https://f1.zdn.vn/a.jpg', 'https://f1.zdn.vn/b.jpg'], 1000, { retryDelayMs: 0 });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['https://f1.zdn.vn/a.jpg', 'https://f1.zdn.vn/a.jpg']);
    vi.restoreAllMocks();
  });

  it('throws MediaDownloadError naming hosts only (no signed path) when every candidate fails', async () => {
    quiet();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => status(403));
    const error = await downloadFirstMedia(['https://f1.zdn.vn/secret-token.jpg', 'https://f2.zadn.vn/x.jpg'], 1000, {
      retryDelayMs: 0,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MediaDownloadError);
    expect((error as MediaDownloadError).failures).toEqual([
      'f1.zdn.vn: media download failed: HTTP 403',
      'f2.zadn.vn: media download failed: HTTP 403',
    ]);
    expect((error as Error).message).not.toContain('secret-token');
    vi.restoreAllMocks();
  });

  it('fails clearly when there is no candidate URL', async () => {
    await expect(downloadFirstMedia([], 1000)).rejects.toBeInstanceOf(MediaDownloadError);
  });
});
