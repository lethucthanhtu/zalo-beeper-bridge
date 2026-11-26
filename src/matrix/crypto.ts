// End-to-bridge encryption with a crypto device for the bridge bot.
// hungryserv has no MSC4190 (PUT /devices is 404) and its whoami under the as_token has no
// device_id, so the bot logs in with m.login.application_service and the bridge keeps the
// device id + access token itself. Room keys and device updates arrive in appservice
// transactions (MSC2409/MSC3202 data under the stable key names), not via /sync.
// Ghosts have no devices of their own: their events in encrypted rooms are encrypted with the
// bot device (as mautrix bridges do), and the bot device decrypts the owner's events.
import fs from 'node:fs';
import path from 'node:path';
import {
  type EncryptedFile,
  EncryptedRoomEvent,
  MatrixClient,
  MembershipEvent,
  RustSdkCryptoStorageProvider,
} from '@vector-im/matrix-bot-sdk';
import { Attachment, EncryptedAttachment, type StoreType } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { AppService } from 'matrix-appservice';
import { isRecord, sleep } from '../util.ts';

/** Device credentials of the bot, persisted in the crypto store directory. */
type BotDevice = {
  deviceId: string;
  accessToken: string;
};

/** Sync data the crypto engine needs from one appservice transaction. */
type CryptoSyncData = {
  toDevice: Record<string, unknown>[];
  /** One-time key counts of the device; `null` when the transaction has none. */
  otkCounts: Record<string, number> | null;
  /** Unused fallback key types; `null` when the transaction has none. */
  unusedFallbackKeyTypes: string[] | null;
  changed: string[];
  left: string[];
  /** Number of m.room.encrypted timeline events in the transaction (for diagnostics). */
  encryptedEvents: number;
};

