import { afterEach, describe, expect, it, vi } from 'vitest';
import { asId, asRecord, isHttpUrl, isRecord, joinLines, parseParams, positiveNumber, sleep } from '../util.ts';

describe('sleep', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves only after the delay', async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = sleep(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });
});

describe('isRecord / asRecord', () => {
  it('isRecord accepts plain objects only', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [null, undefined, [], 'x', 1]) expect(isRecord(value)).toBe(false);
  });

  it('asRecord returns objects (arrays included) and null otherwise', () => {
    const array: unknown[] = [];
    expect(asRecord(array)).toBe(array);
    expect(asRecord(null)).toBeNull();
    expect(asRecord('{"a":1}')).toBeNull();
  });
});

describe('asId', () => {
  it('stringifies numbers and keeps non-empty strings', () => {
    expect(asId(42)).toBe('42');
    expect(asId('7')).toBe('7');
  });

  it('treats empty strings and other types as no id', () => {
    for (const value of ['', null, undefined, {}, true]) expect(asId(value)).toBeUndefined();
  });
});

describe('parseParams', () => {
  it('passes an already parsed object through', () => {
    const params = { width: 10 };
    expect(parseParams(params)).toBe(params);
  });

  it('parses a JSON string', () => {
    expect(parseParams('{"calltype":1}')).toEqual({ calltype: 1 });
  });

  it('returns null for absent, malformed and non-object params', () => {
    for (const value of [undefined, null, '', '{bad', '42', 'null', 5]) expect(parseParams(value)).toBeNull();
  });
});

describe('isHttpUrl', () => {
  it('accepts http and https only', () => {
    expect(isHttpUrl('https://photo.zdn.vn/a.jpg')).toBe(true);
    expect(isHttpUrl('http://x')).toBe(true);
    expect(isHttpUrl('www.zaloapp.com')).toBe(false);
    expect(isHttpUrl('ftp://x')).toBe(false);
  });
});

describe('positiveNumber', () => {
  it('reads numbers and numeric strings above zero', () => {
    expect(positiveNumber(5)).toBe(5);
    expect(positiveNumber('1200')).toBe(1200);
  });

  it('drops zero, negatives and non-numbers', () => {
    for (const value of [0, -1, '0', 'abc', undefined, null]) expect(positiveNumber(value)).toBeUndefined();
  });
});

describe('joinLines', () => {
  it('joins the non-blank parts with newlines', () => {
    expect(joinLines('a', undefined, '  ', 'b')).toBe('a\nb');
    expect(joinLines(undefined, '')).toBe('');
  });
});
