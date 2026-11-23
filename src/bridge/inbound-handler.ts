// Inbound pipeline: ZaloMessage → dedup → puppet → portal → Matrix event.
// Per-thread promise chains preserve message order (appservice-style concurrency
// would otherwise interleave async sends within one conversation).
import type { Bridge, Intent } from 'matrix-appservice-bridge';
import type { EchoSuppressor } from './echo-suppressor.ts';
import {
  buildLinkPreview,
  buildMediaEvent,
  downloadFirstMedia,
  isLargeMedia,
  LARGE_MEDIA_TIMEOUT_MS,
  type MediaBytes,
  mediaMaxBytesFor,
  roomUploader,
} from './media-content.ts';
import { locationContent, unsupportedNoticeBody } from './zalo-render.ts';
import { bridgeInboundPhoto, bridgeInboundSticker } from './media-handler.ts';
import { buildInboundMentions } from './mentions.ts';
import { rememberBridgedEvent, SELF_BRIDGE_MARKER, type BridgedEvents } from './self-bridge.ts';
import type { MappingStore, PortalRow } from './mapping-store.ts';
import { ownerIntent } from './owner-intent.ts';
import { InboundPolls } from './inbound-poll.ts';
import { PinBubbleGuard } from './pin-guard.ts';
import type { PortalManager } from './portal-manager.ts';
import type { PuppetRegistry } from './puppet-registry.ts';
import type { ZaloMessage, ZaloPinEvent, ZaloPoll, ZaloPollEvent } from '../zalo/types.ts';
import { errorMessage } from '../error-message.ts';

/** Collaborators and settings the inbound pipeline needs. */
export type InboundHandlerDeps = {
  bridge: Bridge;
  store: MappingStore;
  puppets: PuppetRegistry;
  portals: PortalManager;
  echo: EchoSuppressor;
  ownerUserId: string;
  mediaMaxBytes: number;
  resolveGroupName: (threadId: string) => Promise<string | null>;
  resolveStickerUrl: (stickerId: number) => Promise<string | null>;
  /** own Zalo uid, to map a self-mention to the owner MXID (null until logged in) */
  getOwnZaloId: () => string | null;
  /** shared with OutboundHandler: event_ids the bridge posted as the owner
   * (own phone messages) so they are never sent back to Zalo (anti-loop). */
  bridgedEventIds: BridgedEvents;
  /** whether a portal room is end-to-bridge encrypted, so media goes up encrypted
   * (unset or false = plain; resolved lazily as the crypto device starts after the handler) */
  isEncrypted?: (roomId: string) => Promise<boolean>;
  /** how long a system bubble waits for the pin event Zalo sends alongside it (ms, default 0:
   * only a pin event that already arrived suppresses the bubble) */
  pinBubbleHoldMs?: number;
  /** reads a group poll's options and voters from Zalo (unset = polls are not bridged) */
  getPollDetail?: (pollId: number) => Promise<ZaloPoll | null>;
  /** called after a photo / media message was bridged only as a notice (e.g. to schedule a repair) */
  onMediaFailure?: (msg: ZaloMessage) => void;
};

/** Result of one media repair attempt (see InboundHandler.repairMedia). */
export type RepairOutcome = { status: 'repaired' } | { status: 'closed' } | { status: 'failed'; error: string };

/**
 * Body of the notice posted when a photo or media download failed. Carries no link: Zalo
 * links are signed. A photo keeps its caption (e.g. a contact card's name / phone).
 */
function mediaFailureNotice(msg: ZaloMessage, error: string): string {
  if (msg.content.kind === 'photo') {
    const caption = msg.content.caption ? `${msg.content.caption}\n` : '';
    return `${caption}[Zalo photo could not be bridged: ${error}]`;
  }
  if (msg.content.kind === 'media') {
    const { kind, filename } = msg.content.media;
    return `[Zalo ${kind} could not be bridged${filename ? `: ${filename}` : ''}]`;
  }
  return '[Zalo media could not be bridged]';
}