/** Reads a transaction key under its stable name, falling back to the MSC-prefixed one. */
const pick = (body: Record<string, unknown>, stable: string, ...prefixed: string[]): unknown => {
  for (const key of [stable, ...prefixed]) if (body[key] !== undefined) return body[key];
  return undefined;
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Extracts the crypto data meant for one device from an appservice transaction body.
 * hungryserv sends `to_device`, `device_lists`, `device_one_time_keys_count` and
 * `device_unused_fallback_key_types` under their stable names; the MSC2409/MSC3202 prefixed
 * names are accepted too. To-device messages for other users or devices are dropped.
 *
 * @param body - The transaction JSON.
 * @param userId - The bot's Matrix ID.
 * @param deviceId - The bot's device id.
 * @returns The data for the bot device, or `null` when the transaction carries none.
 */
export function extractCryptoSyncData(
  body: Record<string, unknown>,
  userId: string,
  deviceId: string,
): CryptoSyncData | null {
  const rawToDevice = pick(body, 'to_device', 'de.sorunome.msc2409.to_device');
  const toDevice = (Array.isArray(rawToDevice) ? rawToDevice : []).filter(
    (msg): msg is Record<string, unknown> =>
      isRecord(msg) && msg.to_user_id === userId && (msg.to_device_id === deviceId || msg.to_device_id === '*'),
  );

  const otkAll = pick(
    body,
    'device_one_time_keys_count',
    'org.matrix.msc3202.device_one_time_keys_count',
    'org.matrix.msc3202.device_one_time_key_counts',
  );
  const otkForUser = isRecord(otkAll) ? otkAll[userId] : undefined;
  const otkCounts = isRecord(otkForUser) && isRecord(otkForUser[deviceId]) ? otkForUser[deviceId] : undefined;

  const fallbackAll = pick(
    body,
    'device_unused_fallback_key_types',
    'org.matrix.msc3202.device_unused_fallback_key_types',
  );
  const fallbackForUser = isRecord(fallbackAll) ? fallbackAll[userId] : undefined;
  const fallback = isRecord(fallbackForUser) ? fallbackForUser[deviceId] : undefined;

  const lists = pick(body, 'device_lists', 'org.matrix.msc3202.device_lists');
  const changed = isRecord(lists) ? stringArray(lists.changed) : [];
  const left = isRecord(lists) ? stringArray(lists.left) : [];

  const events = Array.isArray(body.events) ? body.events : [];
  const encryptedEvents = events.filter((e) => isRecord(e) && e.type === 'm.room.encrypted').length;

  if (!toDevice.length && !otkCounts && fallback === undefined && !changed.length && !left.length && !encryptedEvents) {
    return null;
  }
  return {
    toDevice,
    otkCounts: (otkCounts as Record<string, number> | undefined) ?? null,
    unusedFallbackKeyTypes: fallback === undefined ? null : stringArray(fallback),
    changed,
    left,
    encryptedEvents,
  };
}

type TransactionHandler = (req: { params: { txnId?: string }; body?: unknown }, res: { statusCode: number }) => void;

/**
 * Builds a matrix-appservice `AppService` that also hands each accepted transaction body to
 * `onTransaction` (after the library has checked the hs_token and dropped duplicates).
 * matrix-appservice binds its private `onTransaction` route in the constructor, so the
 * subclass overrides it on the prototype.
 *
 * @param homeserverToken - The registration's hs_token.
 * @param onTransaction - Receives the body of every new, authenticated transaction.
 */
export function createCryptoAppService(
  homeserverToken: string,
  onTransaction: (body: Record<string, unknown>) => void,
): AppService {
  const base = (AppService.prototype as unknown as { onTransaction: TransactionHandler }).onTransaction;
  class CryptoAppService extends AppService {}
  (CryptoAppService.prototype as unknown as { onTransaction: TransactionHandler }).onTransaction = function (
    this: { lastProcessedTxnId?: string },
    req,
    res,
  ) {
    const before = this.lastProcessedTxnId;
    base.call(this, req, res);
    const txnId = req.params.txnId;
    // Accepted and new: the library records the id only after a valid token and body
    if (txnId && before !== txnId && this.lastProcessedTxnId === txnId && isRecord(req.body)) {
      try {
        onTransaction(req.body);
      } catch (err) {
        console.error('[crypto] transaction hook failed:', err);
      }
    }
  };
  return new CryptoAppService({ homeserverToken });
}

/** Options for {@link initBotCrypto}. */
type BotCryptoOptions = {
  homeserverUrl: string;
  /** Full Matrix ID of the bridge bot (`@<sender_localpart>:<domain>`). */
  botUserId: string;
  asToken: string;
  /** Directory for the Rust crypto store and the device file. */
  storePath: string;
  /** Display name of a newly created device; defaults to "Zalo bridge". */
  deviceDisplayName?: string;
  fetchImpl?: typeof fetch;
};

/** A ready crypto device for the bridge bot. */
export type BotCrypto = {
  client: MatrixClient;
  deviceId: string;
  /** Feeds one transaction's crypto data to the engine; calls are serialised. */
  handleTransaction(body: Record<string, unknown>): void;
  /** Encrypts and decrypts room events with the bot device. */
  rooms: RoomEncryption;
  /** Forgets a room's cached members, after the bridge changed a membership in it. */
  invalidateMembers(roomId: string): void;
  /** Asks the engine to query these users' devices again (hungryserv sends no device_lists). */
  refreshDevices(userIds: string[]): void;
};

const DEVICE_FILE = 'bot-device.json';
/** `StoreType.Sqlite`; the enum is an ambient const enum and cannot be imported at runtime. */
const SQLITE_STORE = 0 as StoreType;

function readDevice(file: string): BotDevice | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BotDevice>;
    return parsed.deviceId && parsed.accessToken
      ? { deviceId: parsed.deviceId, accessToken: parsed.accessToken }
      : null;
  } catch {
    return null;
  }
}

