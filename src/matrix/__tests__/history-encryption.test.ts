import { describe, expect, it, vi } from 'vitest';
import { encryptHistoryBatch, type BatchEvent, type HistoryCryptoEngine } from '../history-encryption.ts';

const ROOM = '!room:beeper.local';

const event = (n: number, extra: Record<string, unknown> = {}): BatchEvent => ({
  type: 'm.room.message',
  sender: `@sh-zalo_${n}:beeper.local`,
  origin_server_ts: 1_700_000_000_000 + n,
  content: { msgtype: 'm.text', body: `message ${n}`, ...extra },
});

/** Fake engine: records the call order; `expireAt` makes that encrypt call fail once with "Session expired". */
function fakeEngine(expireAt?: number) {
  const calls: string[] = [];
  let encrypts = 0;
  let expired = false;
  const engine: HistoryCryptoEngine = {
    shareRoomKey: vi.fn(async () => {
      calls.push('share');
    }),
    encrypt: vi.fn(async (_roomId, type, content) => {
      encrypts++;
      if (encrypts === expireAt && !expired) {
        expired = true;
        throw new Error('Session expired');
      }
      calls.push(`encrypt:${String(content.body)}`);
      return { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: `ct(${type}:${String(content.body)})` };
    }),
    flush: vi.fn(async () => {
      calls.push('flush');
    }),
  };
  return { engine, calls };
}

describe('encryptHistoryBatch', () => {
  it('shares the key once, encrypts in order and flushes at the end', async () => {
    const { engine, calls } = fakeEngine();
    const out = await encryptHistoryBatch(engine, ROOM, [event(1), event(2)]);
    expect(calls).toEqual(['share', 'encrypt:message 1', 'encrypt:message 2', 'flush']);
    expect(out).toEqual([
      {
        type: 'm.room.encrypted',
        sender: '@sh-zalo_1:beeper.local',
        origin_server_ts: 1_700_000_000_001,
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'ct(m.room.message:message 1)' },
      },
      {
        type: 'm.room.encrypted',
        sender: '@sh-zalo_2:beeper.local',
        origin_server_ts: 1_700_000_000_002,
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'ct(m.room.message:message 2)' },
      },
    ]);
  });

  it('keeps m.relates_to in the clear and does not touch the input', async () => {
    const { engine } = fakeEngine();
    const relatesTo = { 'm.in_reply_to': { event_id: '$parent' } };
    const input = event(3, { 'm.relates_to': relatesTo });
    const before = structuredClone(input);
    const [out] = await encryptHistoryBatch(engine, ROOM, [input]);
    expect(out!.content['m.relates_to']).toEqual(relatesTo);
    expect(input).toEqual(before);
  });

  it('keeps the double-puppet marker in the clear so the server does not await a bridge ack', async () => {
    const { engine } = fakeEngine();
    const [out] = await encryptHistoryBatch(engine, ROOM, [event(4, { 'fi.mau.double_puppet_source': 'zalo' })]);
    expect(out!.content['fi.mau.double_puppet_source']).toBe('zalo');
  });

  it('shares a new key and retries when the session expires mid-batch', async () => {
    const { engine, calls } = fakeEngine(2);
    const out = await encryptHistoryBatch(engine, ROOM, [event(1), event(2), event(3)]);
    expect(calls).toEqual(['share', 'encrypt:message 1', 'share', 'encrypt:message 2', 'encrypt:message 3', 'flush']);
    expect(out).toHaveLength(3);
  });

  it('rethrows other encryption errors without flushing', async () => {
    const { engine } = fakeEngine();
    vi.mocked(engine.encrypt).mockRejectedValueOnce(new Error('no session for room'));
    await expect(encryptHistoryBatch(engine, ROOM, [event(1)])).rejects.toThrow('no session for room');
    expect(engine.flush).not.toHaveBeenCalled();
  });

  it('does nothing for an empty batch', async () => {
    const { engine, calls } = fakeEngine();
    expect(await encryptHistoryBatch(engine, ROOM, [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