const PINNED_EVENTS = 'm.room.pinned_events';
/** how many topicId to msgId pairs are remembered to resolve a DM unpin (which carries no msgId) */
const TOPIC_MEMORY = 500;

/** Guard key for who acted: all of the account's own actions share one key (uid forms vary). */
const actorKey = (isSelf: boolean, uid: string | undefined) => (isSelf ? 'self' : (uid ?? ''));

/** True when a Matrix error says the sender may not act in the room (not a member / no power). */
function isForbidden(err: unknown): boolean {
  const body = (err as { body?: { errcode?: unknown } } | null)?.body;
  const errcode = body?.errcode ?? (err as { errcode?: unknown } | null)?.errcode;
  return errcode === 'M_FORBIDDEN' || errorMessage(err).includes('M_FORBIDDEN');
}

/**
 * Bridges Zalo messages into Matrix portal rooms: drops duplicates and echoes of
 * our own sends, provisions the portal and sender ghost, posts the content (text,
 * photo, sticker, media or a notice) and records the msgId ↔ event_id mapping.
 */
export class InboundHandler {
  private readonly deps: InboundHandlerDeps;
  /** threadId → tail of that thread's processing chain (removed once it drains) */
  private readonly threadQueues = new Map<string, Promise<void>>();
  /** pairs each pin event with the system bubble Zalo also sends for it */
  private readonly pinGuard = new PinBubbleGuard();
  /** "threadId|topicId" to pinned msgId, learned from pins so a later unpin can be resolved */
  private readonly topicMsgIds = new Map<string, string>();
  /** Zalo group polls → MSC3381 events */
  private readonly polls: InboundPolls;

  /** @param deps Shared bridge collaborators (see InboundHandlerDeps). */
  constructor(deps: InboundHandlerDeps) {
    this.deps = deps;
    this.polls = new InboundPolls({
      ...deps,
      getPollDetail: (pollId) => deps.getPollDetail?.(pollId) ?? Promise.resolve(null),
      notice: (portal, text) => this.sendBotNotice(portal, text),
    });
  }

  /**
   * Entry point — serializes per thread, never throws (errors are logged).
   * Queues the message behind any message of the same thread still being
   * processed and returns immediately.
   */
  handle(msg: ZaloMessage): void {
    this.enqueue(msg.threadId, `inbound ${msg.msgId}`, () => this.process(msg));
  }

  /**
   * Entry point for a Zalo pin / unpin: serialized behind the thread's messages so a pin
   * lands after the message it points at; never throws. The pin is also registered with
   * the bubble guard right away (not queued), so the system bubble Zalo sends for the same
   * pin is recognised whether it arrives before or after this event.
   */
  handlePin(event: ZaloPinEvent): void {
    if (!this.deps.store.getPortalByThread(event.threadId)) return; // never create a portal for a pin
    this.pinGuard.note(event.threadId, actorKey(event.isSelf, event.actorId));
    this.enqueue(event.threadId, `pin ${event.action}`, () => this.processPin(event));
  }

  /**
   * Entry point for a Zalo group poll event (created, voted, locked, removed): serialized
   * with the thread's messages and never throws. Threads without a portal are ignored.
   */
  handlePoll(event: ZaloPollEvent): void {
    if (!this.deps.store.getPortalByThread(event.threadId)) return; // never create a portal for a poll
    this.enqueue(event.threadId, `poll ${event.action} ${event.pollId}`, () => this.polls.process(event));
  }

  /** Appends a task to the thread's chain; failures are logged, never thrown. */
  private enqueue(threadId: string, label: string, task: () => Promise<void>): void {
    const previous = this.threadQueues.get(threadId) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((err: unknown) => console.error(`[bridge] ${label} failed:`, errorMessage(err)))
      .finally(() => {
        if (this.threadQueues.get(threadId) === next) this.threadQueues.delete(threadId);
      });
    this.threadQueues.set(threadId, next);
  }

