// Retry with backoff when Beeper's homeserver resets an HTTP/2 stream with ENHANCE_YOUR_CALM.
//
// A long history import sends thousands of requests (batch sends, key shares, media uploads).
// Beeper answers a burst by resetting streams with HTTP/2 error 11 (ENHANCE_YOUR_CALM), which
// undici surfaces as ERR_HTTP2_STREAM_ERROR. That is a "slow down", not a real failure, so the
// request is sent again after a pause instead of failing the whole chat.

import { getRequestFn, setRequestFn } from '@vector-im/matrix-bot-sdk';
import { sleep } from '../util.ts';

/** HTTP/2 error code 11, "enhance your calm". */
const ENHANCE_YOUR_CALM = 11;

/** Pauses before each retry: 30 s, 1, 2 and 4 minutes, then the error is thrown. */
export const CALM_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000];

/** True when `err` is an HTTP/2 stream reset with ENHANCE_YOUR_CALM. */
export function isEnhanceYourCalm(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, http2ErrorCode, message } = err as { code?: unknown; http2ErrorCode?: unknown; message?: unknown };
  if (code === 'ERR_HTTP2_STREAM_ERROR' && http2ErrorCode === ENHANCE_YOUR_CALM) return true;
  return typeof message === 'string' && message.includes('ENHANCE_YOUR_CALM');
}

export type CalmRetryOptions = {
  /** Pauses between attempts; one retry per entry. Defaults to {@link CALM_BACKOFF_MS}. */
  delaysMs?: readonly number[];
  /** Called before each pause, with the 1-based retry number and the pause in ms. */
  onRetry?: (retry: number, delayMs: number) => void;
  /** Waits `ms`; injectable for tests. */
  wait?: (ms: number) => Promise<void>;
};

/**
 * Runs `fn`, and runs it again after each pause in `delaysMs` while it fails with
 * ENHANCE_YOUR_CALM. Any other error, or the last ENHANCE_YOUR_CALM, is thrown as is.
 */
export async function withCalmRetry<T>(fn: () => Promise<T>, options: CalmRetryOptions = {}): Promise<T> {
  const { delaysMs = CALM_BACKOFF_MS, onRetry, wait = sleep } = options;
  for (let retry = 0; ; retry++) {
    try {
      return await fn();
    } catch (err) {
      const delayMs = delaysMs[retry];
      if (delayMs === undefined || !isEnhanceYourCalm(err)) throw err;
      onRetry?.(retry + 1, delayMs);
      await wait(delayMs);
    }
  }
}

/** The part of an undici response the bot-sdk reads. */
type RequestResponse = { body: { bytes(): Promise<Uint8Array> } };
type RequestFn = (url: unknown, options: unknown) => Promise<RequestResponse>;

/**
 * Wraps a bot-sdk request function so each request is retried on ENHANCE_YOUR_CALM. The body
 * is read inside the retry, because the stream can also be reset after the headers arrived;
 * the response handed back carries the buffered body. Request bodies are strings or Buffers,
 * so sending them again is safe.
 */
export function calmRetryRequestFn(inner: RequestFn, options: CalmRetryOptions = {}): RequestFn {
  return (url, requestOptions) =>
    withCalmRetry(async () => {
      const response = await inner(url, requestOptions);
      const bytes = await response.body.bytes();
      return { ...response, body: { bytes: () => Promise.resolve(bytes) } };
    }, options);
}

let installed = false;

/**
 * Makes every Matrix request of this process (bot-sdk clients, intents and the crypto engine
 * all go through the bot-sdk request function) retry on ENHANCE_YOUR_CALM. Installs once.
 */
export function installCalmRetry(onRetry?: CalmRetryOptions['onRetry']): void {
  if (installed) return;
  installed = true;
  setRequestFn(calmRetryRequestFn(getRequestFn() as RequestFn, { onRetry }));
}
