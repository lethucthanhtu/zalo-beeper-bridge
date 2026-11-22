import type { ZaloMessage, ZaloThreadType } from '../zalo/types.ts';
import type { RepairOutcome } from './inbound-handler.ts';

/** Where a failed message lives on Zalo: enough to fetch it again. */
export type MediaRepairRef = {
  msgId: string;
  threadId: string;
  threadType: ZaloThreadType;
};

export type MediaRepairDeps = {
  /** Re-sends the media of a message whose failure notice is still open. */
  repair(msg: ZaloMessage): Promise<RepairOutcome>;
  /** Fetches the message again from Zalo for fresh media links; null when out of reach. */
  refetch(ref: MediaRepairRef): Promise<ZaloMessage | null>;
  /** Wait before each attempt. Attempt 1 reuses the links it already has, later ones re-fetch. */
  delaysMs?: number[];
  /** Most messages waiting at once; new failures past it are left for `media-failures`. */
  maxQueued?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export const DEFAULT_REPAIR_DELAYS_MS = [2 * 60_000, 15 * 60_000, 60 * 60_000];

type Pending = {
  ref: MediaRepairRef;
  /** The message as first received; only used by the first attempt. */
  msg: ZaloMessage | null;
  /** Index into the delays of the attempt that is waiting. */
  attempt: number;
  timer: unknown;
};

/**
 * Retries media that failed to bridge: Zalo's CDN often fails for a few minutes, and a
 * signed link that expired can be replaced by fetching the message again. Attempts run one
 * at a time, so a burst of failures does not hammer Zalo.
 */
export class MediaRepairQueue {
  private readonly deps: MediaRepairDeps;
  private readonly delays: number[];
  private readonly maxQueued: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly pending = new Map<string, Pending>();
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(deps: MediaRepairDeps) {
    this.deps = deps;
    this.delays = deps.delaysMs ?? DEFAULT_REPAIR_DELAYS_MS;
    this.maxQueued = deps.maxQueued ?? 200;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Queues a message whose media just failed; the first attempt reuses its links. */
  schedule(msg: ZaloMessage): void {
    this.add({ msgId: msg.msgId, threadId: msg.threadId, threadType: msg.threadType }, msg, 0);
  }

  /** Queues a failure found in the database (after a restart): every attempt re-fetches. */
  scheduleRefetch(ref: MediaRepairRef): void {
    this.add(ref, null, Math.min(1, this.delays.length - 1));
  }

  /** Messages waiting for an attempt. */
  size(): number {
    return this.pending.size;
  }

  /** Cancels every waiting attempt. */
  stop(): void {
    this.stopped = true;
    for (const p of this.pending.values()) this.clearTimer(p.timer);
    this.pending.clear();
  }

  private add(ref: MediaRepairRef, msg: ZaloMessage | null, attempt: number): void {
    if (this.stopped || this.pending.has(ref.msgId) || this.delays.length === 0) return;
    if (this.pending.size >= this.maxQueued) {
      console.warn(`[media] repair queue full, ${ref.msgId} is left for media-failures`);
      return;
    }
    const entry: Pending = { ref, msg, attempt, timer: null };
    this.pending.set(ref.msgId, entry);
    this.arm(entry);
  }

  private arm(entry: Pending): void {
    entry.timer = this.setTimer(() => {
      this.chain = this.chain.then(() => this.run(entry));
    }, this.delays[entry.attempt]!);
  }

  private async run(entry: Pending): Promise<void> {
    if (this.stopped || this.pending.get(entry.ref.msgId) !== entry) return;
    const { ref } = entry;
    const label = `${ref.msgId} (attempt ${entry.attempt + 1}/${this.delays.length})`;
    let outcome: RepairOutcome;
    try {
      const msg = entry.attempt === 0 && entry.msg ? entry.msg : await this.deps.refetch(ref);
      outcome = msg ? await this.deps.repair(msg) : { status: 'failed', error: 'message is out of reach on Zalo' };
    } catch (err) {
      outcome = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.status !== 'failed') {
      this.pending.delete(ref.msgId);
      if (outcome.status === 'closed') console.log(`[media] repair of ${ref.msgId} no longer needed`);
      return;
    }
    entry.msg = null;
    entry.attempt += 1;
    if (entry.attempt >= this.delays.length) {
      this.pending.delete(ref.msgId);
      console.warn(`[media] repair of ${label} failed, giving up: ${outcome.error}`);
      return;
    }
    console.warn(`[media] repair of ${label} failed, retrying later: ${outcome.error}`);
    this.arm(entry);
  }
}