  /**
   * Consumes the echo guard OutboundHandler armed for this message: a text guard by
   * content, or — for any media send (photo, video, file, voice) — the thread's media
   * marker. A leftover marker would swallow a real phone message and re-post the echo.
   *
   * @returns true when a guard matched (the message is our own Beeper send)
   */
  private consumeEchoGuard(msg: ZaloMessage): boolean {
    if (msg.content.kind === 'text') return this.deps.echo.consume(msg.threadId, msg.content.text);
    if (msg.content.kind === 'photo' || msg.content.kind === 'media') return this.deps.echo.consumeImage(msg.threadId);
    return false;
  }

  /**
   * Records the echo of our own Beeper send: it carries the cliMsgId the send response
   * lacked (needed for recall) and a full quotable payload (needed to reply to it).
   */
  private recordOwnEcho(msg: ZaloMessage): void {
    this.deps.store.recordMessage(
      msg.msgId,
      this.deps.store.getPortalByThread(msg.threadId)?.room_id ?? '',
      null,
      'outbound',
      msg.quotable ? JSON.stringify(msg.quotable) : null,
      msg.cliMsgId ?? null,
    );
  }

  /**
   * Zalo "delete for me" (the account deleted messages on another device) or a recall by
   * the sender (for everyone) → redacts their bridged Matrix events, so Beeper shows what
   * the Zalo account shows. Redacted by the
   * room's creator (the ghost for a DM, the bot for a group) and never as the owner:
   * OutboundHandler turns an owner redaction into a Zalo recall for everyone. Messages that
   * were never bridged are skipped; no portal is created for a deletion.
   */
  private async redactDeleted(msg: ZaloMessage, msgIds: string[]): Promise<void> {
    const portal = this.deps.store.getPortalByThread(msg.threadId);
    if (!portal) return;
    const isRecall = msg.content.kind === 'recall';
    if (msgIds.length === 0) {
      const raw = msg.quotable?.content;
      const sample = Array.isArray(raw) ? (raw[0] ?? {}) : raw;
      const keys = typeof sample === 'object' && sample !== null ? Object.keys(sample).join(',') : typeof sample;
      console.warn(`[bridge] ${isRecall ? 'recall' : 'chat.delete'} without message ids (keys: ${keys})`);
    }
    const intent =
      portal.thread_type === 'user' ? this.deps.puppets.intentFor(portal.thread_id) : this.deps.bridge.getIntent();
    for (const zaloMsgId of msgIds) {
      const target = this.deps.store.getEventByZaloMsgId(zaloMsgId);
      if (!target?.eventId) {
        if (isRecall) console.log(`[bridge] recall of a message that was never bridged (thread ${msg.threadId})`);
        continue;
      }
      await intent.matrixClient
        .redactEvent(target.roomId, target.eventId, isRecall ? 'Recalled on Zalo' : 'Deleted on Zalo')
        .catch((err: unknown) => console.warn(`[bridge] redact ${target.eventId} failed:`, errorMessage(err)));
    }
    this.deps.store.recordMessage(msg.msgId, portal.room_id, null, 'inbound'); // dedup a replayed delete/recall
  }