function writeDevice(file: string, device: BotDevice): void {
  fs.writeFileSync(file, JSON.stringify(device), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Logs the bot in as an appservice user. Re-uses `deviceId` when given, so the existing
 * crypto store stays valid after a token is revoked.
 */
async function appserviceLogin(opts: BotCryptoOptions, deviceId?: string): Promise<BotDevice> {
  const doFetch = opts.fetchImpl ?? fetch;
  const resp = await doFetch(`${opts.homeserverUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.asToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.application_service',
      identifier: { type: 'm.id.user', user: opts.botUserId },
      ...(deviceId ? { device_id: deviceId } : {}),
      initial_device_display_name: opts.deviceDisplayName ?? 'Zalo bridge',
    }),
  });
  const json = (await resp.json().catch(() => ({}))) as { access_token?: string; device_id?: string; errcode?: string };
  if (!resp.ok || !json.access_token || !json.device_id) {
    throw new Error(`appservice login failed: HTTP ${resp.status} ${json.errcode ?? ''}`.trim());
  }
  return { deviceId: json.device_id, accessToken: json.access_token };
}

/**
 * Creates (or resumes) the bot's crypto device and its Rust crypto store.
 *
 * @throws When the login fails or the crypto store cannot be opened.
 */
export async function initBotCrypto(opts: BotCryptoOptions): Promise<BotCrypto> {
  fs.mkdirSync(opts.storePath, { recursive: true, mode: 0o700 });
  const deviceFile = path.join(opts.storePath, DEVICE_FILE);
  let device = readDevice(deviceFile);

  const makeClient = (accessToken: string) =>
    new MatrixClient(
      opts.homeserverUrl,
      accessToken,
      undefined,
      new RustSdkCryptoStorageProvider(path.join(opts.storePath, 'bot'), SQLITE_STORE),
    );

  let client: MatrixClient | null = null;
  if (device) {
    const candidate = makeClient(device.accessToken);
    try {
      const who = await candidate.getWhoAmI();
      if (who.device_id === device.deviceId) client = candidate;
    } catch {
      // token revoked or expired: log in again with the same device id below
    }
  }
  if (!client) {
    device = await appserviceLogin(opts, device?.deviceId);
    writeDevice(deviceFile, device);
    client = makeClient(device.accessToken);
  }
  const crypto = client.crypto;
  await crypto.prepare();
  const deviceId = crypto.clientDeviceId;
  console.log(`[crypto] bot device ${deviceId} ready`);

  // Serve the engine's per-message member lookups from a cache (see createMemberCache)
  const members = createMemberCache(async (roomId) => {
    const resp = (await client.doRequest('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`)) as {
      chunk?: unknown[] | null;
    };
    // A member event without a membership would make the engine's filter throw
    return (resp.chunk ?? [])
      .filter((e) => isRecord(e) && isRecord(e.content) && typeof e.content.membership === 'string')
      .map((e) => new MembershipEvent(e));
  });
  const originalMembers = client.getRoomMembersByMembership.bind(client);
  client.getRoomMembersByMembership = (roomId, membership, atToken) =>
    atToken ? originalMembers(roomId, membership, atToken) : members.byMembership(roomId, membership);

  const feeder = createSyncFeeder(crypto, opts.botUserId, deviceId);
  const rooms = createRoomEncryption(
    {
      isRoomEncrypted: (roomId) => crypto.isRoomEncrypted(roomId),
      encryptRoomEvent: (roomId, type, content) => crypto.encryptRoomEvent(roomId, type, content),
      decryptRoomEvent: async (event, roomId) => {
        const clear = await crypto.decryptRoomEvent(new EncryptedRoomEvent(event), roomId);
        return { type: clear.type, content: clear.content as Record<string, unknown> };
      },
      onRoomEvent: (roomId, event) => crypto.onRoomEvent(roomId, event),
    },
    feeder.idle,
  );

  return {
    client,
    deviceId,
    invalidateMembers: members.invalidate,
    handleTransaction: (body) => {
      for (const roomId of memberEventRooms(body)) members.invalidate(roomId);
      feeder.feed(body);
    },
    rooms,
    refreshDevices: feeder.markChanged,
  };
}

/**
 * Decrypts an encrypted attachment (`content.file` of a media event) downloaded from the
 * homeserver.
 *
 * @param data - The downloaded ciphertext.
 * @param file - The event's `file` object (key, iv, hashes, url).
 * @throws When the key or hash does not match.
 */
export function decryptAttachment(data: Buffer, file: unknown): Buffer {
  return Buffer.from(Attachment.decrypt(new EncryptedAttachment(data, JSON.stringify(file))));
}

/**
 * Encrypts media for an encrypted room: the ciphertext is what gets uploaded, the returned
 * `file` (without `url`, which the upload supplies) goes into the event as `content.file`.
 *
 * @param data - The plain media bytes.
 */
export function encryptAttachment(data: Buffer): { data: Buffer; file: Omit<EncryptedFile, 'url'> } {
  const encrypted = Attachment.encrypt(data);
  if (!encrypted.mediaEncryptionInfo) throw new Error('attachment encryption returned no key info');
  return {
    data: Buffer.from(encrypted.encryptedData),
    file: JSON.parse(encrypted.mediaEncryptionInfo) as Omit<EncryptedFile, 'url'>,
  };
}

