import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EchoSuppressor } from '../echo-suppressor.ts';

describe('EchoSuppressor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('consumes a matching echo exactly once', () => {
    const echo = new EchoSuppressor();
    echo.expect('t1', 'hello');
    expect(echo.consume('t1', 'hello')).toBe(true);
    expect(echo.consume('t1', 'hello')).toBe(false); // already consumed
  });

  it('does not suppress a different message on the same thread', () => {
    const echo = new EchoSuppressor();
    echo.expect('t1', 'hello');
    expect(echo.consume('t1', 'world')).toBe(false);
    expect(echo.consume('t1', 'hello')).toBe(true); // untouched by the miss
  });

  it('scopes suppression per thread', () => {
    const echo = new EchoSuppressor();
    echo.expect('t1', 'hi');
    expect(echo.consume('t2', 'hi')).toBe(false);
  });

  it('expires entries after the TTL window', () => {
    const echo = new EchoSuppressor();
    echo.expect('t1', 'hello');
    vi.advanceTimersByTime(15_001);
    expect(echo.consume('t1', 'hello')).toBe(false);
  });

  it('handles duplicate identical sends (two echoes expected)', () => {
    const echo = new EchoSuppressor();
    echo.expect('t1', 'ok');
    echo.expect('t1', 'ok');
    expect(echo.consume('t1', 'ok')).toBe(true);
    expect(echo.consume('t1', 'ok')).toBe(true);
    expect(echo.consume('t1', 'ok')).toBe(false);
  });

  it('disarms a failed media send so a real phone photo is not swallowed', () => {
    const echo = new EchoSuppressor();
    echo.expectImage('t1');
    echo.cancelImage('t1'); // the send failed
    expect(echo.consumeImage('t1')).toBe(false);
    echo.expectImage('t1');
    echo.expectImage('t1');
    echo.cancelImage('t1'); // one of two sends failed
    expect(echo.consumeImage('t1')).toBe(true);
    expect(echo.consumeImage('t1')).toBe(false);
  });

  it('swallows the self poll echo of a poll created from Beeper exactly once, per thread', () => {
    const echo = new EchoSuppressor();
    echo.expectPoll('g1');
    expect(echo.consumePoll('g2')).toBe(false);
    expect(echo.consumePoll('g1')).toBe(true);
    expect(echo.consumePoll('g1')).toBe(false);
  });

  it('disarms a failed poll creation and keeps poll guards apart from text guards', () => {
    const echo = new EchoSuppressor();
    echo.expectPoll('g1');
    echo.cancelPoll('g1');
    expect(echo.consumePoll('g1')).toBe(false);
    echo.expectPoll('g1');
    expect(echo.consume('g1', ' poll-create')).toBe(false);
    expect(echo.consumePoll('g1')).toBe(true);
  });

  it('never lets message text consume an internal guard', () => {
    const echo = new EchoSuppressor();
    echo.expectPoll('g1');
    echo.expectReactionRemoval('g1', 'm1');
    for (const text of ['poll-create', 'reaction-removal:m1', ' poll-create', '\\0poll-create']) {
      expect(echo.consume('g1', text)).toBe(false);
    }
    expect(echo.consumePoll('g1')).toBe(true);
    expect(echo.consumeReactionRemoval('g1', 'm1')).toBe(true);
  });
});
