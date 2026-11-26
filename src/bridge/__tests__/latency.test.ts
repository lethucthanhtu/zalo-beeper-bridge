import type { Intent } from 'matrix-appservice-bridge';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SLOW_MS, PhaseTimer, slowThresholdMs, timeIntent } from '../latency.ts';

/** A manual clock: `tick(ms)` moves time forward. */
function clock() {
  let t = 1000;
  return { now: () => t, tick: (ms: number) => void (t += ms) };
}

describe('slowThresholdMs', () => {
  it('defaults to 1500 ms', () => {
    expect(slowThresholdMs({})).toBe(DEFAULT_SLOW_MS);
    expect(DEFAULT_SLOW_MS).toBe(1500);
  });

  it('reads BRIDGE_SLOW_MS, including 0 (log everything)', () => {
    expect(slowThresholdMs({ BRIDGE_SLOW_MS: '300' })).toBe(300);
    expect(slowThresholdMs({ BRIDGE_SLOW_MS: '0' })).toBe(0);
  });

  it('falls back to the default for blank, negative or non-numeric values', () => {
    for (const bad of ['', '  ', '-5', 'fast', 'NaN']) {
      expect(slowThresholdMs({ BRIDGE_SLOW_MS: bad })).toBe(DEFAULT_SLOW_MS);
    }
  });
});

describe('PhaseTimer', () => {
  it('prints one line with the phases in order when the total is over the threshold', () => {
    const c = clock();
    const log = vi.fn();
    const timer = new PhaseTimer('in group photo msg=42', { slowMs: 1500, now: c.now, log });
    c.tick(100);
    timer.lap('queue');
    c.tick(250);
    timer.lap('ghost');
    c.tick(3100);
    timer.lap('prepare');
    c.tick(820);
    timer.lap('send');
    c.tick(5);
    expect(timer.finish()).toBe(4275);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[timing] in group photo msg=42 total=4275ms queue=100ms ghost=250ms prepare=3100ms send=820ms store=5ms',
    );
  });

  it('stays silent at or below the threshold', () => {
    const c = clock();
    const log = vi.fn();
    const timer = new PhaseTimer('in user text msg=1', { slowMs: 1500, now: c.now, log });
    c.tick(1500);
    timer.finish();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs every message when the threshold is 0', () => {
    const c = clock();
    const log = vi.fn();
    const timer = new PhaseTimer('in user text msg=1', { slowMs: 0, now: c.now, log });
    c.tick(3);
    timer.finish();
    expect(log).toHaveBeenCalledWith('[timing] in user text msg=1 total=3ms store=3ms');
  });

  it('accumulates a phase hit twice and leaves out phases under 1 ms', () => {
    const c = clock();
    const log = vi.fn();
    const timer = new PhaseTimer('x', { slowMs: 0, now: c.now, log });
    c.tick(200);
    timer.lap('upload');
    c.tick(0.2);
    timer.lap('portal');
    c.tick(300);
    timer.lap('upload');
    timer.finish();
    expect(log).toHaveBeenCalledWith('[timing] x total=500ms upload=500ms');
  });

  it('prints once and ignores laps after finish', () => {
    const c = clock();
    const log = vi.fn();
    const timer = new PhaseTimer('x', { slowMs: 0, now: c.now, log });
    c.tick(10);
    timer.finish();
    c.tick(10);
    timer.lap('late');
    expect(timer.finish()).toBe(10);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('timeIntent', () => {
  it('charges upload and send calls to their phase, the time before them to prepare', async () => {
    const c = clock();
    const log = vi.fn();
    const timer = new PhaseTimer('in group photo msg=7', { slowMs: 0, now: c.now, log });
    const intent = {
      uploadContent: vi.fn(async (_buffer: Buffer) => {
        c.tick(400);
        return 'mxc://s/m';
      }),
      sendMessage: vi.fn(async () => {
        c.tick(90);
        return { event_id: '$e' };
      }),
      userId: '@ghost:example.org',
    };
    const timed = timeIntent(intent as unknown as Intent, timer);

    c.tick(2000); // download
    expect(await timed.uploadContent(Buffer.from('x'))).toBe('mxc://s/m');
    expect(await timed.sendMessage('!room:example.org', { msgtype: 'm.image' })).toEqual({ event_id: '$e' });
    expect(timed.userId).toBe('@ghost:example.org');
    timer.finish();

    expect(intent.sendMessage).toHaveBeenCalledWith('!room:example.org', { msgtype: 'm.image' });
    expect(log).toHaveBeenCalledWith(
      '[timing] in group photo msg=7 total=2490ms prepare=2000ms upload=400ms send=90ms',
    );
  });

  it('still charges the phase when the call throws, and rethrows', async () => {
    const c = clock();
    const log = vi.fn();
    const timer = new PhaseTimer('x', { slowMs: 0, now: c.now, log });
    const intent = {
      sendEvent: vi.fn(async () => {
        c.tick(700);
        throw new Error('M_FORBIDDEN');
      }),
    };
    const timed = timeIntent(intent as unknown as Intent, timer);
    await expect(timed.sendEvent('!r:x', 'm.room.message', {})).rejects.toThrow('M_FORBIDDEN');
    timer.finish();
    expect(log).toHaveBeenCalledWith('[timing] x total=700ms send=700ms');
  });
});