  /**
   * Bridges one Zalo message (called in per-thread order by `handle`).
   * Own echoes only backfill quote/cliMsgId on the existing row; duplicates are
   * dropped. Otherwise ensures the portal (and, for groups, the sender ghost in
   * the room), posts the content as the sender ghost or — for the owner's own
   * phone messages — as the owner (tagged with SELF_BRIDGE_MARKER and added to
   * `bridgedEventIds`), then records the message mapping.
   * @throws On portal/ghost provisioning or Matrix send failures (logged by `handle`).
   */
  private async process(msg: ZaloMessage): Promise<void> {
    // Echo of our OWN Beeper-sent message (outbound already recorded its msgId first,
    // so hasMessage is true before the echo path below can run): backfill the quote
    // payload + cliMsgId the send response lacked, so replying to / recalling our own
    // message works. Then drop it (already visible in Beeper).
    if (msg.isSelf && this.deps.store.hasMessage(msg.msgId)) {
      // The send response won the race against this echo, so the guard armed for it was
      // never matched: consume it now, or it would swallow a real phone message (same
      // text, or any media in this thread) for the rest of its TTL
      this.consumeEchoGuard(msg);
      this.recordOwnEcho(msg);
      return;
    }
    if (this.deps.store.hasMessage(msg.msgId)) return; // duplicate listener event

    // Our own send echoed back by selfListen → already visible in Beeper, don't repost
    if (msg.isSelf && this.consumeEchoGuard(msg)) {
      this.recordOwnEcho(msg);
      return;
    }

    if (msg.content.kind === 'delete' || msg.content.kind === 'recall') {
      await this.redactDeleted(msg, msg.content.msgIds);
      return;
    }

    const portal = await this.deps.portals.getOrCreatePortal({
      threadId: msg.threadId,
      threadType: msg.threadType,
      senderId: msg.isSelf ? msg.threadId : msg.senderId, // self-DM: portal peer is the thread, not us
      senderName: msg.isSelf ? undefined : msg.senderName,
      resolveGroupName: this.deps.resolveGroupName,
    });

    // System lines ("X pinned a message", "joined the group", ...) are not a person's message
    if (msg.content.kind === 'notice') {
      await this.processNotice(msg, portal);
      return;
    }

    const intent = msg.isSelf
      ? ownerIntent(this.deps.bridge, this.deps.ownerUserId)
      : await this.intentForSender(msg, portal.room_id);
    const encrypted = (await this.deps.isEncrypted?.(portal.room_id)) ?? false;

    // Extra content fields merged into every post. For our own (double-puppeted)
    // messages this marks them so OutboundHandler never loops them back to Zalo.
    // Zalo quote → Matrix reply: map the quoted msgId to its bridged Matrix event.
    const extraContent: Record<string, unknown> = {};
    if (msg.isSelf) extraContent[SELF_BRIDGE_MARKER] = true;
    const replyEventId = this.resolveReply(msg, portal.room_id);
    if (replyEventId) extraContent['m.relates_to'] = { 'm.in_reply_to': { event_id: replyEventId } };

    let eventId: string | null = null;
    /** Set when a photo / media download failed and only a notice was posted. */
    let mediaFailure: { kind: string; error: string } | undefined;
    switch (msg.content.kind) {
      case 'text': {
        const textContent: Record<string, unknown> = { msgtype: 'm.text', body: msg.content.text, ...extraContent };
        // @mentions → matrix.to pills + m.mentions so Beeper renders and notifies
        if (msg.mentions?.length) {
          const ownId = this.deps.getOwnZaloId();
          const { formattedBody, userIds } = buildInboundMentions(msg.content.text, msg.mentions, (uid) =>
            uid === ownId ? this.deps.ownerUserId : this.deps.puppets.mxidFor(uid),
          );
          textContent.format = 'org.matrix.custom.html';
          textContent.formatted_body = formattedBody;
          textContent['m.mentions'] = { user_ids: userIds };
        }
        const preview = msg.content.linkPreview;
        if (preview) {
          /** Uploads the preview image as the posting intent (encrypted in an encrypted room). */
          const upload = roomUploader(
            (buffer, uploadOptions) => intent.uploadContent(buffer, uploadOptions),
            encrypted,
          );
          // A failed thumbnail upload still leaves a text-only preview
          textContent['com.beeper.linkpreviews'] = [
            await buildLinkPreview(upload, preview, this.deps.mediaMaxBytes).catch(() => ({
              matched_url: preview.url,
              'og:url': preview.url,
            })),
          ];
        }
        const sent = await intent.sendMessage(portal.room_id, textContent);
        eventId = sent.event_id;
        break;
      }
      case 'call': {
        const sent = await intent.sendMessage(portal.room_id, {
          msgtype: 'm.text',
          body: msg.content.text,
          'com.beeper.action_message': msg.content.action,
          ...extraContent,
        });
        eventId = sent.event_id;
        break;
      }
      case 'photo':
      case 'media': {
        const posted = await this.postMedia(msg, intent, portal.room_id, encrypted, extraContent);
        if ('eventId' in posted) {
          eventId = posted.eventId;
          break;
        }
        mediaFailure = posted.failure;
        const sent = await intent.sendMessage(portal.room_id, {
          msgtype: 'm.notice',
          body: mediaFailureNotice(msg, posted.failure.error),
          ...extraContent,
        });
        eventId = sent.event_id;
        break;
      }
      case 'location': {
        const sent = await intent.sendMessage(portal.room_id, { ...locationContent(msg.content), ...extraContent });
        eventId = sent.event_id;
        break;
      }
      case 'sticker': {
        try {
          // Still-image URL is only the fallback: animated stickers are built from the sprite
          const stillImageUrl = await this.deps.resolveStickerUrl(msg.content.id).catch(() => null);
          const bridged = await bridgeInboundSticker(
            intent,
            portal.room_id,
            msg.content.id,
            stillImageUrl,
            this.deps.mediaMaxBytes,
            extraContent,
            encrypted,
            this.deps.store,
          );
          eventId = bridged.eventId;
        } catch {
          const sent = await intent.sendMessage(portal.room_id, {
            msgtype: 'm.notice',
            body: '[Zalo sticker]',
            ...extraContent,
          });
          eventId = sent.event_id;
        }
        break;
      }
      case 'unsupported': {
        // Field NAMES only (never values — private content) so the shape can be added later
        const raw = msg.quotable?.content;
        if (msg.content.msgType !== 'e2ee') {
          const keys = raw && typeof raw === 'object' ? Object.keys(raw).join(',') : typeof raw;
          // `action` is Zalo's card kind (an identifier like 'recommened.link'), not user content
          const action = raw && typeof raw === 'object' ? (raw as { action?: unknown }).action : undefined;
          const actionNote = typeof action === 'string' ? `, action: ${action.slice(0, 64)}` : '';
          console.warn(`[bridge] unsupported Zalo msgType ${msg.content.msgType} (content keys: ${keys}${actionNote})`);
        }
        const sent = await intent.sendMessage(portal.room_id, {
          msgtype: 'm.notice',
          body: unsupportedNoticeBody(msg.content.msgType),
          ...extraContent,
        });
        eventId = sent.event_id;
        break;
      }
    }
    // Own phone messages are posted as the owner and will round-trip back to the
    // appservice; mark the event so OutboundHandler never re-sends it to Zalo.
    if (msg.isSelf && eventId) rememberBridgedEvent(this.deps.bridgedEventIds, eventId);
    this.deps.store.recordMessage(
      msg.msgId,
      portal.room_id,
      eventId,
      'inbound',
      msg.quotable ? JSON.stringify(msg.quotable) : null,
      msg.cliMsgId ?? null,
      msg.senderId,
      msg.rawMsgType ?? null,
    );
    // Ledger of media that reached Matrix only as a notice; the repair queue retries it,
    // `media-failures` lists what is still open and a history rebuild with --media-dir
    // replaces the notice with the real file
    if (mediaFailure && eventId) {
      console.warn(
        `[media] ${mediaFailure.kind} ${msg.msgId} in ${portal.room_id} bridged as a notice: ${mediaFailure.error}`,
      );
      this.deps.store.recordMediaFailure(msg.msgId, portal.room_id, eventId, mediaFailure.kind, mediaFailure.error);
      this.deps.onMediaFailure?.(msg);
    }
  }

