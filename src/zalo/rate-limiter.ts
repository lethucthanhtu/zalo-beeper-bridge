// Token-bucket rate limiter for outbound Zalo sends.
// A burst of tokens lets normal back-and-forth chatting go through instantly;
// only sustained sending is paced (protects the main account without adding
// visible latency to real conversations). Refills at `perMinute` tokens/min.

/** Token bucket with serialized acquires; see the file header for the pacing rationale. */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;
  // Serialize acquires so concurrent callers can't all refill+consume against the
  // same snapshot and fire together (thundering herd defeating the pacing).
  private chain: Promise<void> = Promise.resolve();

  /**
   * Creates a full bucket.
   *
   * @param perMinute sustained rate (tokens refilled per minute)
   * @param burst bucket capacity; defaults to `perMinute` (at least 1)
   * @throws when perMinute is not positive or burst is below 1 (a bucket that can never
   *   hold a whole token would delay every call by a full refill instead of pacing)
   */
  constructor(perMinute: number, burst?: number) {
    if (perMinute <= 0) throw new Error('perMinute must be > 0');
    if (burst !== undefined && !(burst >= 1)) throw new Error('burst must be >= 1');
    this.capacity = burst ?? Math.max(perMinute, 1);
    this.refillPerMs = perMinute / 60_000;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  /** Adds the tokens accrued since the last refill, capped at capacity. */
  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
  }

  /**
   * Resolves immediately while burst tokens remain; otherwise waits for one to refill.
   * Calls are queued so they are granted one at a time in call order.
   */
  acquire(): Promise<void> {
    const result = this.chain.then(() => this.doAcquire());
    this.chain = result.catch(() => undefined); // keep the chain alive on rejection
    return result;
  }

  /** Takes one token, sleeping first until a whole token has refilled if the bucket is short. */
  private async doAcquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refill();
    }
    this.tokens = Math.max(0, this.tokens - 1);
  }
}
