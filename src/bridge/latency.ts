// Latency instrumentation for the inbound path (Zalo → Matrix): where does a slow message
// spend its time? One `[timing]` line per message, and only when it was slow.
import type { Intent } from 'matrix-appservice-bridge';

/** Default for the slow-message threshold (ms); override with the BRIDGE_SLOW_MS env var. */
export const DEFAULT_SLOW_MS = 1500;

/**
 * The slow-message threshold in ms: BRIDGE_SLOW_MS when it is a number >= 0 (0 logs every
 * message), else {@link DEFAULT_SLOW_MS}. Read when a timer is created.
 */
export function slowThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BRIDGE_SLOW_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SLOW_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SLOW_MS;
}

/** Injectable pieces, for tests. */
export type PhaseTimerOptions = {
  /** log a line only when the total exceeds this many ms (default: {@link slowThresholdMs}) */
  slowMs?: number;
  /** monotonic clock in ms (default: performance.now) */
  now?: () => number;
  /** line sink (default: console.log) */
  log?: (line: string) => void;
};

/**
 * Stopwatch for one inbound message. Starts when created; each `lap(phase)` charges the time
 * since the previous lap (or the start) to `phase`, so phases never overlap and add up to the
 * total. A phase hit twice (e.g. two uploads) accumulates. `finish()` prints the single
 * summary line when the total is over the threshold.
 *
 * Phases the inbound handler uses, in order: `queue` (waiting behind the thread's earlier
 * messages), `portal`, `ghost` (sender puppet + room membership + encryption lookup),
 * `prepare` (download, thumbnail, content building: everything before an upload or send),
 * `upload` (Matrix media upload), `send` (the Matrix send call, encryption included), `store`.
 *
 * The label must hold ids only, never message content or names.
 */
export class PhaseTimer {
  private readonly label: string;
  private readonly slowMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly start: number;
  private last: number;
  private readonly phases = new Map<string, number>();
  private done = false;

  /** @param label Ids-only description, printed after `[timing]` (e.g. `in group photo msg=1`). */
  constructor(label: string, options: PhaseTimerOptions = {}) {
    this.label = label;
    this.slowMs = options.slowMs ?? slowThresholdMs();
    this.now = options.now ?? (() => performance.now());
    this.log = options.log ?? ((line) => console.log(line));
    this.start = this.now();
    this.last = this.start;
  }

  /** Charges the time since the previous lap (or the start) to `phase`. No-op after `finish`. */
  lap(phase: string): void {
    if (this.done) return;
    const at = this.now();
    this.phases.set(phase, (this.phases.get(phase) ?? 0) + (at - this.last));
    this.last = at;
  }

  /**
   * Charges the remaining time to `phase` (default `store`) and, when the total is over the
   * threshold, prints `[timing] <label> total=…ms <phase>=…ms …` (phases in first-seen order,
   * those under 1 ms left out). Idempotent.
   * @returns the total in ms
   */
  finish(phase = 'store'): number {
    if (this.done) return this.last - this.start;
    this.lap(phase);
    this.done = true;
    const total = this.last - this.start;
    if (total > this.slowMs) {
      const parts = [...this.phases]
        .filter(([, ms]) => Math.round(ms) > 0)
        .map(([name, ms]) => `${name}=${Math.round(ms)}ms`);
      this.log(`[timing] ${this.label} total=${Math.round(total)}ms${parts.length ? ` ${parts.join(' ')}` : ''}`);
    }
    return total;
  }
}

/**
 * The intent with its Matrix calls timed: time before an upload or send goes to `prepare`, the
 * call itself to `upload` (uploadContent) or `send` (sendEvent / sendMessage).
 * Everything else passes through untouched.
 */
export function timeIntent(intent: Intent, timer: PhaseTimer): Intent {
  const phaseOf = new Map([
    ['uploadContent', 'upload'],
    ['sendEvent', 'send'],
    ['sendMessage', 'send'],
  ]);
  return new Proxy(intent, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      const phase = typeof prop === 'string' ? phaseOf.get(prop) : undefined;
      if (!phase || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        timer.lap('prepare');
        try {
          return await (value as (...a: unknown[]) => unknown).apply(target, args);
        } finally {
          timer.lap(phase);
        }
      };
    },
  });
}