  /**
   * Downloads and posts a photo or media message as `intent`. Download failures come back
   * as `failure` (so the caller can post a notice); upload or send errors still throw.
   */
  private async postMedia(
    msg: ZaloMessage,
    intent: Intent,
    roomId: string,
    encrypted: boolean,
    extraContent: Record<string, unknown>,
  ): Promise<{ eventId: string } | { failure: { kind: string; error: string } }> {
    if (msg.content.kind === 'photo') {
      try {
        const bridged = await bridgeInboundPhoto(
          intent,
          roomId,
          { ...msg.content, label: `photo ${msg.msgId}` },
          this.deps.mediaMaxBytes,
          extraContent,
          encrypted,
        );
        return { eventId: bridged.eventId };
      } catch (err) {
        return { failure: { kind: 'photo', error: errorMessage(err) } };
      }
    }
    if (msg.content.kind !== 'media') throw new Error(`not a media message: ${msg.content.kind}`);
    const media = msg.content.media;
    let bytes: MediaBytes;
    try {
      bytes = await downloadFirstMedia(media.urls, mediaMaxBytesFor(media.kind, this.deps.mediaMaxBytes), {
        timeoutMs: isLargeMedia(media.kind) ? LARGE_MEDIA_TIMEOUT_MS : undefined,
        label: `${media.kind} ${msg.msgId}`,
      });
    } catch (err) {
      return { failure: { kind: media.kind, error: errorMessage(err) } };
    }
    /** Uploads the media bytes as the posting intent (encrypted in an encrypted room). */
    const upload = roomUploader((buffer, uploadOptions) => intent.uploadContent(buffer, uploadOptions), encrypted);
    const mediaEvent = await buildMediaEvent(upload, media, bytes);
    const sent = await intent.sendEvent(roomId, mediaEvent.type, { ...mediaEvent.content, ...extraContent });
    return { eventId: sent.event_id };
  }

