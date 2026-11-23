import { describe, expect, it, vi } from 'vitest';
import { CALM_BACKOFF_MS, calmRetryRequestFn, isEnhanceYourCalm, withCalmRetry } from '../calm-retry.ts';

const calm = (): Error =>
  Object.assign(new Error('Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM'), {
    code: 'ERR_HTTP2_STREAM_ERROR',
    http2ErrorCode: 11,
  });

/** A wait that records the pauses instead of sleeping. */
const recorder = (): { waits: number[]; wait: (ms: number) => Promise<void> } => {
  const waits: number[] = [];
  return { waits, wait: (ms) => (waits.push(ms), Promise.resolve()) };
};

describe('isEnhanceYourCalm', () => {
  it('matches an HTTP/2 stream reset with error code 11', () => {
    expect(isEnhanceYourCalm(calm())).toBe(true);
    expect(isEnhanceYourCalm({ code: 'ERR_HTTP2_STREAM_ERROR', http2ErrorCode: 11 })).toBe(true);
  });

  it('matches the message when the code is missing', () => {
    expect(isEnhanceYourCalm(new Error('NGHTTP2_ENHANCE_YOUR_CALM'))).toBe(true);
  });

  it('does not match other errors', () => {
    expect(isEnhanceYourCalm({ code: 'ERR_HTTP2_STREAM_ERROR', http2ErrorCode: 2 })).toBe(false);
    expect(isEnhanceYourCalm(new Error('socket hang up'))).toBe(false);
    expect(isEnhanceYourCalm({ errcode: 'M_LIMIT_EXCEEDED' })).toBe(false);
    expect(isEnhanceYourCalm(null)).toBe(false);
    expect(isEnhanceYourCalm('ENHANCE_YOUR_CALM')).toBe(false);
  });
});

describe('withCalmRetry', () => {
  it('backs off 30 s, 1, 2 and 4 minutes', () => {
    expect(CALM_BACKOFF_MS).toEqual([30_000, 60_000, 120_000, 240_000]);
  });

  it('returns the first success without waiting', async () => {
    const { waits, wait } = recorder();
    await expect(withCalmRetry(() => Promise.resolve('ok'), { wait })).resolves.toBe('ok');
    expect(waits).toEqual([]);
  });

  it('retries the same call after each pause until it succeeds', async () => {
    const { waits, wait } = recorder();
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(calm()).mockRejectedValueOnce(calm()).mockResolvedValue('ok');
    await expect(withCalmRetry(fn, { wait, onRetry })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([30_000, 60_000]);
    expect(onRetry.mock.calls).toEqual([
      [1, 30_000],
      [2, 60_000],
    ]);
  });

  it('throws the last ENHANCE_YOUR_CALM once every pause is used', async () => {
    const { waits, wait } = recorder();
    const fn = vi.fn().mockRejectedValue(calm());
    await expect(withCalmRetry(fn, { wait })).rejects.toThrow('ENHANCE_YOUR_CALM');
    expect(fn).toHaveBeenCalledTimes(5);
    expect(waits).toEqual([...CALM_BACKOFF_MS]);
  });

  it('throws any other error at once', async () => {
    const { waits, wait } = recorder();
    const fn = vi.fn().mockRejectedValue(new Error('M_FORBIDDEN'));
    await expect(withCalmRetry(fn, { wait })).rejects.toThrow('M_FORBIDDEN');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
});

describe('calmRetryRequestFn', () => {
  const response = (text: string, statusCode = 200) => ({
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: { bytes: () => Promise.resolve(new TextEncoder().encode(text)) },
  });

  it('sends the same request again after a reset and returns the buffered body', async () => {
    const { waits, wait } = recorder();
    const inner = vi.fn().mockRejectedValueOnce(calm()).mockResolvedValue(response('{"event_id":"$e"}'));
    const request = calmRetryRequestFn(inner, { wait });
    const options = { method: 'PUT', body: '{"a":1}' };
    const result = (await request('https://hs/x', options)) as ReturnType<typeof response>;
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[1]).toEqual(['https://hs/x', options]);
    expect(waits).toEqual([30_000]);
    expect(result.statusCode).toBe(200);
    expect(new TextDecoder().decode(await result.body.bytes())).toBe('{"event_id":"$e"}');
  });

  it('retries when the stream is reset while the body is read', async () => {
    const { wait } = recorder();
    const broken = { ...response(''), body: { bytes: () => Promise.reject(calm()) } };
    const inner = vi.fn().mockResolvedValueOnce(broken).mockResolvedValue(response('{}'));
    const result = (await calmRetryRequestFn(inner, { wait })('https://hs/y', {})) as ReturnType<typeof response>;
    expect(inner).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(await result.body.bytes())).toBe('{}');
  });

  it('passes error responses through for the bot-sdk to handle', async () => {
    const { waits, wait } = recorder();
    const inner = vi.fn().mockResolvedValue(response('{"errcode":"M_LIMIT_EXCEEDED"}', 429));
    const result = (await calmRetryRequestFn(inner, { wait })('https://hs/z', {})) as ReturnType<typeof response>;
    expect(result.statusCode).toBe(429);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
});
