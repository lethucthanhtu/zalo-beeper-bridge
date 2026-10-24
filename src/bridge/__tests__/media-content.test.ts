import { describe, expect, it, vi } from 'vitest';
import { adtsToM4a, isAdts } from '../audio-remux.ts';
import { buildLinkPreview, buildMediaEvent, toMatrixWaveform } from '../media-content.ts';
import { assertZaloMediaUrl, fetchMediaCapped, sniffMimetype } from '../media-handler.ts';
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
  const upload = vi.fn(async () => 'mxc://x/y');

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
  const upload = vi.fn(async () => 'mxc://x/y');

  it('builds stickers, files with names and reuses a cached mxc', async () => {
    upload.mockClear();
    const sticker = await buildMediaEvent(
      upload,
      { kind: 'sticker', urls: [], stickerId: 1 },
      { buffer: Buffer.alloc(4), mimetype: 'image/webp', width: 130, height: 130 },
      { mxcUrl: 'mxc://x/cached' },
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
});