  /**
   * Retries a media message that was bridged as a "could not be bridged" notice: posts the
   * real file (at the end of the timeline), points the message mapping at it, closes the
   * failure row and redacts the old notice. Serialized with the thread's messages; never
   * rejects. `msg` must carry download links (the stored ones or freshly fetched ones).
   * @returns `repaired`, `closed` (nothing left to repair) or `failed` (still broken).
   */
  repairMedia(msg: ZaloMessage): Promise<RepairOutcome> {
    return new Promise((resolve) => {
      this.enqueue(msg.threadId, `repair ${msg.msgId}`, async () => {
        try {
          resolve(await this.doRepair(msg));
        } catch (err) {
          resolve({ status: 'failed', error: errorMessage(err) });
        }
      });
    });
  }

  /** The body of `repairMedia`, run inside the thread's queue. */
  private async doRepair(msg: ZaloMessage): Promise<RepairOutcome> {
    if (msg.content.kind !== 'photo' && msg.content.kind !== 'media') return { status: 'closed' };
    const portal = this.deps.store.getPortalByThread(msg.threadId);
    const failure = this.deps.store.getOpenMediaFailure(msg.msgId);
    if (!portal || !failure || failure.roomId !== portal.room_id) return { status: 'closed' };

    const intent = msg.isSelf
      ? ownerIntent(this.deps.bridge, this.deps.ownerUserId)
      : await this.intentForSender(msg, portal.room_id);
    const encrypted = (await this.deps.isEncrypted?.(portal.room_id)) ?? false;
    const extraContent: Record<string, unknown> = {};
    if (msg.isSelf) extraContent[SELF_BRIDGE_MARKER] = true;
    const replyEventId = this.resolveReply(msg, portal.room_id);
    if (replyEventId) extraContent['m.relates_to'] = { 'm.in_reply_to': { event_id: replyEventId } };

    const posted = await this.postMedia(msg, intent, portal.room_id, encrypted, extraContent);
    if (!('eventId' in posted)) return { status: 'failed', error: posted.failure.error };
    if (msg.isSelf) rememberBridgedEvent(this.deps.bridgedEventIds, posted.eventId);
    this.deps.store.resolveMediaFailure(msg.msgId, posted.eventId);
    console.log(`[media] repaired ${failure.kind} ${msg.msgId} in ${portal.room_id}`);

    // Redact the notice as the room's creator (the ghost for a DM, the bot for a group), like
    // redactDeleted. Never as the owner: OutboundHandler turns an owner redaction into a Zalo recall.
    const redactor =
      portal.thread_type === 'user' ? this.deps.puppets.intentFor(portal.thread_id) : this.deps.bridge.getIntent();
    await redactor.matrixClient
      .redactEvent(portal.room_id, failure.eventId, 'Replaced by the repaired media')
      .catch((err: unknown) => console.warn(`[media] could not redact notice ${msg.msgId}:`, errorMessage(err)));
    return { status: 'repaired' };
  }

