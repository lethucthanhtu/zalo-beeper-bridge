// Facade over zca-js: the ONLY module allowed to import zca-js runtime classes.
// Contains login lifecycle, listener resilience, normalization, and rate-limited sends.
import { EventEmitter } from 'node:events';
import FormData from 'form-data';
import {
  GroupMessage,
  Zalo,
  LoginQRCallbackEventType,
  ThreadType,
  type API,
  type Reactions,
  type GetCloudMessageResponse,
} from 'zca-js';
import { loadCredentials, saveCredentials, clearCredentials } from './credential-store.ts';
import { normalizeZaloMessage } from './event-normalizer.ts';
import { normalizeFriendPinEvent, normalizeGroupPinEvent } from './pin-events.ts';
import { normalizeGroupPollEvent, normalizePollDetail } from './poll-events.ts';
import { installFrameTap, waitForFileDone } from './frame-tap.ts';
import { ListenerManager } from './listener-manager.ts';
import { RateLimiter } from './rate-limiter.ts';
import type {
  RawZaloMessage,
  ZaloMention,
  ZaloMessage,
  ZaloPinEvent,
  ZaloPoll,
  ZaloPollCreate,
  ZaloPollEvent,
  ZaloProfile,
  ZaloQuotePayload,
  ZaloReactionEvent,
  ZaloSeenEvent,
  ZaloThreadType,
  ZaloTypingEvent,
} from './types.ts';
import { errorMessage } from '../error-message.ts';

/**
 * zca-js options for every login attempt. selfListen: own sends (any device) arrive with
 * isSelf=true, which echo suppression and double-puppeting rely on.
 */
const ZALO_OPTIONS = { selfListen: true, checkUpdate: false, logging: false };

type ZaloClientOptions = {
  credsPath: string;
  messagesPerMinute: number;
  burst?: number;
};

type ZaloClientEvents = {
  message: [message: ZaloMessage];
  seen: [event: ZaloSeenEvent];
  typing: [event: ZaloTypingEvent];
  reaction: [event: ZaloReactionEvent];
  pin: [event: ZaloPinEvent];
  poll: [event: ZaloPollEvent];
  connected: [];
  reconnecting: [attempt: number, delayMs: number];
  dead: [reason: string];
  loggedOut: [];
  /** the listener (re)connected and can page the recent feed: time to catch up missed messages */
  catchUp: [];
};

type ListenerState = 'stopped' | 'connected' | 'reconnecting' | 'dead';

/** zca-js ThreadType for a bridge thread type. */
const toThreadType = (threadType: ZaloThreadType) => (threadType === 'group' ? ThreadType.Group : ThreadType.User);
/** Bridge thread type for a zca-js ThreadType. */
const fromThreadType = (type: ThreadType): ZaloThreadType => (type === ThreadType.Group ? 'group' : 'user');

/** Profile fields of a zca-js getUserInfo entry; the alias wins over the account's Zalo name. */
function toProfile(raw: { displayName?: string; zaloName?: string; avatar?: string } | undefined): ZaloProfile | null {
  return raw ? { displayName: raw.displayName || raw.zaloName, avatarUrl: raw.avatar } : null;
}

/** msgIds of a sendMessage result: the text part (caption) and each attachment. */
function sentMsgIds(result: {
  message?: { msgId?: unknown } | null;
  attachment?: Array<{ msgId?: unknown }>;
}): string[] {
  return [result.message, ...(result.attachment ?? [])]
    .filter((part) => part?.msgId != null)
    .map((part) => String(part!.msgId));
}

/** Upper bound for one attachment upload/send to Zalo before the bridge gives up. */
const MEDIA_SEND_TIMEOUT_MS = 60_000;

/** Upper bound for Zalo's server-side logout (three HTTP round trips) before the bridge logs out locally anyway. */
const LOGOUT_TIMEOUT_MS = 15_000;

/** getCloudMessage error code meaning "the server has nothing more to load": stop paging. */
const CLOUD_NOTHING_MORE = -69;

/** ZALO_WS_TRACE=1 diagnostics for one getCloudMessage reply: cursor metadata only, never message content. */
function logCloudPage(groupId: string, cursor: string | undefined, page: GetCloudMessageResponse): void {
  const fields = page as unknown as Record<string, unknown>;
  const meta = [
    'error',
    'lastMsgId',
    'minMsgId',
    'maxMsgId',
    'hasMore',
    'isOld',
    'isFiltered',
    'tsJoinGroup',
    'isFilteredByPhase',
    'isFilteredByTimeJoin',
  ]
    .map((fieldName) => `${fieldName}=${String(fields[fieldName])}`)
    .join(' ');
  console.log(
    `[zalo:http] getCloudMessage ${groupId} cursor=${cursor ?? 'newest'} msgs=${page.groupMsgs.length} ${meta}`,
  );
}

/**
 * Rejects when `promise` has not settled within `ms` (default MEDIA_SEND_TIMEOUT_MS). zca-js
 * attachment uploads wait for a websocket "file_done" ack and never reject when it doesn't
 * come (e.g. the listener is down), which would leave the send — and the Beeper user — waiting
 * forever. The underlying request is not cancelled, only no longer awaited.
 *
 * @throws Error naming the step that timed out
 */
async function withSendTimeout<T>(promise: Promise<T>, step: string, ms = MEDIA_SEND_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${step} timed out after ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The bridge's single entry point to Zalo. Owns the zca-js API session (cookie / QR
 * login), the resilient websocket listener, normalization of inbound events into
 * the bridge's own types (re-emitted as typed events) and rate-limited outbound
 * sends. No other module may touch zca-js runtime classes directly.
 */
