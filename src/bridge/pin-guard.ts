// Zalo reports one pin twice: as a pin event and as a system bubble ("X pinned a message").
// The bridge turns the event into room state, so the bubble must not also show up as a
// notice. The guard pairs them per thread and actor, whichever arrives first.

/** One pin event a bubble may still claim. */
type Claim = { expiresAt: number };

/** Pairs pin events with the system bubble Zalo sends for the same pin. */
export class PinBubbleGuard {
  private readonly claims = new Map<string, Claim[]>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly ttlMs: number;

  /** @param ttlMs how long a pin event waits for its bubble before it is forgotten */
  constructor(ttlMs = 15_000) {
    this.ttlMs = ttlMs;
  }

  private static key(threadId: string, actorId: string | undefined): string {
    return `${threadId}\n${actorId ?? ''}`;
  }

  /** Records that a pin event of this actor arrived; wakes a bubble already waiting for it. */
  note(threadId: string, actorId: string | undefined): void {
    const key = PinBubbleGuard.key(threadId, actorId);
    const list = this.claims.get(key) ?? [];
    list.push({ expiresAt: Date.now() + this.ttlMs });
    this.claims.set(key, list);
    this.waiters.get(key)?.shift()?.();
  }

  /** @returns true (and consumes the claim) when a pin event of this actor is waiting for its bubble */
  take(threadId: string, actorId: string | undefined): boolean {
    const key = PinBubbleGuard.key(threadId, actorId);
    const live = (this.claims.get(key) ?? []).filter((claim) => claim.expiresAt > Date.now());
    const taken = live.shift() !== undefined;
    if (live.length > 0) this.claims.set(key, live);
    else this.claims.delete(key);
    return taken;
  }

  /**
   * Like `take`, but when no pin event is here yet waits up to `holdMs` for one (the
   * bubble can overtake the event).
   */
  async takeWithin(threadId: string, actorId: string | undefined, holdMs: number): Promise<boolean> {
    if (this.take(threadId, actorId)) return true;
    if (holdMs <= 0) return false;
    const key = PinBubbleGuard.key(threadId, actorId);
    return new Promise<boolean>((resolve) => {
      /** Stops waiting: a woken waiter takes its claim, a timed-out one gives up. */
      const wake = () => {
        clearTimeout(timer);
        resolve(this.take(threadId, actorId));
      };
      const timer = setTimeout(() => {
        const list = this.waiters.get(key) ?? [];
        const index = list.indexOf(wake);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0) this.waiters.delete(key);
        resolve(false);
      }, holdMs);
      this.waiters.set(key, [...(this.waiters.get(key) ?? []), wake]);
    });
  }
}