  /**
   * Posts a Zalo system line as an `m.notice` from the bridge bot, so it never looks like a
   * message from a person. Skipped when it is the bubble of a pin the bridge already
   * applied as room state. Recorded in the message table either way (replay dedup).
   */
  private async processNotice(msg: ZaloMessage, portal: PortalRow): Promise<void> {
    if (msg.content.kind !== 'notice') return;
    const claimed = await this.pinGuard.takeWithin(
      msg.threadId,
      actorKey(msg.isSelf, msg.senderId),
      this.deps.pinBubbleHoldMs ?? 0,
    );
    const eventId = claimed ? null : await this.sendBotNotice(portal, msg.content.text);
    this.deps.store.recordMessage(
      msg.msgId,
      portal.room_id,
      eventId,
      'inbound',
      msg.quotable ? JSON.stringify(msg.quotable) : null,
      msg.cliMsgId ?? null,
      msg.senderId,
      msg.rawMsgType ?? null,
    );
  }

  /**
   * Sends `m.notice` as the bridge bot (encrypted automatically in an encrypted room).
   * The bot is in every group and every encrypted DM. A plaintext DM made before encryption
   * existed has no bot: when the send is refused the bot is brought in (the peer ghost, the
   * room creator, invites it) and the send retried; if that fails too the line is posted as
   * the DM peer's ghost, the only other member able to speak, and the failure is logged.
   *
   * @returns the event_id of the notice
   * @throws On a failed send in a group, or a failed ghost send in a DM
   */
  private async sendBotNotice(portal: PortalRow, body: string): Promise<string> {
    const content = { msgtype: 'm.notice', body };
    const bot = this.deps.bridge.getIntent();
    try {
      return (await bot.sendMessage(portal.room_id, content)).event_id;
    } catch (err) {
      if (portal.thread_type !== 'user' || !isForbidden(err)) throw err;
    }
    try {
      await this.deps.portals.ensureBotInRoom(portal.room_id, portal.thread_id);
      return (await bot.sendMessage(portal.room_id, content)).event_id;
    } catch (err) {
      console.warn(`[bridge] bot cannot post in ${portal.room_id}, using the peer ghost:`, errorMessage(err));
      return (await this.deps.puppets.intentFor(portal.thread_id).sendMessage(portal.room_id, content)).event_id;
    }
  }

  /**
   * Bridges a pin / unpin as `m.room.pinned_events` state, sent as the pinner (their ghost,
   * or the owner for the account's own pins), adding or removing just that one event and
   * keeping the other pins. A pin whose message was never bridged becomes a bot notice
   * instead (an unpin of one is dropped). When the pinner may not change room state, the
   * room creator does (the ghost for a DM, the bot for a group).
   */
  private async processPin(event: ZaloPinEvent): Promise<void> {
    const portal = this.deps.store.getPortalByThread(event.threadId);
    if (!portal) return;
    const topicKey = event.topicId ? `${event.threadId}|${event.topicId}` : undefined;
    if (topicKey && event.msgId && event.action === 'pin') this.rememberTopic(topicKey, event.msgId);
    const msgId = event.msgId ?? (topicKey ? this.topicMsgIds.get(topicKey) : undefined);
    // a friend unpin may carry the msgId itself as its topic id: try that last
    const eventId =
      (msgId ? this.deps.store.getEventIdByMsgId(msgId) : null) ??
      (!msgId && event.topicId ? this.deps.store.getEventIdByMsgId(event.topicId) : null);
    if (!eventId) {
      if (event.action === 'pin')
        await this.sendBotNotice(portal, '\u{1F4CC} A message was pinned on Zalo (it is not in this chat).');
      else console.log(`[bridge] unpin of a message that was never bridged (thread ${event.threadId})`);
      return;
    }
    const intent = await this.intentForPin(event, portal);
    const creator =
      portal.thread_type === 'user' ? this.deps.puppets.intentFor(portal.thread_id) : this.deps.bridge.getIntent();
    const pin = event.action === 'pin';
    try {
      await this.setPinned(intent, portal.room_id, eventId, pin);
    } catch (err) {
      if (intent === creator) throw err;
      console.warn(
        `[bridge] pin as the pinner failed in ${portal.room_id}, using the room creator:`,
        errorMessage(err),
      );
      await this.setPinned(creator, portal.room_id, eventId, pin);
    }
  }