/** The part of bot-sdk's `CryptoClient` the sync feeder uses. */
type SyncDataSink = {
  updateSyncData(
    toDevice: unknown[],
    otkCounts: Record<string, number>,
    unusedFallbackKeyAlgs: string[],
    changed: string[],
    left: string[],
  ): Promise<void>;
};

/** The handlers {@link createSyncFeeder} returns. */
type SyncFeeder = {
  /** Feeds one appservice transaction. */
  feed(body: Record<string, unknown>): void;
  /** Marks users' device lists as changed, so the engine queries their devices again. */
  markChanged(userIds: string[]): void;
  /** Resolves once everything fed so far has reached the engine. */
  idle(): Promise<void>;
};

/**
 * Returns handlers that feed the bot device's crypto data to the engine, one update at a time.
 */
export function createSyncFeeder(crypto: SyncDataSink, userId: string, deviceId: string): SyncFeeder {
  let queue: Promise<void> = Promise.resolve();
  // The engine reads missing counts as 0 and would upload keys again on every transaction,
  // so transactions without counts reuse the last ones the server reported. hungryserv sends
  // no fallback key types at all; the engine needs an array, so they start empty.
  let lastOtkCounts: Record<string, number> = {};
  let lastFallback: string[] = [];
  // The key counts the engine last received, or null when it has none (start, or a failed update)
  let fedKeys: string | null = null;

  const enqueue = (toDevice: Record<string, unknown>[], changed: string[], left: string[]) => {
    const otkCounts = lastOtkCounts;
    const fallback = lastFallback;
    const keys = JSON.stringify([otkCounts, fallback]);
    queue = queue
      .then(() => crypto.updateSyncData(toDevice, otkCounts, fallback, changed, left))
      .then(() => {
        if (toDevice.length) {
          const types = [...new Set(toDevice.map((m) => String(m.type)))].join(', ');
          console.log(`[crypto] processed ${toDevice.length} to-device message(s): ${types}`);
        }
      })
      .catch((err: unknown) => {
        // Let the next transaction feed these counts again
        if (fedKeys === keys) fedKeys = null;
        console.error('[crypto] sync data update failed:', err);
      });
  };

  const feed = (body: Record<string, unknown>) => {
    const data = extractCryptoSyncData(body, userId, deviceId);
    if (!data) return;
    if (data.encryptedEvents) console.log(`[crypto] transaction with ${data.encryptedEvents} encrypted event(s)`);
    // hungryserv repeats the key counts in every transaction (receipts and typing too).
    // Feeding unchanged counts tells the engine nothing new but holds the lock that
    // encrypting a message waits for, so only changes are fed.
    if (data.otkCounts) lastOtkCounts = data.otkCounts;
    if (data.unusedFallbackKeyTypes) lastFallback = data.unusedFallbackKeyTypes;
    const keys = JSON.stringify([lastOtkCounts, lastFallback]);
    const hasKeys = data.otkCounts !== null || data.unusedFallbackKeyTypes !== null;
    const keysChanged = hasKeys && keys !== fedKeys;
    if (!data.toDevice.length && !data.changed.length && !data.left.length && !keysChanged) return;
    if (hasKeys) fedKeys = keys;
    enqueue(data.toDevice, data.changed, data.left);
  };

  return {
    feed,
    markChanged: (userIds) => {
      if (userIds.length) enqueue([], userIds, []);
    },
    idle: () => queue,
  };
}

/** A room member as the crypto engine reads it (bot-sdk's `MembershipEvent`). */
export type RoomMember = { membershipFor: string; membership: string };

/** Cached room member lists for the crypto engine; see {@link createMemberCache}. */
export type MemberCache<M extends RoomMember> = {
  /** Members of a room with this membership, from the cache when it is fresh. */
  byMembership(roomId: string, membership: string): Promise<M[]>;
  /** Forgets a room, so its next lookup fetches the members again. */
  invalidate(roomId: string): void;
};

/** How long a room's member list is trusted without a membership event. */
export const MEMBER_CACHE_TTL_MS = 10 * 60_000;

/**
 * Caches room members for the crypto engine. bot-sdk asks the homeserver for the members
 * (once per membership type) before encrypting every message, which costs two round trips
 * per bridged message. The bridge sees every membership change in its transactions, so it
 * invalidates the room there; the TTL is a safety net for anything it misses.
 *
 * @param fetchMembers - Fetches all members of a room (any membership).
 * @param ttlMs - How long a fetched list stays fresh.
 * @param now - Clock, for tests.
 */
