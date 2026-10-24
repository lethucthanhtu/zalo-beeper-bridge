// Zalo voice notes are raw ADTS AAC streams (served as image/jpeg, named .m4a). Players
// that pick a parser from the name/type (iOS AVFoundation especially) cannot play them,
// and no Matrix client expects bare ADTS. This module repackages the AAC frames into an
// M4A (MP4 audio) file — the same container Beeper iOS records voice notes in — without
// re-encoding: each ADTS frame's payload becomes one MP4 sample.
//
// Layout written (fast-start: moov before mdat):
//   ftyp, moov(mvhd, trak(tkhd, mdia(mdhd, hdlr, minf(smhd, dinf/dref, stbl(stsd/mp4a/esds,
//   stts, stsc, stsz, stco))))), mdat

/** Sampling rates by ADTS sampling_frequency_index (ISO 14496-3 table 1.18). */
const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** PCM samples per AAC frame (AAC-LC). */
const SAMPLES_PER_FRAME = 1024;

/** One parsed ADTS frame: its AAC payload plus the stream parameters from its header. */
type AdtsFrame = {
  payload: Buffer;
  /** MPEG-4 audio object type (ADTS profile + 1; 2 = AAC-LC) */
  objectType: number;
  sampleRateIndex: number;
  channelConfig: number;
};

/** True when the bytes start with an ADTS sync word (0xFFF, layer 0). */
export function isAdts(bytes: Buffer): boolean {
  return bytes.length >= 7 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0;
}

/**
 * Splits an ADTS stream into frames.
 *
 * @returns the frames, or null when the stream is not clean ADTS (lost sync, truncated
 *   frame, more than one raw data block per frame, or parameters changing mid-stream)
 */
function parseAdts(bytes: Buffer): AdtsFrame[] | null {
  const frames: AdtsFrame[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 7 || bytes[offset] !== 0xff || ((bytes[offset + 1] ?? 0) & 0xf6) !== 0xf0) return null;
    const protectionAbsent = (bytes[offset + 1]! & 0x01) === 1;
    const objectType = ((bytes[offset + 2]! >> 6) & 0x03) + 1;
    const sampleRateIndex = (bytes[offset + 2]! >> 2) & 0x0f;
    const channelConfig = ((bytes[offset + 2]! & 0x01) << 2) | ((bytes[offset + 3]! >> 6) & 0x03);
    const frameLength =
      ((bytes[offset + 3]! & 0x03) << 11) | (bytes[offset + 4]! << 3) | ((bytes[offset + 5]! >> 5) & 0x07);
    const rawBlocks = (bytes[offset + 6]! & 0x03) + 1;
    const headerLength = protectionAbsent ? 7 : 9;
    if (rawBlocks !== 1 || frameLength <= headerLength || offset + frameLength > bytes.length) return null;
    if (sampleRateIndex >= SAMPLE_RATES.length || channelConfig === 0) return null;
    const first = frames[0];
    if (
      first &&
      (first.objectType !== objectType ||
        first.sampleRateIndex !== sampleRateIndex ||
        first.channelConfig !== channelConfig)
    ) {
      return null;
    }
    frames.push({
      payload: bytes.subarray(offset + headerLength, offset + frameLength),
      objectType,
      sampleRateIndex,
      channelConfig,
    });
    offset += frameLength;
  }
  return frames.length ? frames : null;
}

/** An MP4 box: 32-bit size + 4-char type + body. */
function box(type: string, ...body: Buffer[]): Buffer {
  const content = Buffer.concat(body);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + content.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

/** An MP4 "full box": a box whose body starts with version (8 bits) + flags (24 bits). */
function fullBox(type: string, version: number, flags: number, ...body: Buffer[]): Buffer {
  const versionAndFlags = Buffer.alloc(4);
  versionAndFlags.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, versionAndFlags, ...body);
}

/** Big-endian unsigned integers of the given byte widths, concatenated. */
function uints(...fields: Array<[value: number, bytes: 1 | 2 | 3 | 4]>): Buffer {
  const out = Buffer.alloc(fields.reduce((sum, [, bytes]) => sum + bytes, 0));
  let offset = 0;
  for (const [value, bytes] of fields) {
    out.writeUIntBE(value, offset, bytes);
    offset += bytes;
  }
  return out;
}

/** The 3x3 identity transformation matrix used in mvhd/tkhd (16.16 / 2.30 fixed point). */
const IDENTITY_MATRIX = uints(
  [0x00010000, 4],
  [0, 4],
  [0, 4],
  [0, 4],
  [0x00010000, 4],
  [0, 4],
  [0, 4],
  [0, 4],
  [0x40000000, 4],
);

/** An MPEG-4 descriptor (tag + single-byte length — every descriptor here is < 128 bytes). */
function descriptor(tag: number, ...body: Buffer[]): Buffer {
  const content = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag, content.length]), content]);
}

