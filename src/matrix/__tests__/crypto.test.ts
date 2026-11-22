import { describe, expect, it, vi } from 'vitest';
import {
  createCryptoAppService,
  createRoomEncryption,
  createSyncFeeder,
  decryptAttachment,
  encryptAttachment,
  extractCryptoSyncData,
  installEncryptedSend,
  prepareIncomingEvent,
  type RoomEncryption,
  type RoomCryptoEngine,
} from '../crypto.ts';

const BOT = '@zalobot:beeper.local';
const DEVICE = 'BOTDEVICE';

// Shape of a hungryserv transaction seen in the E2EE spike (stable key names, fake values)
const hungryservTx = () => ({
  events: [
    { type: 'm.room.encrypted', room_id: '!r:x', sender: '@owner:beeper.com', content: {} },
    { type: 'm.room.message', room_id: '!r:x', sender: '@owner:beeper.com', content: {} },
  ],
  to_device: [
    {
      type: 'm.room.encrypted',
      sender: '@owner:beeper.com',
      content: { algorithm: 'm.olm.v1.curve25519-aes-sha2' },
      to_user_id: BOT,
      to_device_id: DEVICE,
    },
    { type: 'm.room.encrypted', sender: '@owner:beeper.com', content: {}, to_user_id: BOT, to_device_id: 'OTHER' },
    {
      type: 'm.room.encrypted',
      sender: '@owner:beeper.com',
      content: {},
      to_user_id: '@zalo_1:x',
      to_device_id: DEVICE,
    },
  ],
  device_one_time_keys_count: { [BOT]: { [DEVICE]: { signed_curve25519: 50 } } },
  device_unused_fallback_key_types: { [BOT]: { [DEVICE]: ['signed_curve25519'] } },
  device_lists: { changed: ['@owner:beeper.com'], left: [] },
});

describe('extractCryptoSyncData', () => {
  it('reads the stable key names hungryserv sends and keeps only messages for the bot device', () => {
    const data = extractCryptoSyncData(hungryservTx(), BOT, DEVICE);
    expect(data).not.toBeNull();
    expect(data!.toDevice).toHaveLength(1);
    expect(data!.toDevice[0]!.to_device_id).toBe(DEVICE);
    expect(data!.otkCounts).toEqual({ signed_curve25519: 50 });
    expect(data!.unusedFallbackKeyTypes).toEqual(['signed_curve25519']);
    expect(data!.changed).toEqual(['@owner:beeper.com']);
    expect(data!.left).toEqual([]);
    expect(data!.encryptedEvents).toBe(1);
  });

  it('also accepts the MSC2409/MSC3202 prefixed names', () => {
    const tx = hungryservTx();
    const data = extractCryptoSyncData(
      {
        'de.sorunome.msc2409.to_device': tx.to_device,
        'org.matrix.msc3202.device_one_time_keys_count': tx.device_one_time_keys_count,
        'org.matrix.msc3202.device_lists': { changed: [], left: ['@gone:x'] },
      },
      BOT,
      DEVICE,
    );
    expect(data!.toDevice).toHaveLength(1);
    expect(data!.otkCounts).toEqual({ signed_curve25519: 50 });
    expect(data!.unusedFallbackKeyTypes).toBeNull();
    expect(data!.left).toEqual(['@gone:x']);
  });

  it('returns null for a plain transaction without crypto data', () => {
    expect(extractCryptoSyncData({ events: [{ type: 'm.room.message' }] }, BOT, DEVICE)).toBeNull();
    expect(extractCryptoSyncData({ to_device: 'garbage', device_lists: [] }, BOT, DEVICE)).toBeNull();
  });
});