export class ZaloClient extends EventEmitter<ZaloClientEvents> {
  private api: API | null = null;
  private readonly listenerManager = new ListenerManager();
  private readonly rateLimiter: RateLimiter;
  private readonly startedAt = Date.now();
  private readonly opts: ZaloClientOptions;
  private listenerState: ListenerState = 'stopped';
  /** zca-js listeners whose handlers are already attached (see startListening) */
  private readonly wiredListeners = new WeakSet<object>();
  private loginInFlight = false;
  private historyCapture: { type: ThreadType; resolve: (batch: ZaloMessage[]) => void } | null = null;
  // After a history request times out, its late reply is dropped instead of being
  // emitted live (unsorted) or mistaken for the next request's page
  private readonly discardLateHistoryUntil = new Map<ThreadType, number>();

  /**
   * Creates a logged-out client and wires the listener manager's lifecycle events
   * to `listenerState` and to this emitter's `connected` / `reconnecting` / `dead`.
   *
   * @param options credentials file path and outbound rate-limit settings
   * @throws when `options.messagesPerMinute` is not positive (from RateLimiter)
   */
  constructor(options: ZaloClientOptions) {
    super();
    this.opts = options;
    this.rateLimiter = new RateLimiter(options.messagesPerMinute, options.burst);
    this.listenerManager.on('connected', () => {
      this.listenerState = 'connected';
      this.emit('connected');
    });
    this.listenerManager.on('reconnecting', (attempt, delayMs) => {
      this.listenerState = 'reconnecting';
      this.emit('reconnecting', attempt, delayMs);
    });
    this.listenerManager.on('dead', (reason) => {
      // Session is unusable — drop it so 'login' works as the recovery path
      this.listenerState = 'dead';
      this.listenerManager.stop();
      this.api = null;
      this.emit('dead', reason);
    });
  }

  /** True while a zca-js API session is held (cleared on logout or listener death). */
  get isLoggedIn(): boolean {
    return this.api !== null;
  }

  /** Zalo uid of the logged-in account, or null when logged out. */
  get ownId(): string | null {
    return this.api?.getOwnId() ?? null;
  }

