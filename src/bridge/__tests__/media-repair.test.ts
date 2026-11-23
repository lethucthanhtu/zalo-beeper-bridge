import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaRepairQueue } from '../media-repair.ts';
import type { RepairOutcome } from '../inbound-handler.ts';
import type { ZaloMessage } from '../../zalo/types.ts';

const msg = (msgId: string, url = 'https://old'): ZaloMessage => ({
  msgId,
  threadId: 't1',
  threadType: 'group',
  senderId: 'u1',
  timestamp: 1,
  isSelf: false,
  content: { kind: 'media', media: { kind: 'file', urls: [url] } },
});

/** Queue with manual timers: `fire()` runs every armed timer, then lets the chain settle. */
function setup(outcomes: RepairOutcome[], opts: { maxQueued?: number } = {}) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const repair = vi.fn(async (_m: ZaloMessage) => outcomes.shift() ?? { status: 'failed' as const, error: 'x' });
  const refetch = vi.fn(async (ref: { msgId: string }): Promise<ZaloMessage | null> => msg(ref.msgId, 'https://fresh'));
  const queue = new MediaRepairQueue({
    repair,
    refetch,
    delaysMs: [10, 20, 30],
    maxQueued: opts.maxQueued,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
  });
  const fire = async () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { queue, repair, refetch, timers, fire };
}

afterEach(() => vi.restoreAllMocks());

describe('MediaRepairQueue', () => {
  it('first retries the links it has, then re-fetches the message, then gives up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup([]);
    t.queue.schedule(msg('m1'));
    expect(t.timers.map((x) => x.ms)).toEqual([10]);

    await t.fire();
    expect(t.repair).toHaveBeenLastCalledWith(expect.objectContaining({ msgId: 'm1' }));
    expect(t.refetch).not.toHaveBeenCalled();
    expect(t.timers.map((x) => x.ms)).toEqual([20]);

    await t.fire();
    expect(t.refetch).toHaveBeenCalledWith({ msgId: 'm1', threadId: 't1', threadType: 'group' });
    expect(t.repair).toHaveBeenCalledTimes(2);
    expect(t.timers.map((x) => x.ms)).toEqual([30]);

    await t.fire();
    expect(t.repair).toHaveBeenCalledTimes(3);
    expect(t.timers).toEqual([]);
    expect(t.queue.size()).toBe(0);
  });

  it('stops once the media is repaired or no longer needs repair', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = setup([{ status: 'repaired' }, { status: 'closed' }]);
    t.queue.schedule(msg('m1'));
    t.queue.schedule(msg('m2'));
    t.queue.schedule(msg('m1')); // already waiting
    expect(t.queue.size()).toBe(2);
    await t.fire();
    expect(t.repair).toHaveBeenCalledTimes(2);
    expect(t.timers).toEqual([]);
    expect(t.queue.size()).toBe(0);
  });

  it('re-fetches straight away for failures picked up from the database', async () => {
    const t = setup([{ status: 'repaired' }]);
    t.queue.scheduleRefetch({ msgId: 'm1', threadId: 't1', threadType: 'group' });
    expect(t.timers.map((x) => x.ms)).toEqual([20]);
    await t.fire();
    expect(t.refetch).toHaveBeenCalledTimes(1);
    expect(t.repair).toHaveBeenCalledWith(expect.objectContaining({ msgId: 'm1' }));
  });

  it('counts a message that is out of reach or a throwing repair as a failed attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup([]);
    t.refetch.mockResolvedValueOnce(null);
    t.queue.scheduleRefetch({ msgId: 'm1', threadId: 't1', threadType: 'group' });
    await t.fire();
    expect(t.repair).not.toHaveBeenCalled();
    expect(t.queue.size()).toBe(1);

    t.repair.mockRejectedValueOnce(new Error('boom'));
    await t.fire();
    expect(t.queue.size()).toBe(0);
  });

  it('caps the queue and cancels everything on stop', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup([], { maxQueued: 1 });
    t.queue.schedule(msg('m1'));
    t.queue.schedule(msg('m2'));
    expect(t.queue.size()).toBe(1);
    t.queue.stop();
    expect(t.queue.size()).toBe(0);
    expect(t.timers.every((x) => x.cleared)).toBe(true);
    t.queue.schedule(msg('m3'));
    expect(t.queue.size()).toBe(0);
  });
});
