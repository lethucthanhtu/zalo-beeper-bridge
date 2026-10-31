import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isAdts, transcodeToAac } from '../audio-remux.ts';

// The container image and GitHub's ubuntu runners ship ffmpeg; skip where it is missing
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('transcodeToAac', () => {
  it.skipIf(!hasFfmpeg)('re-encodes an ogg/opus voice note (Beeper Android) into ADTS AAC', async () => {
    // 1 s of a 440 Hz tone as ogg/opus — the format Beeper Android records voice notes in
    const opus = spawnSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'],
      ...['-c:a', 'libopus', '-f', 'ogg', 'pipe:1'],
    ]).stdout;
    expect(opus.subarray(0, 4).toString('latin1')).toBe('OggS');
    const aac = await transcodeToAac(opus);
    expect(aac && isAdts(aac)).toBe(true);
  });

  it.skipIf(!hasFfmpeg)('returns null for bytes ffmpeg cannot decode', async () => {
    expect(await transcodeToAac(Buffer.from('not audio at all'))).toBeNull();
  });
});
