// Encrypts imported history for Beeper's batch_send. bot-sdk's CryptoClient.encryptRoomEvent
// shares the room key and flushes outgoing requests on every call (~400 ms per event); history
// import instead shares the key once per batch and encrypts each event locally (~10 ms).
import type { MatrixClient } from '@vector-im/matrix-bot-sdk';
import { RoomId } from '@matrix-org/matrix-sdk-crypto-nodejs';

/** One event of a `batch_send` request. */
export type BatchEvent = {
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
};

/** The crypto operations history encryption needs; {@link historyCryptoEngine} adapts bot-sdk. */
export type HistoryCryptoEngine = {
  /** Shares the room's megolm session with every member device, starting a new one when the old one expired. */
  shareRoomKey(roomId: string): Promise<void>;
  /** Encrypts one event with the current session, without any network call. */
  encrypt(roomId: string, type: string, content: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Sends the requests the engine still has queued (key queries, key shares). */
  flush(): Promise<void>;
};

/** Content key naming the bridge that sent an owner event on the owner's behalf. */
export const DOUBLE_PUPPET_SOURCE_KEY = 'fi.mau.double_puppet_source';

/**
 * Content keys that must stay readable outside the ciphertext: servers and clients aggregate
 * replies, edits and reactions from `m.relates_to`, and Beeper's server only treats an owner
 * event as already bridged (no "failed to send" status) when it sees `fi.mau.double_puppet_source`.
 */
const CLEARTEXT_KEYS = ['m.relates_to', DOUBLE_PUPPET_SOURCE_KEY] as const;

/** Error text of the crypto machine when the megolm session hit its message or age limit. */
const SESSION_EXPIRED = 'Session expired';

const isSessionExpired = (err: unknown): boolean =>
  err instanceof Error ? err.message.includes(SESSION_EXPIRED) : String(err).includes(SESSION_EXPIRED);

/**
 * Turns plain history events into `m.room.encrypted` events, in order. The room key is shared
 * once per batch and again whenever the session expires mid-batch (the machine rotates it after
 * 100 messages by default). The {@link CLEARTEXT_KEYS} are copied into the clear content.
 *
 * @param engine - The importer device's crypto operations.
 * @param roomId - The encrypted target room; the bot must be joined to it.
 * @param events - Plain events, oldest first. They are not modified.
 * @returns The encrypted events, same order, senders and timestamps.
 * @throws When the room key cannot be shared or an event cannot be encrypted.
 */
export async function encryptHistoryBatch(
  engine: HistoryCryptoEngine,
  roomId: string,
  events: readonly BatchEvent[],
): Promise<BatchEvent[]> {
  if (events.length === 0) return [];
  await engine.shareRoomKey(roomId);
  const encrypted: BatchEvent[] = [];
  for (const event of events) {
    let content: Record<string, unknown>;
    try {
      content = await engine.encrypt(roomId, event.type, event.content);
    } catch (err) {
      if (!isSessionExpired(err)) throw err;
      await engine.shareRoomKey(roomId);
      content = await engine.encrypt(roomId, event.type, event.content);
    }
    for (const key of CLEARTEXT_KEYS) if (event.content[key] !== undefined) content[key] = event.content[key];
    encrypted.push({
      type: 'm.room.encrypted',
      sender: event.sender,
      origin_server_ts: event.origin_server_ts,
      content,
    });
  }
  await engine.flush();
  return encrypted;
}

/** The private parts of bot-sdk's CryptoClient that the fast path needs. */
type BotSdkCryptoInternals = {
  engine: {
    machine: { encryptRoomEvent(roomId: RoomId, type: string, content: string): Promise<string> };
    prepareEncrypt(roomId: string, roomInfo: unknown): Promise<void>;
    run(): Promise<void>;
  };
  roomTracker: { getRoomCryptoConfig(roomId: string): Promise<unknown> };
};

/**
 * Adapts a prepared bot-sdk crypto client to {@link HistoryCryptoEngine}. bot-sdk keeps its
 * engine and room tracker private, so they are reached through a typed cast (checked against
 * @vector-im/matrix-bot-sdk 0.10.1-element.0; re-check on upgrade).
 *
 * @param client - A client whose `crypto.prepare()` has completed.
 */
export function historyCryptoEngine(client: MatrixClient): HistoryCryptoEngine {
  const { engine, roomTracker } = client.crypto as unknown as BotSdkCryptoInternals;
  return {
    shareRoomKey: async (roomId) => engine.prepareEncrypt(roomId, await roomTracker.getRoomCryptoConfig(roomId)),
    encrypt: async (roomId, type, content) =>
      JSON.parse(await engine.machine.encryptRoomEvent(new RoomId(roomId), type, JSON.stringify(content))) as Record<
        string,
        unknown
      >,
    flush: () => engine.run(),
  };
}