  /** Snapshot for health/status reporting: login state, own uid, listener state and process uptime. */
  get status(): { loggedIn: boolean; ownId: string | null; listener: ListenerState; uptimeMs: number } {
    return {
      loggedIn: this.isLoggedIn,
      ownId: this.ownId,
      listener: this.listenerState,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /**
   * Cookie re-login from saved credentials (no QR). Reads the encrypted credentials
   * file and, on success, stores the new API session.
   *
   * @returns false when the credentials are absent/invalid or Zalo rejects them (logged)
   */
  async loginFromSavedCredentials(): Promise<boolean> {
    const creds = loadCredentials(this.opts.credsPath);
    if (!creds) return false;
    try {
      this.api = await new Zalo(ZALO_OPTIONS).login(creds);
      return true;
    } catch (err) {
      console.warn('Zalo cookie re-login failed:', errorMessage(err));
      return false;
    }
  }

  /**
   * Interactive QR login. deliverQrPng is called with the QR image (PNG buffer)
   * for display in the Matrix management room. Resolves once logged in.
   * Only one QR login may run at a time.
   *
   * @throws when a QR login is already in progress, or the QR was declined / expired too often
   */
  async loginWithQR(deliverQrPng: (png: Buffer) => Promise<void>): Promise<void> {
    if (this.loginInFlight) throw new Error('A QR login is already in progress — scan the existing QR');
    this.loginInFlight = true;
    try {
      await this.doLoginWithQR(deliverQrPng);
    } finally {
      this.loginInFlight = false;
    }
  }

  /**
   * Runs the zca-js QR flow: delivers each generated QR, retries an expired QR at most
   * twice, aborts on decline, and persists the credentials (encrypted) as soon as
   * Zalo hands them over so the next start can cookie-login.
   *
   * @throws when zca-js returns no API (QR expired too often or declined)
   */
  private async doLoginWithQR(deliverQrPng: (png: Buffer) => Promise<void>): Promise<void> {
    let qrRetries = 0;
    const api = await new Zalo(ZALO_OPTIONS).loginQR({}, (event) => {
      switch (event.type) {
        case LoginQRCallbackEventType.QRCodeGenerated:
          // event.data.image is raw base64 PNG (data-URI prefix already stripped by zca-js)
          void deliverQrPng(Buffer.from(event.data.image, 'base64')).catch((err: unknown) =>
            console.error('Failed to deliver QR image:', err),
          );
          break;
        case LoginQRCallbackEventType.QRCodeExpired:
          if (++qrRetries <= 2) event.actions.retry();
          else event.actions.abort();
          break;
        case LoginQRCallbackEventType.QRCodeDeclined:
          event.actions.abort();
          break;
        case LoginQRCallbackEventType.GotLoginInfo: {
          const { cookie, imei, userAgent } = event.data;
          saveCredentials(this.opts.credsPath, { cookie, imei, userAgent });
          break;
        }
      }
    });
    if (!api) throw new Error('QR login aborted (expired or declined)');
    this.api = api;
  }

  /**
   * Attaches all zca-js listener handlers and starts the resilient listener.
   * Inbound messages, history batches, seen receipts, typing and reactions are
   * normalized and re-emitted on this client. Also installs the websocket frame tap
   * on every (re)connect and requests a missed-message catch-up once the session
   * key arrives.
   *
   * @throws when not logged in
   */
  startListening(): void {
    if (!this.api) throw new Error('Not logged in');
    const listener = this.api.listener;
    // Handlers are attached once per zca-js listener: wiring the same listener twice
    // would emit every message, receipt and reaction twice (callers start listening
    // after each login, which creates a fresh listener)
    if (this.wiredListeners.has(listener)) {
      this.listenerState = 'reconnecting'; // until first "connected", as for a fresh listener
      this.listenerManager.start(this.api);
      return;
    }
    this.wiredListeners.add(listener);
    this.listenerState = 'reconnecting'; // until first "connected"
    // zca-js opens a fresh websocket per (re)connect — tap each one (E2EE DM reroute)
    listener.on('connected', () => installFrameTap(listener));
    // Zalo does not re-push messages missed while disconnected (sleep, restart, network
    // drop). Once the session key arrives the feed can be paged: signal the catch-up
    // (SyncManager.catchUp pages back until it meets an already-bridged message)
    listener.on('cipher_key', () => {
      setTimeout(() => {
        if (this.api?.listener === listener) this.emit('catchUp');
      }, 2_000);
    });
    this.api.listener.on('message', (raw) => {
      const normalized = normalizeZaloMessage(raw as unknown as RawZaloMessage);
      if (normalized) this.emit('message', normalized);
    });
    // Recall for everyone (by a contact or by us on another device). Same per-thread queue
    // and msgId dedup as messages; the normalizer maps content.deleteMsg to kind 'recall'
    this.api.listener.on('undo', (undo) => {
      const normalized = normalizeZaloMessage({
        type: undo.isGroup ? ThreadType.Group : ThreadType.User,
        threadId: undo.threadId,
        isSelf: undo.isSelf,
        data: undo.data as unknown as RawZaloMessage['data'],
      });
      if (normalized) this.emit('message', normalized);
    });
    // Zalo pushes recent messages per thread on connect — replay them through the
    // same pipeline (store-level msgId dedup makes this idempotent across restarts)
    this.api.listener.on('old_messages', (messages, type) => {
      const normalizedBatch = (messages as unknown as RawZaloMessage[])
        .map((raw) => normalizeZaloMessage(raw))
        .filter((message): message is ZaloMessage => message !== null);
      console.log(
        `[zalo] history batch type=${type === ThreadType.Group ? 'group' : 'user'} raw=${messages.length} usable=${normalizedBatch.length}`,
      );
      // A history page requested by sync is handed to its waiter (which replays it
      // oldest-first) instead of being emitted out of order here
      const capture = this.historyCapture;
      if (capture && capture.type === type) {
        this.historyCapture = null;
        capture.resolve(normalizedBatch);
        return;
      }
      if ((this.discardLateHistoryUntil.get(type) ?? 0) > Date.now()) {
        this.discardLateHistoryUntil.delete(type);
        return;
      }
      // Catch-up replay: oldest-first so a gap is filled in order (store dedups by msgId)
      for (const normalized of normalizedBatch.sort((a, b) => a.timestamp - b.timestamp))
        this.emit('message', normalized);
    });
    this.api.listener.on('seen_messages', (seenList) => {
      for (const seen of seenList) {
        if (!seen?.data?.msgId) continue;
        this.emit('seen', {
          threadId: String(seen.threadId),
          threadType: fromThreadType(seen.type),
          msgId: String(seen.data.msgId),
          // Coerce: Zalo sends numeric uids here; own-uid filtering compares strings
          seenUids: ('seenUids' in seen.data ? seen.data.seenUids : []).map(String),
        });
      }
    });
    this.api.listener.on('typing', (typing) => {
      if (!typing?.data?.uid) return;
      this.emit('typing', {
        threadId: typing.threadId,
        threadType: fromThreadType(typing.type),
        uid: String(typing.data.uid),
      });
    });
    this.api.listener.on('reaction', (reaction) => {
      const targetMsgId = reaction?.data?.content?.rMsg?.[0]?.gMsgID;
      if (!targetMsgId || !reaction.data.uidFrom) return;
      this.emit('reaction', {
        threadId: String(reaction.threadId),
        threadType: reaction.isGroup ? 'group' : 'user',
        senderId: String(reaction.data.uidFrom),
        senderName: reaction.data.dName || undefined,
        isSelf: reaction.isSelf === true,
        targetMsgId: String(targetMsgId),
        icon: reaction.data.content.rIcon ?? '',
      });
    });
    // Pins: a group pin is a group_event, a DM pin a friend_event (zca-js emits both on the same listener).
    // Group polls are board group_events too
    listener.on('group_event', (groupEvent) => {
      const pin = normalizeGroupPinEvent(groupEvent);
      if (pin) this.emit('pin', pin);
      const poll = normalizeGroupPollEvent(groupEvent);
      if (poll) this.emit('poll', poll);
    });
    listener.on('friend_event', (friendEvent) => {
      const pin = normalizeFriendPinEvent(friendEvent);
      if (pin) this.emit('pin', pin);
    });
    this.listenerManager.start(this.api);
  }

  /** Stops the listener (no automatic restarts) and marks the listener state as stopped. The session stays logged in. */
  private stopListening(): void {
    this.listenerManager.stop();
    this.listenerState = 'stopped';
  }

  /**
   * Stops listening, asks Zalo to end the session (zca-js `logout`, which expires the session
   * cookies server-side), then drops the API session and deletes the saved credentials and
   * their key file from disk. The local logout always happens, even when the server call
   * fails or times out. The session is held until the server call settles, so a `login`
   * during the wait is refused instead of having its fresh credentials wiped.
   *
   * @returns whether Zalo confirmed the server-side logout, and the error when it did not
   */
  async logout(): Promise<{ serverLoggedOut: boolean; error?: string }> {
    const api = this.api;
    this.stopListening();
    let result: { serverLoggedOut: boolean; error?: string } = { serverLoggedOut: false };
    if (api) {
      try {
        await withSendTimeout(api.logout(), 'Zalo logout', LOGOUT_TIMEOUT_MS);
        result = { serverLoggedOut: true };
      } catch (err) {
        result = { serverLoggedOut: false, error: errorMessage(err) };
        console.warn('Zalo server logout failed (logging out locally anyway):', result.error);
      }
    }
    this.api = null;
    clearCredentials(this.opts.credsPath);
    this.emit('loggedOut');
    return result;
  }

  /**
   * Contact profile (name + avatar URL) via zca-js getUserInfo; null when unavailable.
   * Falls back to the account's Zalo name when no display name (alias) is set.
   * Network errors are logged, never thrown.
   */
  async getUserProfile(uid: string): Promise<ZaloProfile | null> {
    if (!this.api) return null;
    try {
      const info = await this.api.getUserInfo(uid);
      return toProfile(info.changed_profiles[uid]);
    } catch (err) {
      console.warn(`getUserInfo(${uid}) failed:`, errorMessage(err));
      return null;
    }
  }

  /**
   * Profiles of several contacts in one zca-js getUserInfo call (it accepts a list).
   * Contacts Zalo returns nothing for (deleted / blocked accounts) are absent from the map.
   *
   * @throws when not logged in or the lookup fails (callers retry later)
   */
  async getUserProfiles(uids: string[]): Promise<Map<string, ZaloProfile>> {
    if (!this.api) throw new Error('Not logged in');
    const info = await this.api.getUserInfo(uids);
    const profiles = new Map<string, ZaloProfile>();
    for (const uid of uids) {
      const profile = toProfile(info.changed_profiles[uid]);
      if (profile) profiles.set(uid, profile);
    }
    return profiles;
  }

  /**
   * Sticker image URL (prefers animated webp) via getStickersDetail.
   *
   * @returns null when logged out, the sticker is unknown, or the request fails (logged)
   */
  async getStickerImageUrl(stickerId: number): Promise<string | null> {
    if (!this.api) return null;
    try {
      const details = await this.api.getStickersDetail(stickerId);
      const sticker = details[0];
      return sticker?.stickerWebpUrl || sticker?.stickerUrl || null;
    } catch (err) {
      console.warn(`getStickersDetail(${stickerId}) failed:`, errorMessage(err));
      return null;
    }
  }

  /** Thread ids the user pinned in Zalo (conversation sync targets). [] when logged out or on failure (logged). */
  async getPinnedThreadIds(): Promise<string[]> {
    if (!this.api) return [];
    try {
      return (await this.api.getPinConversations()).conversations ?? [];
    } catch (err) {
      console.warn('getPinConversations failed:', errorMessage(err));
      return [];
    }
  }

  /** All group ids the account belongs to. null = fetch FAILED (callers must not treat as "no groups"). */
  async getAllGroupIds(): Promise<string[] | null> {
    if (!this.api) return null;
    try {
      return Object.keys((await this.api.getAllGroups()).gridVerMap ?? {});
    } catch (err) {
      console.warn('getAllGroups failed:', errorMessage(err));
      return null;
    }
  }

  /**
   * Recent group history, normalized and sorted oldest-first (best-effort backfill).
   * zca-js getGroupChatHistory hits /api/group/history, which Zalo removed (404,
   * zca-js issues #356/#367); this uses zca-js getCloudMessage, the cloud-message
   * endpoint Zalo Web uses now, which returns up to 50 messages per call, newest-first.
   * The first call can come back empty with only the cursor metadata, so the next call
   * starts from maxMsgId, then pages back through lastMsgId while hasMore. At most 4
   * calls are made and only the newest `count` messages are kept. Zalo's "nothing more"
   * answer (error -69, or an empty filtered page) ends paging quietly; any other failure
   * keeps whatever pages were already fetched (logged, never thrown). With ZALO_WS_TRACE=1
   * each reply's cursor metadata is logged (never message content).
   *
   * @param threadId Zalo group id
   * @param count desired number of messages (upper bound, not guaranteed)
   */
  async getGroupHistory(threadId: string, count = 30): Promise<ZaloMessage[]> {
    const api = this.api;
    if (!api) return [];
    const rawMessagesById = new Map<string, GroupMessage>();
    try {
      let cursor: string | undefined;
      let isOld: number | undefined;
      for (let call = 0; call < 4 && rawMessagesById.size < count; call++) {
        const page = await api.getCloudMessage(threadId, cursor, isOld ? { isOld } : undefined);
        if (process.env.ZALO_WS_TRACE === '1') logCloudPage(threadId, cursor, page);
        for (const msg of page.groupMsgs) rawMessagesById.set(String(msg.data.msgId), msg);
        if (page.groupMsgs.length === 0 && page.isFiltered) break;
        const next =
          page.groupMsgs.length === 0 && cursor === undefined ? page.maxMsgId : page.hasMore ? page.lastMsgId : null;
        const nextCursor = next == null ? null : String(next);
        if (!nextCursor || nextCursor === '0' || nextCursor === cursor) break;
        cursor = nextCursor;
        isOld = page.isOld;
      }
    } catch (err) {
      if ((err as { code?: unknown }).code !== CLOUD_NOTHING_MORE)
        console.warn(`group history (${threadId}) failed:`, errorMessage(err));
    }
    return [...rawMessagesById.values()]
      .map((msg) => normalizeZaloMessage(msg as unknown as RawZaloMessage))
      .filter((message): message is ZaloMessage => message !== null)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-count);
  }

  /**
   * One page of messages across ALL threads of a type (what Zalo Web loads to build its
   * conversation list — the only way to discover DM threads). The feed runs FORWARD:
   * Zalo returns up to 50 messages after `afterMsgId`, oldest first, and with no cursor
   * starts at the beginning of its ~1-week window (measured live 2026-10-31). Pass the
   * newest msgId of the previous page to continue. null = no answer (timeout, not
   * listening); [] = nothing newer.
   *
   * The reply arrives asynchronously as an `old_messages` listener event, so the
   * request parks a one-shot `historyCapture` that the handler resolves. Only one
   * request may be outstanding; on timeout, the next unrequested reply of this thread
   * type arriving within 60 s is treated as the late reply and discarded.
   *
   * @param threadType which feed to page through (DMs or groups)
   * @param afterMsgId cursor: newest msgId already seen, or null for the start of the window
   * @param timeoutMs how long to wait for the websocket reply
   */
  async fetchRecentMessagesPage(
    threadType: ZaloThreadType,
    afterMsgId: string | null,
    timeoutMs = 15_000,
  ): Promise<ZaloMessage[] | null> {
    const api = this.api;
    if (!api || this.listenerState !== 'connected' || this.historyCapture) return null;
    const type = toThreadType(threadType);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.historyCapture?.resolve === done) this.historyCapture = null;
        this.discardLateHistoryUntil.set(type, Date.now() + 60_000);
        resolve(null);
      }, timeoutMs);
      /** Resolves the page with the captured batch and cancels the timeout. */
      const done = (batch: ZaloMessage[]) => {
        clearTimeout(timer);
        resolve(batch);
      };
      this.historyCapture = { type, resolve: done };
      try {
        api.listener.requestOldMessages(type, afterMsgId);
      } catch (err) {
        console.warn('requestOldMessages failed:', errorMessage(err));
        this.historyCapture = null;
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /**
   * Fetches one recent message again, so its media links are fresh (Zalo's signed CDN
   * links expire). A group message is looked up in the newest 200 messages of its group
   * (getCloudMessage); a DM is read from the cross-thread DM feed, which starts right
   * after the cursor `msgId - 1` and covers about one week. null when the message is out
   * of reach, Zalo does not answer, or the listener is busy; never throws.
   *
   * @param threadId Zalo thread id of the message
   * @param threadType whether the thread is a DM or a group
   * @param msgId Zalo message id to find
   */
  async fetchMessage(threadId: string, threadType: ZaloThreadType, msgId: string): Promise<ZaloMessage | null> {
    if (threadType === 'group') {
      const history = await this.getGroupHistory(threadId, 200);
      return history.find((message) => message.msgId === msgId) ?? null;
    }
    let cursor: string;
    try {
      cursor = String(BigInt(msgId) - 1n);
    } catch {
      return null; // not a numeric id: no cursor can point just before it
    }
    const page = await this.fetchRecentMessagesPage('user', cursor);
    return page?.find((message) => message.msgId === msgId && message.threadId === threadId) ?? null;
  }

  /** Group display name via zca-js getGroupInfo; null when unavailable (errors logged, never thrown). */
  async getGroupName(threadId: string): Promise<string | null> {
    if (!this.api) return null;
    try {
      const info = await this.api.getGroupInfo(threadId);
      const name = (info.gridInfoMap[threadId] as { name?: string } | undefined)?.name;
      return name || null;
    } catch (err) {
      console.warn(`getGroupInfo(${threadId}) failed:`, errorMessage(err));
      return null;
    }
  }

  /**
   * React to a Zalo message (Beeper→Zalo). Not rate-limited — it's a control action, not a message.
   * `icon` is a Zalo icon code (see reaction-map `emojiToZalo`); `Reactions.NONE` ("")
   * removes all of the account's reactions on the message.
   *
   * @throws when not logged in, or when the zca-js call fails
   */
  async react(
    threadId: string,
    threadType: ZaloThreadType,
    msgId: string,
    cliMsgId: string,
    icon: string,
  ): Promise<void> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await api.addReaction(icon as Reactions, {
      data: { msgId, cliMsgId },
      threadId,
      type: toThreadType(threadType),
    });
  }

  /**
   * Create a poll in a group (Beeper→Zalo). Rate-limited like a message: it posts to the group.
   *
   * @returns the created poll, with Zalo's option ids
   * @throws when not logged in, when the zca-js call fails, or when Zalo's reply is not a poll
   */
  async createPoll(groupId: string, poll: ZaloPollCreate): Promise<ZaloPoll> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await this.rateLimiter.acquire();
    const detail = await api.createPoll(
      { question: poll.question, options: poll.options, allowMultiChoices: poll.multiChoice },
      groupId,
    );
    const created = normalizePollDetail(detail);
    if (!created) throw new Error('Zalo returned an unexpected poll reply');
    return created;
  }

  /**
   * Poll options and per-option voters. Not rate-limited — a read.
   *
   * @returns null when Zalo's reply is not a poll
   * @throws when not logged in, or when the zca-js call fails
   */
  async getPollDetail(pollId: number): Promise<ZaloPoll | null> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    return normalizePollDetail(await api.getPollDetail(pollId));
  }

  /**
   * Set the account's vote on a poll (Beeper→Zalo); an empty list removes the vote.
   * Rate-limited: a vote is visible to the whole group.
   *
   * @throws when not logged in, or when the zca-js call fails
   */
  async votePoll(pollId: number, optionIds: number[]): Promise<void> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await this.rateLimiter.acquire();
    await api.votePoll(pollId, optionIds);
  }

  /**
   * Lock a poll so nobody can vote any more (Beeper→Zalo). Not rate-limited — a control action.
   *
   * @throws when not logged in, or when the zca-js call fails
   */
  async lockPoll(pollId: number): Promise<void> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await api.lockPoll(pollId);
  }

  /**
   * Recall (undo) a message we sent (Beeper→Zalo). Not rate-limited — a control action, and delay is user-visible.
   *
   * @throws when not logged in, or when the zca-js call fails
   */
  async recall(threadId: string, threadType: ZaloThreadType, msgId: string, cliMsgId: string): Promise<void> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await api.undo({ msgId, cliMsgId }, threadId, toThreadType(threadType));
  }

  /**
   * Mark a message seen on Zalo (Beeper read → Zalo "seen"). Best-effort, no rate limit.
   * senderId is the original sender (peer for DM); for a DM, uidFrom must be the peer
   * and idTo the account itself. st/at/cmd/ts are always sent as 0 (accepted by Zalo).
   * No-op when logged out; failures are logged, never thrown.
   *
   * @param msgType raw Zalo msgType of the seen message (defaults to 'webchat' when empty)
   */
  async sendSeen(
    threadId: string,
    threadType: ZaloThreadType,
    msgId: string,
    cliMsgId: string,
    senderId: string,
    msgType: string,
  ): Promise<void> {
    const api = this.api;
    if (!api) return;
    const isGroup = threadType === 'group';
    // A DM seen is addressed to our own uid; without it the event would go out with an
    // empty recipient — skip instead (the next read after login sends it)
    if (!isGroup && !this.ownId) return;
    try {
      await api.sendSeenEvent(
        {
          msgId,
          cliMsgId,
          uidFrom: senderId,
          idTo: isGroup ? threadId : (this.ownId ?? ''),
          msgType: msgType || 'webchat',
          st: 0,
          at: 0,
          cmd: 0,
          ts: 0,
        },
        toThreadType(threadType),
      );
    } catch (err) {
      console.warn('sendSeenEvent failed:', errorMessage(err));
    }
  }

  /** Show "typing" on Zalo (Beeper owner typing → Zalo). Best-effort: no-op when logged out, errors swallowed. */
  async sendTyping(threadId: string, threadType: ZaloThreadType): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      await api.sendTypingEvent(threadId, toThreadType(threadType));
    } catch {
      // typing is fire-and-forget
    }
  }

  /**
   * Send an image (Beeper→Zalo) as a message with an attachment. uploadAttachment
   * only uploads to the CDN without posting to the thread, so we send via
   * sendMessage's `attachments` field (which uploads + delivers). Returns the sent
   * msgId(s) for echo suppression. Waits for the outbound rate limiter.
   *
   * @param data image bytes
   * @param filename must carry an extension (zca-js routes by it)
   * @param caption optional text sent with the image
   * @throws when not logged in, or when the zca-js send fails
   */
  async sendImage(
    threadId: string,
    threadType: ZaloThreadType,
    data: Buffer,
    filename: `${string}.${string}`,
    width: number,
    height: number,
    caption = '',
  ): Promise<string[]> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await this.rateLimiter.acquire();
    const sendResult = await withSendTimeout(
      api.sendMessage(
        { msg: caption, attachments: [{ data, filename, metadata: { totalSize: data.byteLength, width, height } }] },
        threadId,
        toThreadType(threadType),
      ),
      'image send',
    );
    return sentMsgIds(sendResult);
  }

  /**
   * Send a non-image attachment (video/file/audio) Beeper→Zalo via sendMessage.
   * zca-js routes by the filename extension: .mp4 → video, others → file.
   * Waits for the outbound rate limiter.
   *
   * @returns the sent msgId(s) (text part and attachment part) for echo suppression
   * @throws when not logged in, or when the zca-js send fails
   */
  async sendFile(
    threadId: string,
    threadType: ZaloThreadType,
    data: Buffer,
    filename: `${string}.${string}`,
    caption = '',
  ): Promise<string[]> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await this.rateLimiter.acquire();
    const sendResult = await withSendTimeout(
      api.sendMessage(
        { msg: caption, attachments: [{ data, filename, metadata: { totalSize: data.byteLength } }] },
        threadId,
        toThreadType(threadType),
      ),
      'file send',
    );
    return sentMsgIds(sendResult);
  }

  /**
   * Send a voice note Beeper→Zalo as a native Zalo voice message (not a file).
   * Uploads the way Zalo's own clients do (`voice/upload`, which stores the audio on
   * Zalo's voice CDN), takes the voice URLs from the upload's websocket `file_done`, then
   * posts the message. When that upload fails, falls back to zca-js uploadAttachment
   * (generic file CDN): Zalo PC plays such a note, the mobile apps show it as
   * "not on the cloud" and don't play it. Waits for the outbound rate limiter.
   *
   * @param data AAC audio bytes (raw ADTS, as Zalo's clients record it, or m4a)
   * @param filename must end in .aac or .m4a
   * @returns the sent msgId for echo suppression / recall
   * @throws when not logged in, both uploads yield no URL, or a zca-js call fails
   */
  async sendVoice(
    threadId: string,
    threadType: ZaloThreadType,
    data: Buffer,
    filename: `${string}.${string}`,
  ): Promise<string[]> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    const zaloThreadType = toThreadType(threadType);
    await this.rateLimiter.acquire();
    let urls: VoiceUrls;
    try {
      urls = await withSendTimeout(
        uploadVoiceNative(api, { data, filename, threadId, type: zaloThreadType }),
        'voice upload',
      );
    } catch (err) {
      console.warn(`[zalo] native voice upload failed, sending via the file CDN: ${errorMessage(err)}`);
      const [uploaded] = await withSendTimeout(
        api.uploadAttachment([{ data, filename, metadata: { totalSize: data.byteLength } }], threadId, zaloThreadType),
        'voice upload',
      );
      if (!uploaded || uploaded.fileType === 'image' || !uploaded.fileUrl) {
        throw new Error('voice upload returned no file URL');
      }
      urls = { voiceUrl: uploaded.fileUrl, m4aUrl: uploaded.fileUrl };
    }
    const sent = await withSendTimeout(
      sendVoiceMessage(api, { ...urls, fileSize: data.byteLength, threadId, type: zaloThreadType }),
      'voice send',
    );
    return sent?.msgId != null ? [String(sent.msgId)] : [];
  }

  /**
   * Rate-limited text send with optional quote. Returns Zalo msgId (echo-suppression key).
   * onBeforeSend fires AFTER the rate-limit wait, immediately before the network call —
   * echo-suppression TTLs must start at real send time, not enqueue time.
   *
   * A text with a link is sent as a Zalo link card when Zalo can build a real preview
   * (a title or thumbnail), so it doesn't show an empty "failed" card. Beeper's own
   * preview (`preview`) overrides the card text so both sides show the same; when the
   * owner removed the preview in Beeper (`preview === null`) the text goes out plain.
   *
   * @param quote raw payload of the message being replied to (Matrix reply → Zalo quote)
   * @param mentions @mentions (uid + position/length in `text`)
   * @param preview Beeper's link preview of the message, null when removed, undefined when unknown
   * @throws when not logged in, or when the zca-js send fails
   */
  async sendText(
    threadId: string,
    threadType: ZaloThreadType,
    text: string,
    quote?: ZaloQuotePayload,
    onBeforeSend?: () => void,
    mentions?: ZaloMention[],
    preview?: LinkPreviewHint | null,
  ): Promise<{ msgId: string | null }> {
    // Capture before the rate-limit wait — logout during the wait must not null-deref
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await this.rateLimiter.acquire();
    onBeforeSend?.();
    const zaloType = toThreadType(threadType);
    // A plain sendMessage link shows no preview on Zalo; a link card does. Cards take no
    // quote/mentions, so those messages stay plain text.
    const link =
      !quote && !mentions?.length && preview !== null
        ? preview?.url && text.includes(preview.url)
          ? preview.url
          : firstLink(text)
        : undefined;
    // Probe first: an unparseable link, or one Zalo can't preview, goes out as plain text.
    // A failed card send itself is not retried — Zalo may already have delivered it.
    const parsed = link ? await api.parseLink(link).catch(() => null) : null;
    if (link && parsed) {
      const data: Partial<ParseLinkData> = parsed.data ?? {};
      const title = preview?.title || data.title || '';
      const description = preview?.description || data.desc || '';
      if (!preview && (data.title || data.thumb)) {
        const sent = await api.sendLink({ msg: text, link }, threadId, zaloType);
        return { msgId: sent?.msgId != null ? String(sent.msgId) : null };
      }
      if (preview && (title || data.thumb)) {
        const sent = await sendLinkCard(api, {
          msg: text,
          threadId,
          type: zaloType,
          card: { ...data, href: data.href || link, title, desc: description },
        });
        return { msgId: sent?.msgId != null ? String(sent.msgId) : null };
      }
    }
    // A quote and/or mentions require the object form of MessageContent
    const payload =
      quote || mentions?.length
        ? { msg: text, ...(quote ? { quote: quote as never } : {}), ...(mentions?.length ? { mentions } : {}) }
        : text;
    const result = await api.sendMessage(payload, threadId, zaloType);
    return { msgId: result.message?.msgId != null ? String(result.message.msgId) : null };
  }
}