  /** Remembers which message a pin (topic) belongs to, dropping the oldest beyond TOPIC_MEMORY. */
  private rememberTopic(topicKey: string, msgId: string): void {
    this.topicMsgIds.delete(topicKey);
    this.topicMsgIds.set(topicKey, msgId);
    if (this.topicMsgIds.size > TOPIC_MEMORY) {
      const oldest = this.topicMsgIds.keys().next().value;
      if (oldest !== undefined) this.topicMsgIds.delete(oldest);
    }
  }

  /** Adds (pin) or removes (unpin) one event in the room's pinned list; a no-op change is not sent. */
  private async setPinned(intent: Intent, roomId: string, eventId: string, pin: boolean): Promise<void> {
    const current = (await intent.getStateEvent(roomId, PINNED_EVENTS, '', true)) as { pinned?: unknown } | null;
    const pinned = Array.isArray(current?.pinned)
      ? current.pinned.filter((id): id is string => typeof id === 'string')
      : [];
    if (pin === pinned.includes(eventId)) return;
    const next = pin ? [...pinned, eventId] : pinned.filter((id) => id !== eventId);
    await intent.sendStateEvent(roomId, PINNED_EVENTS, '', { ...current, pinned: next });
  }

  /** Intent of whoever pinned: the owner (own account), the pinner's ghost, else the bot. */
  private async intentForPin(event: ZaloPinEvent, portal: PortalRow): Promise<Intent> {
    if (event.isSelf) return ownerIntent(this.deps.bridge, this.deps.ownerUserId);
    if (!event.actorId) return this.deps.bridge.getIntent();
    const ghost = await this.deps.puppets.ensurePuppet(event.actorId, undefined);
    if (portal.thread_type === 'group')
      await this.deps.portals.ensureGhostInRoom(event.actorId, portal.room_id, undefined);
    return ghost;
  }

  /**
   * Matrix event a Zalo quote points at: by the quoted global msgId, else by its client
   * msgId + sender within the room. Logs the ids (never content) when the quote can't be
   * resolved, so a missing reply can be traced.
   */
  private resolveReply(msg: ZaloMessage, roomId: string): string | null {
    if (!msg.replyToMsgId && !msg.replyToCliMsgId) return null;
    const byGlobal = msg.replyToMsgId ? this.deps.store.getEventByZaloMsgId(msg.replyToMsgId)?.eventId : null;
    if (byGlobal) return byGlobal;
    const byClient = msg.replyToCliMsgId
      ? this.deps.store.getEventIdByCliMsgId(roomId, msg.replyToCliMsgId, msg.replyToSenderId ?? null)
      : null;
    if (byClient) return byClient;
    console.warn(
      `[bridge] reply target not bridged: msg=${msg.msgId} quote global=${msg.replyToMsgId ?? '-'} cli=${msg.replyToCliMsgId ?? '-'} owner=${msg.replyToSenderId ?? '-'}`,
    );
    return null;
  }

  /**
   * Intent of the sender's ghost: registers/profile-syncs the ghost and, in group
   * portals, makes sure it has joined the room (DM rooms are created by the ghost).
   * @param msg Incoming message (sender id/name, thread type).
   * @param roomId Portal room the message will be posted to.
   */
  private async intentForSender(msg: ZaloMessage, roomId: string) {
    const intent = await this.deps.puppets.ensurePuppet(msg.senderId, msg.senderName);
    if (msg.threadType === 'group') {
      await this.deps.portals.ensureGhostInRoom(msg.senderId, roomId, msg.senderName);
    }
    return intent;
  }
}