export function createMemberCache<M extends RoomMember>(
  fetchMembers: (roomId: string) => Promise<M[]>,
  ttlMs: number = MEMBER_CACHE_TTL_MS,
  now: () => number = Date.now,
): MemberCache<M> {
  const entries = new Map<string, { members: Promise<M[]>; expires: number }>();

  const load = (roomId: string): Promise<M[]> => {
    const cached = entries.get(roomId);
    if (cached && cached.expires > now()) return cached.members;
    const members = fetchMembers(roomId);
    const entry = { members, expires: now() + ttlMs };
    entries.set(roomId, entry);
    // A failed fetch is not cached; neither is one that a membership change made stale
    members.catch(() => {
      if (entries.get(roomId) === entry) entries.delete(roomId);
    });
    return members;
  };

  return {
    byMembership: async (roomId, membership) => (await load(roomId)).filter((m) => m.membership === membership),
    invalidate: (roomId) => void entries.delete(roomId),
  };
}

/**
 * Lists the rooms with `m.room.member` events in an appservice transaction.
 *
 * @param body - The transaction JSON.
 */
export function memberEventRooms(body: Record<string, unknown>): string[] {
  const events = Array.isArray(body.events) ? body.events : [];
  const rooms = new Set<string>();
  for (const e of events) {
    if (isRecord(e) && e.type === 'm.room.member' && typeof e.room_id === 'string') rooms.add(e.room_id);
  }
  return [...rooms];
}

/** The part of bot-sdk's `CryptoClient` that {@link createRoomEncryption} uses. */
export type RoomCryptoEngine = {
  isRoomEncrypted(roomId: string): Promise<boolean>;
  encryptRoomEvent(roomId: string, type: string, content: unknown): Promise<unknown>;
  /** Decrypts a raw `m.room.encrypted` event; rejects when the room key is missing. */
  decryptRoomEvent(
    event: Record<string, unknown>,
    roomId: string,
  ): Promise<{ type: string; content: Record<string, unknown> }>;
  onRoomEvent(roomId: string, event: Record<string, unknown>): Promise<void>;
};

