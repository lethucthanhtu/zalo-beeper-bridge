import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

// A fake ffmpeg that stays running until the test closes it, to observe how many run at once
const running: Array<{ close: (code: number) => void }> = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    running.push({ close: (code) => child.emit('close', code) });
    return child;
  },
}));

const { makeThumbnail } = await import('../image-thumbnail.ts');

describe('makeThumbnail queue', () => {
  it('runs one ffmpeg at a time, so a burst of photos cannot starve each other into timeouts', async () => {
    const results = [makeThumbnail(Buffer.from('a')), makeThumbnail(Buffer.from('b')), makeThumbnail(Buffer.from('c'))];
    await vi.waitFor(() => expect(running).toHaveLength(1));
    running[0]!.close(1);
    await vi.waitFor(() => expect(running).toHaveLength(2));
    running[1]!.close(1);
    await vi.waitFor(() => expect(running).toHaveLength(3));
    running[2]!.close(1);
    expect(await Promise.all(results)).toEqual([null, null, null]);
  });
});
