// Facade over zca-js: the ONLY module allowed to import zca-js runtime classes.
// Contains login lifecycle, listener resilience, normalization, and rate-limited sends.
import { EventEmitter } from 'node:events';
import { GroupMessage, Zalo, LoginQRCallbackEventType, ThreadType, type API, type TGroupMessage } from 'zca-js';
import { emojiToZalo } from './reaction-map.ts';
import { loadCredentials, saveCredentials, clearCredentials } from './credential-store.ts';
import { normalizeZaloMessage } from './event-normalizer.ts';
import { installFrameTap } from './frame-tap.ts';
import { ListenerManager } from './listener-manager.ts';
import { RateLimiter } from './rate-limiter.ts';
import type {
  RawZaloMessage,
  ZaloMention,
  ZaloMessage,
  ZaloProfile,
  ZaloQuotePayload,
  ZaloReactionEvent,
  ZaloSeenEvent,
  ZaloThreadType,
  ZaloTypingEvent,
} from './types.ts';
import { errorMessage } from '../error-message.ts';

export type ZaloClientOptions = {
  credsPath: string;
  messagesPerMinute: number;
  burst?: number;
};

type ZaloClientEvents = {
  message: [message: ZaloMessage];
  seen: [event: ZaloSeenEvent];
  typing: [event: ZaloTypingEvent];
  reaction: [event: ZaloReactionEvent];
  connected: [];
  reconnecting: [attempt: number, delayMs: number];
  dead: [reason: string];
  loggedOut: [];
};

type GroupRecentProps = {
  groupId: string;
  count: number;
  /** cloud cursor: 0 = newest, otherwise page back from this msgId */
  globalMsgId: string;
};

type GroupRecentPage = {
  msgs: GroupMessage[];
  lastMsgId: string | null;
  maxMsgId: string | null;
  hasMore: boolean;
};

export type ListenerState = 'stopped' | 'connected' | 'reconnecting' | 'dead';

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

/**
 * Rejects when `promise` has not settled within MEDIA_SEND_TIMEOUT_MS. zca-js attachment
 * uploads wait for a websocket "file_done" ack and never reject when it doesn't come
 * (e.g. the listener is down), which would leave the send — and the Beeper user — waiting
 * forever. The underlying request is not cancelled, only no longer awaited.
 *
 * @throws Error naming the step that timed out
 */