/** Room-level encryption with the bot device, as used by the bridge. */
export type RoomEncryption = {
  isEncrypted(roomId: string): Promise<boolean>;
  /** Encrypts an event; calls for one room run one at a time. */
  encrypt(roomId: string, type: string, content: unknown): Promise<Record<string, unknown>>;
  /**
   * Decrypts an `m.room.encrypted` event into the plain event (same ids, decrypted type and
   * content). Waits for pending room keys and retries while the key has not arrived yet.
   */
  decrypt(event: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Passes encryption, history-visibility and membership state events to the engine. */
  onStateEvent(event: Record<string, unknown>): Promise<void>;
  /**
   * Records that the bridge just made a room encrypted, so its next event is encrypted right
   * away instead of waiting for the room to be re-checked. The bot must already be in the room.
   */
  markEncrypted(roomId: string): Promise<void>;
};

/** `algorithm` of the `m.room.encryption` state event every encrypted portal is created with. */
export const ROOM_ENCRYPTION_ALGORITHM = 'm.megolm.v1.aes-sha2';
/** Delays between decryption attempts while a room key is still on its way. */
export const DECRYPT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
/** How long a room is remembered as unencrypted before the engine is asked again. */
const UNENCRYPTED_TTL_MS = 10 * 60_000;
const TRACKED_STATE = new Set(['m.room.encryption', 'm.room.history_visibility', 'm.room.member']);

/**
 * Builds the bridge's room encryption on top of the crypto engine.
 *
 * @param engine - The bot device's crypto engine.
 * @param waitForSync - Resolves once queued to-device messages (room keys) are processed.
 * @param retryDelaysMs - Delays between decryption attempts.
 */
export function createRoomEncryption(
  engine: RoomCryptoEngine,
  waitForSync: () => Promise<void>,
  retryDelaysMs: number[] = DECRYPT_RETRY_DELAYS_MS,
): RoomEncryption {
  const encrypted = new Set<string>();
  const plainUntil = new Map<string, number>();
  const roomQueues = new Map<string, Promise<unknown>>();

  const isEncrypted = async (roomId: string): Promise<boolean> => {
    if (encrypted.has(roomId)) return true;
    if ((plainUntil.get(roomId) ?? 0) > Date.now()) return false;
    // An engine error propagates and is not cached: answering "plain" here would let the
    // send path put plaintext into an encrypted room. The caller's send fails instead.
    const result = await engine.isRoomEncrypted(roomId);
    if (result) encrypted.add(roomId);
    else plainUntil.set(roomId, Date.now() + UNENCRYPTED_TTL_MS);
    return result;
  };

  const encrypt = (roomId: string, type: string, content: unknown): Promise<Record<string, unknown>> => {
    const previous = roomQueues.get(roomId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const encryptedContent = (await engine.encryptRoomEvent(roomId, type, content)) as Record<string, unknown>;
        // Like Element: the relation also stays in clear, the homeserver needs it to bundle edits and reactions
        const relation = isRecord(content) ? content['m.relates_to'] : undefined;
        return relation === undefined ? encryptedContent : { ...encryptedContent, 'm.relates_to': relation };
      });
    roomQueues.set(roomId, next);
    next
      .catch(() => undefined)
      .finally(() => {
        if (roomQueues.get(roomId) === next) roomQueues.delete(roomId);
      });
    return next;
  };

  const decrypt = async (event: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const roomId = String(event.room_id);
    for (let attempt = 0; ; attempt++) {
      // A room key and the event it unlocks can arrive in the same transaction
      await waitForSync();
      try {
        const clear = await engine.decryptRoomEvent(event, roomId);
        const content = { ...clear.content };
        // Relations may stay outside the ciphertext (m.relates_to on the wire content)
        const wire = isRecord(event.content) ? event.content : {};
        if (content['m.relates_to'] === undefined && wire['m.relates_to'] !== undefined) {
          content['m.relates_to'] = wire['m.relates_to'];
        }
        return { ...event, type: clear.type, content };
      } catch (err) {
        const delay = retryDelaysMs[attempt];
        if (delay === undefined) throw err;
        await sleep(delay);
      }
    }
  };

  const onStateEvent = async (event: Record<string, unknown>): Promise<void> => {
    const roomId = event.room_id;
    if (typeof roomId !== 'string' || typeof event.type !== 'string' || !TRACKED_STATE.has(event.type)) return;
    if (event.type === 'm.room.encryption') plainUntil.delete(roomId);
    await engine.onRoomEvent(roomId, event);
  };

  const markEncrypted = async (roomId: string): Promise<void> => {
    encrypted.add(roomId);
    plainUntil.delete(roomId);
    // The engine reads the room's state itself and starts tracking the members' devices
    await engine.onRoomEvent(roomId, {
      type: 'm.room.encryption',
      state_key: '',
      room_id: roomId,
      content: { algorithm: ROOM_ENCRYPTION_ALGORITHM },
    });
  };

  return { isEncrypted, encrypt, decrypt, onStateEvent, markEncrypted };
}

/** What {@link prepareIncomingEvent} needs from the bridge. */
type IncomingCryptoDeps = {
  rooms: RoomEncryption;
  /** True for the bridge bot and its ghosts: their encrypted events are the bridge's own sends. */
  isBridgeUser(userId: string): boolean;
  /** Called when an event cannot be decrypted (after all retries). */
  onDecryptFailure(event: Record<string, unknown>, err: unknown): Promise<void> | void;
};

/**
 * Runs an appservice event through the bot device before routing: state events update the
 * room's encryption tracking, `m.room.encrypted` events are decrypted.
 *
 * @returns The event to route (decrypted when it was encrypted), or `null` to drop it.
 */
export async function prepareIncomingEvent<T extends Record<string, unknown>>(
  event: T,
  deps: IncomingCryptoDeps,
): Promise<T | null> {
  if (event.state_key !== undefined) {
    try {
      await deps.rooms.onStateEvent(event);
    } catch (err) {
      console.warn('[crypto] tracking a state event failed:', err);
    }
    return event;
  }
  if (event.type !== 'm.room.encrypted') return event;
  if (typeof event.sender === 'string' && deps.isBridgeUser(event.sender)) return null;
  try {
    return (await deps.rooms.decrypt(event)) as T;
  } catch (err) {
    try {
      await deps.onDecryptFailure(event, err);
    } catch (noticeErr) {
      console.warn('[crypto] decrypt-failure handler failed:', noticeErr);
    }
    return null;
  }
}