/** Beeper's preview of a link in an outbound message (`com.beeper.linkpreviews`). */
export type LinkPreviewHint = { url: string; title?: string; description?: string };

/** Card fields Zalo's parseLink returns (zca-js ParseLinkResponse['data']). */
type ParseLinkData = {
  thumb: string;
  title: string;
  desc: string;
  src: string;
  href: string;
  media: unknown;
};

/** First http(s) URL in `text`, without trailing sentence punctuation. */
function firstLink(text: string): string | undefined {
  const url = text.match(/https?:\/\/\S+/)?.[0]?.replace(/[.,;:!?'"]+$/, '');
  // a closing bracket ends the sentence unless the URL opened one (wiki-style "Foo_(bar)")
  return url?.endsWith(')') && !url.includes('(') ? url.slice(0, -1) : url;
}

type LinkCardProps = { msg: string; threadId: string; type: ThreadType; card: Partial<ParseLinkData> };

/** Voice note URLs as Zalo's clients post them: `voiceUrl` (amr, else aac) and `m4aUrl` (aac). */
type VoiceUrls = { voiceUrl: string; m4aUrl: string };
type VoiceProps = VoiceUrls & { fileSize: number; threadId: string; type: ThreadType };
type VoiceUploadProps = { data: Buffer; filename: string; threadId: string; type: ThreadType };
/** Last-chunk response of a voice upload (URL fields only on some servers). */
type VoiceUploadResponse = { fileId?: string | number } & Record<string, unknown>;

const VOICE_API = 'bridgeSendVoice';
const VOICE_UPLOAD_API = 'bridgeUploadVoice';
/** APIs that already have the custom voice calls (zca-js custom() defines a non-configurable property). */
const voiceApiInstalled = new WeakSet<API>();
const voiceUploadApiInstalled = new WeakSet<API>();
/** How long to wait for the upload's websocket file_done after the last chunk. */
const VOICE_FILE_DONE_TIMEOUT_MS = 60_000;

/** voiceUrl/m4aUrl from an upload response or file_done data; null when it has no URL. */
export function pickVoiceUrls(data: Record<string, unknown> | null | undefined): VoiceUrls | null {
  const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const aac = str(data?.aac) ?? str(data?.url);
  const amr = str(data?.amr);
  const voiceUrl = amr ?? aac;
  return voiceUrl ? { voiceUrl, m4aUrl: aac ?? voiceUrl } : null;
}

/**
 * The multipart body of one upload chunk (`chunkContent`), built with form-data exactly as
 * zca-js uploadAttachment does: Zalo's voice endpoint rejects a hand-built body (error 115).
 */
export function chunkForm(chunk: Buffer, filename: string): { body: Buffer; headers: Record<string, string> } {
  const form = new FormData();
  form.append('chunkContent', chunk, { filename, contentType: 'application/octet-stream' });
  return { body: form.getBuffer(), headers: form.getHeaders() as Record<string, string> };
}

/**
 * Uploads a voice note to Zalo's voice endpoint (`/api/{message|group}/voice/upload`, the
 * one Zalo PC uses) and returns its voice URLs — from the last chunk's response when it
 * has them, else from the websocket file_done (see frame-tap waitForFileDone).
 *
 * @throws when a chunk request fails, the server returns no file id, or file_done never comes
 */
async function uploadVoiceNative(api: API, props: VoiceUploadProps): Promise<VoiceUrls> {
  if (!voiceUploadApiInstalled.has(api)) {
    api.custom<VoiceUploadResponse | null, VoiceUploadProps>(VOICE_UPLOAD_API, async ({ ctx, utils, props: p }) => {
      const group = p.type === ThreadType.Group;
      const chunkSize = ctx.settings?.features?.sharefile?.chunk_size_file || 2 * 1024 * 1024;
      const totalChunk = Math.max(1, Math.ceil(p.data.byteLength / chunkSize));
      const base = {
        ...(group ? { grid: p.threadId } : { toid: p.threadId }),
        totalChunk,
        fileName: p.filename,
        clientId: Date.now(),
        totalSize: p.data.byteLength,
        imei: ctx.imei,
        isE2EE: 0,
        fileType: p.filename.toLowerCase().endsWith('.amr') ? 'amr' : 'aac',
      };
      let last: VoiceUploadResponse | null = null;
      for (let chunkId = 1; chunkId <= totalChunk; chunkId++) {
        const encrypted = utils.encodeAES(JSON.stringify({ ...base, chunkId }));
        if (!encrypted) throw new Error('Failed to encrypt voice upload params');
        const url = utils.makeURL(`${api.zpwServiceMap.file[0]}/api/${group ? 'group' : 'message'}/voice/upload`, {
          type: group ? 11 : 2,
          params: encrypted,
        });
        const form = chunkForm(p.data.subarray((chunkId - 1) * chunkSize, chunkId * chunkSize), p.filename);
        const response = await utils.request(url, {
          method: 'POST',
          headers: form.headers,
          body: form.body as unknown as BodyInit, // a Buffer, as zca-js sends it
        });
        last = (await utils.resolve(response)) as VoiceUploadResponse | null;
      }
      return last;
    });
    voiceUploadApiInstalled.add(api);
  }
  const call = (api as unknown as Record<string, (p: VoiceUploadProps) => Promise<VoiceUploadResponse | null>>)[
    VOICE_UPLOAD_API
  ];
  const uploaded = await call!(props);
  console.log(`[zalo] voice upload response fields: ${Object.keys(uploaded ?? {}).join(',') || '(none)'}`);
  const direct = pickVoiceUrls(uploaded);
  if (direct) return direct;
  const fileId = uploaded?.fileId;
  if (fileId == null || String(fileId) === '-1') throw new Error('voice upload returned no file id');
  const done = await waitForFileDone(String(fileId), VOICE_FILE_DONE_TIMEOUT_MS);
  console.log(`[zalo] voice file_done fields: ${Object.keys(done).join(',') || '(none)'}`);
  const urls = pickVoiceUrls(done);
  if (!urls) throw new Error('voice file_done had no URL');
  return urls;
}

/**
 * Posts an uploaded voice note (msgType 3 via `forward`) with the fields Zalo's clients
 * send: `{voiceUrl, m4aUrl, fileSize}`. Registered through zca-js `api.custom`.
 */
async function sendVoiceMessage(api: API, props: VoiceProps): Promise<{ msgId?: string | number } | null> {
  if (!voiceApiInstalled.has(api)) {
    api.custom<{ msgId?: string | number } | null, VoiceProps>(VOICE_API, async ({ ctx, utils, props: p }) => {
      const group = p.type === ThreadType.Group;
      const url = utils.makeURL(`${api.zpwServiceMap.file[0]}/api/${group ? 'group' : 'message'}/forward`);
      const params: Record<string, unknown> = {
        ttl: 0,
        zsource: -1,
        msgType: 3,
        clientId: Date.now().toString(),
        msgInfo: JSON.stringify({ voiceUrl: p.voiceUrl, m4aUrl: p.m4aUrl, fileSize: p.fileSize }),
        imei: ctx.imei,
        ...(group ? { grid: p.threadId, visibility: 0 } : { toId: p.threadId }),
      };
      const encrypted = utils.encodeAES(JSON.stringify(params));
      if (!encrypted) throw new Error('Failed to encrypt voice params');
      const response = await utils.request(url, { method: 'POST', body: new URLSearchParams({ params: encrypted }) });
      return utils.resolve(response) as Promise<{ msgId?: string | number } | null>;
    });
    voiceApiInstalled.add(api);
  }
  const call = (api as unknown as Record<string, (p: VoiceProps) => Promise<{ msgId?: string | number } | null>>)[
    VOICE_API
  ];
  return call!(props);
}

const CARD_API = 'bridgeSendLinkCard';
/** APIs that already have the custom card call (zca-js custom() defines a non-configurable property). */
const cardApiInstalled = new WeakSet<API>();

/**
 * Sends a Zalo link card with the given title/description — zca-js sendLink, but with the
 * card fields supplied instead of re-parsed, so Zalo shows what Beeper shows. Registered
 * through zca-js `api.custom` (same endpoints and params as sendLink).
 */
async function sendLinkCard(api: API, props: LinkCardProps): Promise<{ msgId?: string | number } | null> {
  if (!cardApiInstalled.has(api)) {
    api.custom<{ msgId?: string | number } | null, LinkCardProps>(CARD_API, async ({ ctx, utils, props: p }) => {
      const group = p.type === ThreadType.Group;
      const url = group
        ? utils.makeURL(`${api.zpwServiceMap.group[0]}/api/group/sendlink`, { nretry: 0 })
        : utils.makeURL(`${api.zpwServiceMap.chat[0]}/api/message/link`, { nretry: 0 });
      const href = p.card.href ?? '';
      const params: Record<string, unknown> = {
        msg: p.msg.includes(href) ? p.msg : `${p.msg} ${href}`,
        href,
        src: p.card.src ?? '',
        title: p.card.title ?? '',
        desc: p.card.desc ?? '',
        thumb: p.card.thumb ?? '',
        type: 2,
        media: JSON.stringify(p.card.media ?? {}),
        ttl: 0,
        clientId: Date.now(),
        ...(group ? { grid: p.threadId, imei: ctx.imei } : { toId: p.threadId, mentionInfo: '' }),
      };
      const encrypted = utils.encodeAES(JSON.stringify(params));
      if (!encrypted) throw new Error('Failed to encrypt link card params');
      const response = await utils.request(url, { method: 'POST', body: new URLSearchParams({ params: encrypted }) });
      return utils.resolve(response) as Promise<{ msgId?: string | number } | null>;
    });
    cardApiInstalled.add(api);
  }
  const call = (api as unknown as Record<string, (p: LinkCardProps) => Promise<{ msgId?: string | number } | null>>)[
    CARD_API
  ];
  return call!(props);
}
