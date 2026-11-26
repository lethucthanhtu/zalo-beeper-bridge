import { describe, expect, it, vi } from 'vitest';
import {
  createCryptoAppService,
  createMemberCache,
  createRoomEncryption,
  createSyncFeeder,
  decryptAttachment,
  encryptAttachment,
  extractCryptoSyncData,
  installEncryptedSend,
  installMemberInvalidation,
  memberEventRooms,
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

describe('createSyncFeeder skipping', () => {
  it('skips transactions that only repeat the last key counts', async () => {
    const updateSyncData = vi.fn().mockResolvedValue(undefined);
    const feeder = createSyncFeeder({ updateSyncData }, BOT, DEVICE);
    const counts = (n: number) => ({
      device_one_time_keys_count: { [BOT]: { [DEVICE]: { signed_curve25519: n } } },
      device_unused_fallback_key_types: { [BOT]: { [DEVICE]: ['signed_curve25519'] } },
    });
    feeder.feed(counts(50));
    feeder.feed(counts(50)); // unchanged: nothing new for the engine
    feeder.feed({ ...counts(50), events: [{ type: 'm.room.encrypted', room_id: '!r:x' }] }); // still nothing new
    feeder.feed(counts(49)); // changed
    await feeder.idle();
    expect(updateSyncData).toHaveBeenCalledTimes(2);
    expect(updateSyncData.mock.calls[1]![1]).toEqual({ signed_curve25519: 49 });
  });

  it('feeds to-device messages even when the key counts are unchanged', async () => {
    const updateSyncData = vi.fn().mockResolvedValue(undefined);
    const feeder = createSyncFeeder({ updateSyncData }, BOT, DEVICE);
    const counts = { device_one_time_keys_count: { [BOT]: { [DEVICE]: { signed_curve25519: 50 } } } };
    feeder.feed(counts);
    feeder.feed({
      ...counts,
      'de.sorunome.msc2409.to_device': [{ type: 'm.room_key', to_user_id: BOT, to_device_id: DEVICE }],
    });
    await feeder.idle();
    expect(updateSyncData).toHaveBeenCalledTimes(2);
    expect(updateSyncData.mock.calls[1]![0]).toHaveLength(1);
  });

  it('feeds the same key counts again after a failed update', async () => {
    const updateSyncData = vi.fn().mockRejectedValueOnce(new Error('store busy')).mockResolvedValue(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const feeder = createSyncFeeder({ updateSyncData }, BOT, DEVICE);
    const counts = { device_one_time_keys_count: { [BOT]: { [DEVICE]: { signed_curve25519: 50 } } } };
    feeder.feed(counts);
    await feeder.idle();
    feeder.feed(counts); // the engine never got these
    await feeder.idle();
    feeder.feed(counts); // now it has
    await feeder.idle();
    expect(updateSyncData).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe('memberEventRooms', () => {
  it('lists the rooms whose membership changed in a transaction', () => {
    expect(
      memberEventRooms({
        events: [
          { type: 'm.room.member', room_id: '!a:x', state_key: '@u:x' },
          { type: 'm.room.message', room_id: '!b:x' },
          { type: 'm.room.member', room_id: '!a:x', state_key: '@v:x' },
          { type: 'm.room.member', room_id: '!c:x', state_key: '@u:x' },
        ],
      }),
    ).toEqual(['!a:x', '!c:x']);
    expect(memberEventRooms({})).toEqual([]);
  });
});

describe('createMemberCache', () => {
  const member = (userId: string, membership: string) => ({ membershipFor: userId, membership });

  it('fetches a room once for every membership type and filters locally', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue([member('@a:x', 'join'), member('@b:x', 'invite'), member('@c:x', 'leave')]);
    const cache = createMemberCache(fetch);
    const [joined, invited] = await Promise.all([
      cache.byMembership('!r:x', 'join'),
      cache.byMembership('!r:x', 'invite'),
    ]);
    expect(joined.map((m) => m.membershipFor)).toEqual(['@a:x']);
    expect(invited.map((m) => m.membershipFor)).toEqual(['@b:x']);
    await cache.byMembership('!r:x', 'join');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetches again after a membership change or once the entry expires', async () => {
    let now = 0;
    const fetch = vi.fn().mockResolvedValue([member('@a:x', 'join')]);
    const cache = createMemberCache(fetch, 1_000, () => now);
    await cache.byMembership('!r:x', 'join');
    cache.invalidate('!r:x');
    await cache.byMembership('!r:x', 'join');
    now = 1_001;
    await cache.byMembership('!r:x', 'join');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed fetch', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue([member('@a:x', 'join')]);
    const cache = createMemberCache(fetch);
    await expect(cache.byMembership('!r:x', 'join')).rejects.toThrow('timeout');
    expect(await cache.byMembership('!r:x', 'join')).toHaveLength(1);
  });

  it('drops a fetch that was in flight when the room changed', async () => {
    let resolveFirst: (v: unknown[]) => void = () => undefined;
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValue([member('@new:x', 'join')]);
    const cache = createMemberCache(fetch);
    const first = cache.byMembership('!r:x', 'join');
    cache.invalidate('!r:x');
    resolveFirst([member('@old:x', 'join')]);
    await first;
    expect((await cache.byMembership('!r:x', 'join')).map((m) => m.membershipFor)).toEqual(['@new:x']);
  });
});

describe('createMemberCache failures', () => {
  it('keeps a newer fetch when an older one fails', async () => {
    let failOld!: (err: Error) => void;
    const fetch = vi
      .fn()
      .mockReturnValueOnce(new Promise((_, reject) => (failOld = reject)))
      .mockResolvedValue([{ membershipFor: '@a:x', membership: 'join' }]);
    const cache = createMemberCache(fetch);
    const old = cache.byMembership('!r:x', 'join');
    cache.invalidate('!r:x');
    await cache.byMembership('!r:x', 'join'); // second fetch, now cached
    failOld(new Error('gone'));
    await expect(old).rejects.toThrow('gone');
    await cache.byMembership('!r:x', 'join');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('installMemberInvalidation', () => {
  const makeProto = () => ({
    inviteUser: vi.fn().mockResolvedValue({}),
    kickUser: vi.fn().mockResolvedValue({}),
    banUser: vi.fn().mockResolvedValue({}),
    unbanUser: vi.fn().mockResolvedValue({}),
    joinRoom: vi.fn().mockResolvedValue('!joined:x'),
    leaveRoom: vi.fn().mockResolvedValue({}),
    sendStateEvent: vi.fn().mockResolvedValue('$state'),
  });

  it('forgets the room after every membership change the bridge makes', async () => {
    const proto = makeProto();
    const invalidate = vi.fn();
    installMemberInvalidation(proto, invalidate);
    await proto.inviteUser('@u:x', '!a:x');
    await proto.kickUser('@u:x', '!b:x');
    await proto.banUser('@u:x', '!c:x');
    await proto.unbanUser('@u:x', '!d:x');
    await proto.leaveRoom('!e:x');
    await proto.joinRoom('#alias:x'); // the room id comes from the result
    await proto.sendStateEvent('!f:x', 'm.room.member', '@u:x', { membership: 'join' });
    await proto.sendStateEvent('!g:x', 'm.room.name', '', { name: 'n' });
    expect(invalidate.mock.calls.map((c) => c[0])).toEqual([
      '!a:x',
      '!b:x',
      '!c:x',
      '!d:x',
      '!e:x',
      '!joined:x',
      '!f:x',
    ]);
  });

  it('passes the call through and forgets the room even when it fails', async () => {
    const proto = makeProto();
    const original = proto.inviteUser;
    original.mockRejectedValueOnce(new Error('timeout'));
    const invalidate = vi.fn();
    const restore = installMemberInvalidation(proto, invalidate);
    await expect(proto.inviteUser('@u:x', '!a:x')).rejects.toThrow('timeout');
    expect(original).toHaveBeenCalledWith('@u:x', '!a:x');
    expect(invalidate).toHaveBeenCalledWith('!a:x');
    restore();
    expect(proto.inviteUser).toBe(original);
  });
});