/** The `MatrixClient` methods {@link installEncryptedSend} wraps. */
export type SendingClient = {
  crypto?: unknown;
  sendEvent(roomId: string, type: string, content: unknown): Promise<string>;
  sendRawEvent(roomId: string, type: string, content: unknown): Promise<string>;
};

/**
 * Makes every client without its own crypto (ghosts, the bridge bot's as_token client)
 * encrypt its room events with the bot device when the room is encrypted, the way mautrix
 * bridges do. State events and redactions use other methods and stay plain.
 *
 * @param proto - `MatrixClient.prototype` (shared by all intents of the bridge library).
 * @param rooms - The bot device's room encryption.
 * @returns A function that restores the original `sendEvent`.
 */
export function installEncryptedSend(proto: SendingClient, rooms: RoomEncryption): () => void {
  const original = proto.sendEvent;
  proto.sendEvent = async function (this: SendingClient, roomId: string, type: string, content: unknown) {
    if (!this.crypto && type !== 'm.room.encrypted' && (await rooms.isEncrypted(roomId))) {
      const ciphertext = await rooms.encrypt(roomId, type, content);
      return this.sendRawEvent(roomId, 'm.room.encrypted', ciphertext);
    }
    return original.call(this, roomId, type, content);
  };
  return () => {
    proto.sendEvent = original;
  };
}

/** The `MatrixClient` membership methods {@link installMemberInvalidation} wraps. */
export type MembershipClient = {
  inviteUser(userId: string, roomId: string): Promise<unknown>;
  kickUser(userId: string, roomId: string, reason?: string): Promise<unknown>;
  banUser(userId: string, roomId: string, reason?: string): Promise<unknown>;
  unbanUser(userId: string, roomId: string): Promise<unknown>;
  joinRoom(roomIdOrAlias: string, viaServers?: string[]): Promise<string>;
  leaveRoom(roomId: string, reason?: string): Promise<unknown>;
  sendStateEvent(roomId: string, type: string, stateKey: string, content: unknown): Promise<string>;
};

/**
 * Forgets a room's cached members whenever a bridge client changes a membership in it.
 * The member cache is otherwise refreshed by the membership events in appservice
 * transactions, and the bridge cannot count on the homeserver echoing its own changes;
 * a join or invite that the cache missed would leave the new member without the room key.
 * The room is forgotten even when the call fails, since the change may still have happened.
 *
 * @param proto - `MatrixClient.prototype` (shared by all intents of the bridge library).
 * @param invalidate - Forgets one room's members.
 * @returns A function that restores the original methods.
 */
export function installMemberInvalidation(proto: MembershipClient, invalidate: (roomId: string) => void): () => void {
  const originals = {
    inviteUser: proto.inviteUser,
    kickUser: proto.kickUser,
    banUser: proto.banUser,
    unbanUser: proto.unbanUser,
    joinRoom: proto.joinRoom,
    leaveRoom: proto.leaveRoom,
    sendStateEvent: proto.sendStateEvent,
  };
  // An alias is resolved by the join itself; the room id comes back in its result
  const forget = (roomId: unknown) => {
    if (typeof roomId === 'string' && roomId.startsWith('!')) invalidate(roomId);
  };
  const wrap = <A extends unknown[], R>(
    original: (this: MembershipClient, ...args: A) => Promise<R>,
    roomOf: (args: A) => unknown,
  ) =>
    async function (this: MembershipClient, ...args: A): Promise<R> {
      try {
        const result = await original.apply(this, args);
        forget(result); // joinRoom's room id; other results are never a room id
        return result;
      } finally {
        forget(roomOf(args));
      }
    };

  proto.inviteUser = wrap(originals.inviteUser, (a) => a[1]);
  proto.kickUser = wrap(originals.kickUser, (a) => a[1]);
  proto.banUser = wrap(originals.banUser, (a) => a[1]);
  proto.unbanUser = wrap(originals.unbanUser, (a) => a[1]);
  proto.joinRoom = wrap(originals.joinRoom, (a) => a[0]);
  proto.leaveRoom = wrap(originals.leaveRoom, (a) => a[0]);
  proto.sendStateEvent = wrap(originals.sendStateEvent, (a) => (a[1] === 'm.room.member' ? a[0] : undefined));
  return () => {
    Object.assign(proto, originals);
  };
}