async function withSendTimeout<T>(promise: Promise<T>, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${step} timed out after ${MEDIA_SEND_TIMEOUT_MS / 1000}s`)),
      MEDIA_SEND_TIMEOUT_MS,
    );
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

  /**
   * Builds a fresh zca-js Zalo instance for a login attempt.
   * selfListen: own sends (any device) arrive with isSelf=true — used for echo suppression.
   */
  private newZalo(): Zalo {
    return new Zalo({ selfListen: true, checkUpdate: false, logging: false });
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
      this.api = await this.newZalo().login(creds);
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
    const api = await this.newZalo().loginQR({}, (event) => {
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
    // Zalo does not re-push messages missed while disconnected (restart, rebuild,
    // network drop). Once the session key arrives, ask for this session's recent
    // DM + group feed; the old_messages handler replays it through the normal
    // pipeline and msgId dedup drops everything already bridged.
    listener.on('cipher_key', () => {
      setTimeout(() => {
        if (this.api?.listener !== listener || this.historyCapture) return;
        try {
          listener.requestOldMessages(ThreadType.User, null);
          listener.requestOldMessages(ThreadType.Group, null);
        } catch (err) {
          console.warn('catch-up request failed:', errorMessage(err));
        }
      }, 2_000);
    });
    this.api.listener.on('message', (raw) => {
      const normalized = normalizeZaloMessage(raw as unknown as RawZaloMessage);
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
    this.listenerManager.start(this.api);
  }

  /** Stops the listener (no automatic restarts) and marks the listener state as stopped. The session stays logged in. */
  private stopListening(): void {
    this.listenerManager.stop();
    this.listenerState = 'stopped';
  }

  /** Stops listening, drops the API session and deletes the saved credentials and their key file from disk. */
  logout(): void {
    this.stopListening();
    this.api = null;
    clearCredentials(this.opts.credsPath);
    this.emit('loggedOut');
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
   * zca-js issues #356/#367); this calls the cloud-message endpoint Zalo Web uses
   * now (zca-js PR #370), newest-first, max 50 per call. Cursor 0 can come back empty
   * with only the cursor metadata, so the next call starts from maxMsgId, then pages
   * back through lastMsgId while hasMore. At most 4 calls are made; a failure keeps
   * whatever pages were already fetched (logged, never thrown).
   *
   * @param threadId Zalo group id
   * @param count desired number of messages (upper bound, not guaranteed)
   */
  async getGroupHistory(threadId: string, count = 30): Promise<ZaloMessage[]> {
    const api = this.api;
    if (!api) return [];
    const fetchPage = this.groupRecentApi(api);
    const rawMessagesById = new Map<string, GroupMessage>();
    try {
      let cursor = '0';
      for (let call = 0; call < 4 && rawMessagesById.size < count; call++) {
        const page = await fetchPage({
          groupId: threadId,
          count: Math.min(count - rawMessagesById.size, 50),
          globalMsgId: cursor,
        });
        for (const msg of page.msgs) rawMessagesById.set(String(msg.data.msgId), msg);
        const next = page.msgs.length === 0 && cursor === '0' ? page.maxMsgId : page.hasMore ? page.lastMsgId : null;
        if (!next || next === '0' || next === cursor) break;
        cursor = next;
      }
    } catch (err) {
      console.warn(`group history (${threadId}) failed:`, errorMessage(err));
    }
    return [...rawMessagesById.values()]
      .map((msg) => normalizeZaloMessage(msg as unknown as RawZaloMessage))
      .filter((message): message is ZaloMessage => message !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Registers (once per logged-in API) the cloud group-history call via zca-js custom().
   * The registered call GETs `<group_cloud_message>/api/cm/getrecentv2` with
   * AES-encrypted params and maps the reply to a GroupRecentPage. With
   * ZALO_WS_TRACE=1 it logs the reply's cursor metadata (never message content).
   *
   * @returns the page-fetch function (cached on the API object under `bridgeGroupRecent`)
   */
  private groupRecentApi(api: API): (props: GroupRecentProps) => Promise<GroupRecentPage> {
    const name = 'bridgeGroupRecent';
    const existing = (api as unknown as Record<string, unknown>)[name];
    if (typeof existing === 'function') return existing as (props: GroupRecentProps) => Promise<GroupRecentPage>;
    api.custom<GroupRecentPage, GroupRecentProps>(name, async ({ ctx, utils, props }) => {
      // The service map lives on the API object (zca-js apis.d.ts), not on ctx
      const serviceURL = utils.makeURL(`${api.zpwServiceMap.group_cloud_message[0]}/api/cm/getrecentv2`);
      const params = {
        groupId: props.groupId,
        globalMsgId: Number(props.globalMsgId),
        count: props.count,
        msgIds: [],
        imei: ctx.imei,
        src: 3,
      };
      const encrypted = utils.encodeAES(JSON.stringify(params));
      if (!encrypted) throw new Error('Failed to encrypt params');
      const response = await utils.request(utils.makeURL(serviceURL, { params: encrypted, nretry: 0 }), {
        method: 'GET',
      });
      return utils.resolve(response, (result) => {
        const data = (typeof result.data === 'string' ? JSON.parse(result.data) : result.data) as {
          groupMsgs?: TGroupMessage[];
          lastMsgId?: string | number;
          maxMsgId?: string | number;
          hasMore?: number | boolean;
        };
        if (process.env.ZALO_WS_TRACE === '1') {
          const replyFields = data as Record<string, unknown>;
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
            .map((fieldName) => `${fieldName}=${String(replyFields[fieldName])}`)
            .join(' ');
          console.log(
            `[zalo:http] getrecentv2 ${props.groupId} cursor=${props.globalMsgId} msgs=${data.groupMsgs?.length ?? 0} ${meta}`,
          );
        }
        return {
          msgs: (data.groupMsgs ?? []).map((raw) => new GroupMessage(ctx.uid, raw)),
          lastMsgId: data.lastMsgId != null ? String(data.lastMsgId) : null,
          maxMsgId: data.maxMsgId != null ? String(data.maxMsgId) : null,
          hasMore: Boolean(data.hasMore),
        };
      });
    });
    return (api as unknown as Record<string, (props: GroupRecentProps) => Promise<GroupRecentPage>>)[name]!;
  }

  /**
   * One page of recent messages across ALL threads of a type (what Zalo Web loads to
   * build its conversation list — the only way to discover DM threads). Pass the
   * oldest msgId of the previous page to go further back. null = no answer (timeout,
   * not listening); [] = no more history.
   *
   * The reply arrives asynchronously as an `old_messages` listener event, so the
   * request parks a one-shot `historyCapture` that the handler resolves. Only one
   * request may be outstanding; on timeout, the next unrequested reply of this thread
   * type arriving within 60 s is treated as the late reply and discarded.
   *
   * @param threadType which feed to page through (DMs or groups)
   * @param beforeMsgId cursor: oldest msgId of the previous page, or null for the newest page
   * @param timeoutMs how long to wait for the websocket reply
   */
  async fetchRecentMessagesPage(
    threadType: ZaloThreadType,
    beforeMsgId: string | null,
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
        api.listener.requestOldMessages(type, beforeMsgId);
      } catch (err) {
        console.warn('requestOldMessages failed:', errorMessage(err));
        this.historyCapture = null;
        clearTimeout(timer);
        resolve(null);
      }
    });
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
   * Unmapped emoji fall back to HEART (see reaction-map).
   *
   * @throws when not logged in, or when the zca-js call fails
   */
  async react(
    threadId: string,
    threadType: ZaloThreadType,
    msgId: string,
    cliMsgId: string,
    emoji: string,
  ): Promise<void> {
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await api.addReaction(emojiToZalo(emoji), {
      data: { msgId, cliMsgId },
      threadId,
      type: toThreadType(threadType),
    });
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
   * Send a voice note Beeper→Zalo as a native Zalo voice message (not a file):
   * the audio is uploaded to Zalo's file CDN with uploadAttachment, then posted with
   * sendVoice, which only takes a URL. Zalo voice notes are AAC — pass AAC in an
   * .m4a/.aac file; other codecs (ogg/opus) are not transcoded here.
   * Waits for the outbound rate limiter.
   *
   * @param data AAC audio bytes (m4a container or raw ADTS)
   * @param filename must end in .m4a or .aac (zca-js routes uploads by extension)
   * @returns the sent msgId for echo suppression / recall
   * @throws when not logged in, the upload yields no file URL, or a zca-js call fails
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
    const [uploaded] = await withSendTimeout(
      api.uploadAttachment([{ data, filename, metadata: { totalSize: data.byteLength } }], threadId, zaloThreadType),
      'voice upload',
    );
    if (!uploaded || uploaded.fileType === 'image' || !uploaded.fileUrl) {
      throw new Error('voice upload returned no file URL');
    }
    const sent = await withSendTimeout(
      api.sendVoice({ voiceUrl: uploaded.fileUrl }, threadId, zaloThreadType),
      'voice send',
    );
    return sent?.msgId != null ? [String(sent.msgId)] : [];
  }

  /**
   * Rate-limited text send with optional quote. Returns Zalo msgId (echo-suppression key).
   * onBeforeSend fires AFTER the rate-limit wait, immediately before the network call —
   * echo-suppression TTLs must start at real send time, not enqueue time.
   *
   * @param quote raw payload of the message being replied to (Matrix reply → Zalo quote)
   * @param mentions @mentions (uid + position/length in `text`)
   * @throws when not logged in, or when the zca-js send fails
   */
  async sendText(
    threadId: string,
    threadType: ZaloThreadType,
    text: string,
    quote?: ZaloQuotePayload,
    onBeforeSend?: () => void,
    mentions?: ZaloMention[],
  ): Promise<{ msgId: string | null }> {
    // Capture before the rate-limit wait — logout during the wait must not null-deref
    const api = this.api;
    if (!api) throw new Error('Not logged in');
    await this.rateLimiter.acquire();
    onBeforeSend?.();
    const zaloType = toThreadType(threadType);
    // A plain sendMessage link shows no preview on Zalo; sendLink makes Zalo build its own
    // card. It takes no quote/mentions, so those messages stay plain text.
    const link = !quote && !mentions?.length ? text.match(/https?:\/\/\S+/)?.[0] : undefined;
    // Probe first: only an unparseable link falls back to plain text. A failed sendLink
    // itself is not retried — Zalo may already have delivered it (no duplicates).
    if (
      link &&
      (await api.parseLink(link).then(
        () => true,
        () => false,
      ))
    ) {
      const sent = await api.sendLink({ msg: text, link }, threadId, zaloType);
      return { msgId: sent?.msgId != null ? String(sent.msgId) : null };
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