describe('createSyncFeeder', () => {
  it('passes arrays and the last OTK counts when hungryserv sends no fallback key types', async () => {
    const updateSyncData = vi.fn().mockResolvedValue(undefined);
    const { feed } = createSyncFeeder({ updateSyncData }, BOT, DEVICE);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const tx: Record<string, unknown> = hungryservTx();
    delete tx.device_unused_fallback_key_types;
    feed(tx);
    feed({ to_device: tx.to_device }); // no counts in this one
    await vi.waitFor(() => expect(updateSyncData).toHaveBeenCalledTimes(2));
    log.mockRestore();
    const [, counts1, fallback1] = updateSyncData.mock.calls[0]!;
    const [, counts2, fallback2] = updateSyncData.mock.calls[1]!;
    expect(fallback1).toEqual([]);
    expect(fallback2).toEqual([]);
    expect(counts1).toEqual({ signed_curve25519: 50 });
    expect(counts2).toEqual({ signed_curve25519: 50 });
  });
});

describe('createCryptoAppService', () => {
  const call = (svc: unknown, txnId: string, token: string, body: unknown) => {
    const res = { statusCode: 200, status: vi.fn(), send: vi.fn() };
    res.status.mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    (svc as { onTransaction(req: unknown, res: unknown): void }).onTransaction(
      { params: { txnId }, headers: { authorization: `Bearer ${token}` }, query: {}, body },
      res,
    );
    return res;
  };

  it('hands each new, authenticated transaction to the hook and still emits its events', () => {
    const hook = vi.fn();
    const svc = createCryptoAppService('hs-token', hook);
    const onEvent = vi.fn();
    svc.on('event', onEvent);
    const body = hungryservTx();

    call(svc, 't1', 'hs-token', body);
    expect(hook).toHaveBeenCalledWith(body);
    expect(onEvent).toHaveBeenCalledTimes(2);

    call(svc, 't1', 'hs-token', body); // duplicate delivery
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('ignores transactions with a wrong hs_token', () => {
    const hook = vi.fn();
    const svc = createCryptoAppService('hs-token', hook);
    const res = call(svc, 't2', 'wrong', hungryservTx());
    expect(res.statusCode).toBe(403);
    expect(hook).not.toHaveBeenCalled();
  });

  it('keeps answering the homeserver when the hook throws', () => {
    const svc = createCryptoAppService('hs-token', () => {
      throw new Error('boom');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = call(svc, 't3', 'hs-token', hungryservTx());
    expect(res.send).toHaveBeenCalledWith({});
    err.mockRestore();
  });
});

describe('createSyncFeeder handlers', () => {
  it('marks users as changed through the same queue and reports when it is idle', async () => {
    const order: string[] = [];
    const updateSyncData = vi.fn(async (_td: unknown[], _c: unknown, _f: unknown, changed: string[]) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(changed.join(',') || 'tx');
    });
    const feeder = createSyncFeeder({ updateSyncData }, BOT, DEVICE);
    feeder.feed({ device_one_time_keys_count: hungryservTx().device_one_time_keys_count });
    feeder.markChanged(['@owner:beeper.com']);
    feeder.markChanged([]); // nothing to do
    await feeder.idle();
    expect(order).toEqual(['tx', '@owner:beeper.com']);
    expect(updateSyncData).toHaveBeenLastCalledWith([], { signed_curve25519: 50 }, [], ['@owner:beeper.com'], []);
  });
});

describe('createRoomEncryption', () => {
  const engine = (over: Partial<RoomCryptoEngine> = {}): RoomCryptoEngine => ({
    isRoomEncrypted: vi.fn(async () => true),
    encryptRoomEvent: vi.fn(async () => ({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' })),
    decryptRoomEvent: vi.fn(async () => ({ type: 'm.room.message', content: { msgtype: 'm.text', body: 'hi' } })),
    onRoomEvent: vi.fn(async () => undefined),
    ...over,
  });

  it('decrypts after the pending sync data and keeps the ids and cleartext relations', async () => {
    const waitForSync = vi.fn(async () => undefined);
    const e = engine({ decryptRoomEvent: vi.fn(async () => ({ type: 'm.reaction', content: {} })) });
    const rooms = createRoomEncryption(e, waitForSync, []);
    const relates = { rel_type: 'm.annotation', event_id: '$t', key: 'ok' };
    const plain = await rooms.decrypt({
      type: 'm.room.encrypted',
      event_id: '$e',
      room_id: '!r:x',
      sender: '@owner:beeper.com',
      content: { algorithm: 'm.megolm.v1.aes-sha2', 'm.relates_to': relates },
    });
    expect(waitForSync).toHaveBeenCalled();
    expect(plain).toMatchObject({ type: 'm.reaction', event_id: '$e', room_id: '!r:x', sender: '@owner:beeper.com' });
    expect(plain.content).toEqual({ 'm.relates_to': relates });
  });

  it('retries while the room key has not arrived and gives up after the last delay', async () => {
    const decryptRoomEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error('no key'))
      .mockResolvedValueOnce({ type: 'm.room.message', content: { body: 'late' } });
    const rooms = createRoomEncryption(engine({ decryptRoomEvent }), async () => undefined, [1]);
    const plain = await rooms.decrypt({ type: 'm.room.encrypted', room_id: '!r:x', content: {} });
    expect(plain.content).toEqual({ body: 'late' });

    const failing = createRoomEncryption(
      engine({ decryptRoomEvent: vi.fn().mockRejectedValue(new Error('no key')) }),
      async () => undefined,
      [1, 1],
    );
    await expect(failing.decrypt({ type: 'm.room.encrypted', room_id: '!r:x', content: {} })).rejects.toThrow('no key');
  });

  it('caches encrypted rooms and asks again for a plain room after an encryption event', async () => {
    const isRoomEncrypted = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const e = engine({ isRoomEncrypted });
    const rooms = createRoomEncryption(e, async () => undefined);
    expect(await rooms.isEncrypted('!r:x')).toBe(false);
    expect(await rooms.isEncrypted('!r:x')).toBe(false); // cached
    expect(isRoomEncrypted).toHaveBeenCalledTimes(1);
    const state = { type: 'm.room.encryption', room_id: '!r:x', state_key: '', content: {} };
    await rooms.onStateEvent(state);
    expect(e.onRoomEvent).toHaveBeenCalledWith('!r:x', state);
    expect(await rooms.isEncrypted('!r:x')).toBe(true);
    expect(await rooms.isEncrypted('!r:x')).toBe(true);
    expect(isRoomEncrypted).toHaveBeenCalledTimes(2);
  });

  it('rejects without caching when the encryption state cannot be read', async () => {
    const isRoomEncrypted = vi.fn().mockRejectedValueOnce(new Error('M_FORBIDDEN')).mockResolvedValue(true);
    const rooms = createRoomEncryption(engine({ isRoomEncrypted }), async () => undefined);
    await expect(rooms.isEncrypted('!r:x')).rejects.toThrow('M_FORBIDDEN');
    expect(await rooms.isEncrypted('!r:x')).toBe(true); // asked the engine again
    expect(isRoomEncrypted).toHaveBeenCalledTimes(2);
  });

  it('markEncrypted makes a plain-cached room encrypted at once and tells the engine', async () => {
    const isRoomEncrypted = vi.fn().mockResolvedValue(false);
    const e = engine({ isRoomEncrypted });
    const rooms = createRoomEncryption(e, async () => undefined);
    expect(await rooms.isEncrypted('!r:x')).toBe(false); // cached as plain for 10 minutes
    await rooms.markEncrypted('!r:x');
    expect(await rooms.isEncrypted('!r:x')).toBe(true);
    expect(isRoomEncrypted).toHaveBeenCalledTimes(1);
    expect(e.onRoomEvent).toHaveBeenCalledWith(
      '!r:x',
      expect.objectContaining({ type: 'm.room.encryption', state_key: '', room_id: '!r:x' }),
    );
  });

  it('ignores state events it does not track', async () => {
    const e = engine();
    const rooms = createRoomEncryption(e, async () => undefined);
    await rooms.onStateEvent({ type: 'm.room.name', room_id: '!r:x', content: {} });
    expect(e.onRoomEvent).not.toHaveBeenCalled();
  });

  it('keeps m.relates_to next to the ciphertext so replies, reactions and edits stay linked', async () => {
    const relation = { 'm.in_reply_to': { event_id: '$parent' } };
    const e = engine({ encryptRoomEvent: vi.fn(async () => ({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' })) });
    const rooms = createRoomEncryption(e, async () => undefined);
    const withRelation = await rooms.encrypt('!r:x', 'm.room.message', { body: 'hi', 'm.relates_to': relation });
    expect(withRelation).toEqual({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x', 'm.relates_to': relation });
    // the plaintext keeps it too: the receiving client reads the relation from inside
    expect(e.encryptRoomEvent).toHaveBeenCalledWith('!r:x', 'm.room.message', {
      body: 'hi',
      'm.relates_to': relation,
    });
    expect(await rooms.encrypt('!r:x', 'm.room.message', { body: 'plain' })).not.toHaveProperty('m.relates_to');
  });

  it('encrypts one event at a time per room, also after a failure', async () => {
    let running = 0;
    let maxRunning = 0;
    const encryptRoomEvent = vi.fn(async (_r: string, _t: string, content: unknown) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if ((content as { fail?: boolean }).fail) throw new Error('boom');
      return { ciphertext: String((content as { body: string }).body) };
    });
    const rooms = createRoomEncryption(engine({ encryptRoomEvent }), async () => undefined);
    const results = await Promise.allSettled([
      rooms.encrypt('!r:x', 'm.room.message', { body: 'a' }),
      rooms.encrypt('!r:x', 'm.room.message', { fail: true }),
      rooms.encrypt('!r:x', 'm.room.message', { body: 'c' }),
    ]);
    expect(maxRunning).toBe(1);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[2] as PromiseFulfilledResult<unknown>).value).toEqual({ ciphertext: 'c' });
  });
});

describe('encryptAttachment', () => {
  it('returns ciphertext and the key info that decryptAttachment reverses', () => {
    const plain = Buffer.from('some media bytes');
    const { data, file } = encryptAttachment(plain);
    expect(data.equals(plain)).toBe(false);
    expect(file).toMatchObject({ v: 'v2', key: { alg: 'A256CTR' } });
    expect(file).not.toHaveProperty('url');
    expect(decryptAttachment(data, { ...file, url: 'mxc://x/y' }).equals(plain)).toBe(true);
  });
});

describe('installEncryptedSend', () => {
  type Client = {
    name?: string;
    crypto?: unknown;
    sendEvent(roomId: string, type: string, content: unknown): Promise<string>;
    sendRawEvent(roomId: string, type: string, content: unknown): Promise<string>;
  };
  const makeProto = () => {
    const sendEvent = vi.fn(async (_r: string, _t: string, _c: unknown) => '$plain');
    const sendRawEvent = vi.fn(async function (this: Client, _r: string, _t: string, _c: unknown) {
      return `$raw-${this.name ?? ''}`;
    });
    return { sendEvent, sendRawEvent } as Client & { sendEvent: typeof sendEvent; sendRawEvent: typeof sendRawEvent };
  };
  const rooms = (encrypted: boolean) => ({
    isEncrypted: vi.fn(async () => encrypted),
    encrypt: vi.fn(async () => ({ ciphertext: 'c' })),
    decrypt: vi.fn(),
    onStateEvent: vi.fn(),
    markEncrypted: vi.fn(),
  });

  it('encrypts events of clients without crypto in encrypted rooms and sends them as that client', async () => {
    const proto = makeProto();
    const original = proto.sendEvent;
    const r = rooms(true);
    const restore = installEncryptedSend(proto, r);
    const ghost: Client = Object.assign(Object.create(proto) as Client, { name: 'ghost' });
    expect(await ghost.sendEvent('!r:x', 'm.room.message', { body: 'hi' })).toBe('$raw-ghost');
    expect(r.encrypt).toHaveBeenCalledWith('!r:x', 'm.room.message', { body: 'hi' });
    expect(proto.sendRawEvent).toHaveBeenCalledWith('!r:x', 'm.room.encrypted', { ciphertext: 'c' });
    expect(original).not.toHaveBeenCalled();
    restore();
    expect(proto.sendEvent).toBe(original);
  });

  it('leaves plain rooms, clients with their own crypto and already encrypted events alone', async () => {
    const proto = makeProto();
    const original = proto.sendEvent;
    const restore = installEncryptedSend(proto, rooms(false));
    const ghost = Object.create(proto) as Client;
    expect(await ghost.sendEvent('!r:x', 'm.room.message', {})).toBe('$plain');
    restore();

    const r = rooms(true);
    const restore2 = installEncryptedSend(proto, r);
    const bot: Client = Object.assign(Object.create(proto) as Client, { crypto: {} });
    await bot.sendEvent('!r:x', 'm.room.message', {});
    await ghost.sendEvent('!r:x', 'm.room.encrypted', {});
    expect(original).toHaveBeenCalledTimes(3);
    expect(r.encrypt).not.toHaveBeenCalled();
    restore2();
  });

  it('fails the send instead of sending plaintext when the encryption state is unknown', async () => {
    const proto = makeProto();
    const original = proto.sendEvent;
    const r = rooms(true);
    r.isEncrypted.mockRejectedValueOnce(new Error('M_FORBIDDEN'));
    const restore = installEncryptedSend(proto, r);
    const ghost = Object.create(proto) as Client;
    await expect(ghost.sendEvent('!r:x', 'm.room.message', { body: 'secret' })).rejects.toThrow('M_FORBIDDEN');
    expect(original).not.toHaveBeenCalled();
    expect(proto.sendRawEvent).not.toHaveBeenCalled();
    restore();
  });
});

describe('prepareIncomingEvent', () => {
  const rooms = (over: Partial<RoomEncryption> = {}): RoomEncryption => ({
    isEncrypted: vi.fn(async () => true),
    encrypt: vi.fn(),
    decrypt: vi.fn(async (ev) => ({ ...ev, type: 'm.room.message', content: { body: 'hi' } })),
    onStateEvent: vi.fn(async () => undefined),
    markEncrypted: vi.fn(async () => undefined),
    ...over,
  });
  const deps = (r: RoomEncryption, onDecryptFailure = vi.fn()) => ({
    rooms: r,
    isBridgeUser: (id: string) => id.startsWith('@zalo_') || id === '@bot:x',
    onDecryptFailure,
  });

  it('decrypts the owner encrypted events', async () => {
    const r = rooms();
    const out = await prepareIncomingEvent({ type: 'm.room.encrypted', sender: '@owner:x', room_id: '!r' }, deps(r));
    expect(out).toMatchObject({ type: 'm.room.message', content: { body: 'hi' } });
  });

  it('drops encrypted events the bridge sent itself without decrypting them', async () => {
    const r = rooms();
    expect(await prepareIncomingEvent({ type: 'm.room.encrypted', sender: '@zalo_1:x' }, deps(r))).toBeNull();
    expect(r.decrypt).not.toHaveBeenCalled();
  });

  it('reports an undecryptable event and drops it', async () => {
    const r = rooms({ decrypt: vi.fn(async () => Promise.reject(new Error('no key'))) });
    const onFail = vi.fn();
    expect(
      await prepareIncomingEvent({ type: 'm.room.encrypted', sender: '@owner:x', room_id: '!r' }, deps(r, onFail)),
    ).toBeNull();
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('feeds state events to the tracker and still routes them, even when tracking fails', async () => {
    const r = rooms({ onStateEvent: vi.fn(async () => Promise.reject(new Error('boom'))) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ev = { type: 'm.room.member', state_key: '@owner:x', room_id: '!r' };
    expect(await prepareIncomingEvent(ev, deps(r))).toBe(ev);
    expect(r.onStateEvent).toHaveBeenCalledWith(ev);
    warn.mockRestore();
  });

  it('passes plain events through untouched', async () => {
    const r = rooms();
    const ev = { type: 'm.room.message', sender: '@owner:x' };
    expect(await prepareIncomingEvent(ev, deps(r))).toBe(ev);
  });
});
