// Suppresses the selfListen echo of messages the bridge just sent to Zalo.
//
// When the owner types in Beeper → we send to Zalo → zca-js selfListen delivers
// that same message back with isSelf=true. Without suppression it would be
// re-posted into the portal as a duplicate. msgId from the send response can lag
// the echo, so we match on (threadId, content) within a short TTL window.
const TTL_MS = 15_000;

/** One armed text echo: the exact text we sent and when the guard lapses. */
type PendingEcho = {
  text: string;
  expiresAt: number;
};

/**
 * In-memory, per-thread registry of messages the bridge just sent to Zalo, so the
 * selfListen copy of each send is swallowed exactly once instead of re-posted.
 * Text sends are matched by exact text; image sends by a per-thread time window.
 * Every entry expires after TTL_MS so a stale guard cannot hide a real message.
 */
export class EchoSuppressor {
  private readonly pending = new Map<string, PendingEcho[]>();
  // Outbound images have neither a pre-send msgId nor a known CDN url, so guard by
  // a per-thread "image just sent" window: threadId → array of send expiries
  private readonly pendingImages = new Map<string, number[]>();

  /**
   * Arm BEFORE sending an image (we don't yet know its msgId or CDN url).
   * Adds one expiry marker for the thread and prunes already-expired ones.
   */
  expectImage(threadId: string): void {
    const expiries = (this.pendingImages.get(threadId) ?? []).filter((expiresAt) => expiresAt > Date.now());
    expiries.push(Date.now() + TTL_MS);
    this.pendingImages.set(threadId, expiries);
  }

  /**
   * Removes the most recently armed image marker — call when an image send FAILED, so a
   * real photo sent from the phone within the TTL isn't wrongly swallowed as our echo.
   */
  cancelImage(threadId: string): void {
    const expiries = this.pendingImages.get(threadId);
    if (!expiries) return;
    expiries.pop();
    if (!expiries.length) this.pendingImages.delete(threadId);
  }

  /**
   * True (consuming the first live marker) when a self photo in this thread is our own echo.
   * Deletes the thread's entry when no live marker is found or none is left after consuming.
   */
  consumeImage(threadId: string): boolean {
    const expiries = this.pendingImages.get(threadId);
    if (!expiries) return false;
    const now = Date.now();
    const liveIndex = expiries.findIndex((expiresAt) => expiresAt > now);
    if (liveIndex === -1) {
      this.pendingImages.delete(threadId);
      return false;
    }
    expiries.splice(liveIndex, 1);
    if (expiries.length) this.pendingImages.set(threadId, expiries);
    else this.pendingImages.delete(threadId);
    return true;
  }

  /**
   * Call right before sending to Zalo: arms one guard for `text` in this thread.
   * Identical sends arm one guard each, so each of their echoes is swallowed once.
   */
  expect(threadId: string, text: string): void {
    const echoes = this.pending.get(threadId) ?? [];
    echoes.push({ text, expiresAt: Date.now() + TTL_MS });
    this.pending.set(threadId, echoes);
  }

  /**
   * Removes one pending entry — call when a send FAILED so a real phone-typed
   * message with identical text isn't wrongly swallowed.
   */
  cancel(threadId: string, text: string): void {
    const echoes = this.pending.get(threadId);
    if (!echoes) return;
    const matchIndex = echoes.findIndex((echo) => echo.text === text);
    if (matchIndex !== -1) echoes.splice(matchIndex, 1);
    if (!echoes.length) this.pending.delete(threadId);
  }

  /**
   * Returns true (and consumes the entry) when this self-message is our own echo.
   * Also prunes the thread's expired entries as a side effect.
   */
  consume(threadId: string, text: string): boolean {
    const echoes = this.pending.get(threadId);
    if (!echoes) return false;
    const now = Date.now();
    const matchIndex = echoes.findIndex((echo) => echo.text === text && echo.expiresAt > now);
    // Drop expired entries opportunistically
    const fresh = echoes.filter((echo) => echo.expiresAt > now && echo !== echoes[matchIndex]);
    if (fresh.length) this.pending.set(threadId, fresh);
    else this.pending.delete(threadId);
    return matchIndex !== -1;
  }
}