/** The esds box: ES descriptor → decoder config (AAC, audio stream) → AudioSpecificConfig. */
function esds(frame: AdtsFrame, avgBitrate: number, maxFrameBytes: number): Buffer {
  // AudioSpecificConfig: objectType(5) sampleRateIndex(4) channelConfig(4) + 3 zero bits
  const audioSpecificConfig = uints([
    (frame.objectType << 11) | (frame.sampleRateIndex << 7) | (frame.channelConfig << 3),
    2,
  ]);
  const decoderConfig = descriptor(
    0x04,
    uints([0x40, 1], [0x15, 1], [maxFrameBytes, 3], [avgBitrate, 4], [avgBitrate, 4]), // 0x40 = AAC, 0x15 = audio stream
    descriptor(0x05, audioSpecificConfig),
  );
  return fullBox(
    'esds',
    0,
    0,
    descriptor(0x03, uints([0, 2], [0, 1]), decoderConfig, descriptor(0x06, Buffer.from([0x02]))),
  );
}

/**
 * Repackages a raw ADTS AAC stream into an M4A file without re-encoding.
 *
 * @param adts the raw ADTS stream (e.g. a Zalo voice note)
 * @returns the M4A bytes and the audio length in milliseconds, or null when the input is
 *   not clean ADTS (callers then keep the original bytes)
 */
export function adtsToM4a(adts: Buffer): { m4a: Buffer; durationMs: number } | null {
  const frames = parseAdts(adts);
  if (!frames) return null;
  const first = frames[0]!;
  const sampleRate = SAMPLE_RATES[first.sampleRateIndex]!;
  const totalSamples = frames.length * SAMPLES_PER_FRAME;
  const durationMs = Math.round((totalSamples / sampleRate) * 1000);
  const payloadBytes = frames.reduce((sum, frame) => sum + frame.payload.length, 0);
  const avgBitrate = Math.round((payloadBytes * 8 * sampleRate) / totalSamples);
  const maxFrameBytes = Math.max(...frames.map((frame) => frame.payload.length));

  const ftyp = box('ftyp', Buffer.from('M4A ', 'latin1'), uints([0, 4]), Buffer.from('M4A mp42isom', 'latin1'));

  /** moov for a given mdat payload offset (the offset field has a fixed width, so the size does not depend on it). */
  const buildMoov = (chunkOffset: number): Buffer => {
    const mvhd = fullBox(
      'mvhd',
      0,
      0,
      uints([0, 4], [0, 4], [1000, 4], [durationMs, 4], [0x00010000, 4], [0x0100, 2]), // times, timescale ms, duration, rate 1.0, volume 1.0
      Buffer.alloc(10), // reserved
      IDENTITY_MATRIX,
      Buffer.alloc(24), // pre_defined
      uints([2, 4]), // next_track_ID
    );
    const tkhd = fullBox(
      'tkhd',
      0,
      0x000003, // enabled | in movie
      uints([0, 4], [0, 4], [1, 4], [0, 4], [durationMs, 4]), // times, track_ID 1, reserved, duration
      Buffer.alloc(8), // reserved
      uints([0, 2], [0, 2], [0x0100, 2], [0, 2]), // layer, alternate_group, volume 1.0, reserved
      IDENTITY_MATRIX,
      uints([0, 4], [0, 4]), // width, height (audio: 0)
    );
    const mdhd = fullBox('mdhd', 0, 0, uints([0, 4], [0, 4], [sampleRate, 4], [totalSamples, 4], [0x55c4, 2], [0, 2])); // language "und"
    const hdlr = fullBox(
      'hdlr',
      0,
      0,
      uints([0, 4]),
      Buffer.from('soun', 'latin1'),
      Buffer.alloc(12),
      Buffer.from('SoundHandler\0', 'latin1'),
    );
    const smhd = fullBox('smhd', 0, 0, uints([0, 2], [0, 2])); // balance, reserved
    const dinf = box('dinf', fullBox('dref', 0, 0, uints([1, 4]), fullBox('url ', 0, 0x000001))); // media in this file
    const mp4a = box(
      'mp4a',
      Buffer.alloc(6), // reserved
      uints([1, 2]), // data_reference_index
      Buffer.alloc(8), // reserved
      // channels, sample size, pre_defined, reserved, rate as 16.16 (0 when it doesn't fit; mdhd has the real rate)
      uints([first.channelConfig, 2], [16, 2], [0, 2], [0, 2], [sampleRate <= 0xffff ? sampleRate * 0x10000 : 0, 4]),
      esds(first, avgBitrate, maxFrameBytes),
    );
    const stsd = fullBox('stsd', 0, 0, uints([1, 4]), mp4a);
    const stts = fullBox('stts', 0, 0, uints([1, 4], [frames.length, 4], [SAMPLES_PER_FRAME, 4]));
    const stsc = fullBox('stsc', 0, 0, uints([1, 4], [1, 4], [frames.length, 4], [1, 4])); // all samples in one chunk
    const stsz = fullBox(
      'stsz',
      0,
      0,
      uints([0, 4], [frames.length, 4]),
      ...frames.map((frame) => uints([frame.payload.length, 4])),
    );
    const stco = fullBox('stco', 0, 0, uints([1, 4], [chunkOffset, 4]));
    const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
    return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', smhd, dinf, stbl))));
  };

  const moovSize = buildMoov(0).length;
  const moov = buildMoov(ftyp.length + moovSize + 8); // payload starts after the mdat header
  const mdat = box('mdat', ...frames.map((frame) => frame.payload));
  return { m4a: Buffer.concat([ftyp, moov, mdat]), durationMs };
}
