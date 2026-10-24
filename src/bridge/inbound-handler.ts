// Inbound pipeline: ZaloMessage → dedup → puppet → portal → Matrix event.
// Per-thread promise chains preserve message order (appservice-style concurrency
// would otherwise interleave async sends within one conversation).
import type { Bridge } from 'matrix-appservice-bridge';
import type { EchoSuppressor } from './echo-suppressor.ts';
import { buildLinkPreview, buildMediaEvent, fetchFirstMedia, LARGE_MEDIA_MAX_BYTES } from './media-content.ts';
import { bridgeInboundPhoto, bridgeInboundSticker } from './media-handler.ts';
import { buildInboundMentions } from './mentions.ts';
import { SELF_BRIDGE_MARKER } from './outbound-handler.ts';
import type { MappingStore } from './mapping-store.ts';
import { ownerIntent } from './owner-intent.ts';
import type { PortalManager } from './portal-manager.ts';
import type { PuppetRegistry } from './puppet-registry.ts';
import type { ZaloMessage } from '../zalo/types.ts';

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
  bridgedEventIds: Set<string>;
};

/**
 * Bridges Zalo messages into Matrix portal rooms: drops duplicates and echoes of
 * our own sends, provisions the portal and sender ghost, posts the content (text,
 * photo, sticker, media or a notice) and records the msgId ↔ event_id mapping.
 */
export class InboundHandler {
  private readonly deps: InboundHandlerDeps;
  /** threadId → tail of that thread's processing chain (removed once it drains) */
  private readonly threadQueues = new Map<string, Promise<void>>();

  /** @param deps Shared bridge collaborators (see InboundHandlerDeps). */
  constructor(deps: InboundHandlerDeps) {
    this.deps = deps;
  }

  /**
   * Entry point — serializes per thread, never throws (errors are logged).
   * Queues the message behind any message of the same thread still being
   * processed and returns immediately.
   */
  handle(msg: ZaloMessage): void {
    const previous = this.threadQueues.get(msg.threadId) ?? Promise.resolve();
    const next = previous
      .then(() => this.process(msg))
      .catch((err) => console.error(`[bridge] inbound ${msg.msgId} failed:`, err instanceof Error ? err.message : err))
      .finally(() => {
        if (this.threadQueues.get(msg.threadId) === next) this.threadQueues.delete(msg.threadId);
      });
    this.threadQueues.set(msg.threadId, next);
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
      if (msg.content.kind === 'text') this.deps.echo.consume(msg.threadId, msg.content.text);
      else if (msg.content.kind === 'photo' || msg.content.kind === 'media') this.deps.echo.consumeImage(msg.threadId);
      this.deps.store.recordMessage(
        msg.msgId,
        this.deps.store.getPortalByThread(msg.threadId)?.room_id ?? '',
        null,
        'outbound',
        msg.quotable ? JSON.stringify(msg.quotable) : null,
        msg.cliMsgId ?? null,
      );
      return;
    }
    if (this.deps.store.hasMessage(msg.msgId)) return; // duplicate listener event

    // Our own send echoed back by selfListen → already visible in Beeper, don't repost
    const isTextEcho =
      msg.isSelf && msg.content.kind === 'text' && this.deps.echo.consume(msg.threadId, msg.content.text);
    // Every outbound media send (photo, video, file, voice) arms one media marker, so
    // the echo of any of them consumes it — not only photos (a leftover marker would
    // otherwise swallow a real phone photo, and the echo itself would be re-posted)
    const isMediaEcho =
      msg.isSelf &&
      (msg.content.kind === 'photo' || msg.content.kind === 'media') &&
      this.deps.echo.consumeImage(msg.threadId);
    if (isTextEcho || isMediaEcho) {
      // The echo carries the cliMsgId our send response lacked (needed for recall)
      // and a full quotable payload (needed to reply to our own Beeper-sent message)
      this.deps.store.recordMessage(
        msg.msgId,
        this.deps.store.getPortalByThread(msg.threadId)?.room_id ?? '',
        null,
        'outbound',
        msg.quotable ? JSON.stringify(msg.quotable) : null,
        msg.cliMsgId ?? null,
      );
      return;
    }

    const portal = await this.deps.portals.getOrCreatePortal({
      threadId: msg.threadId,
      threadType: msg.threadType,
      senderId: msg.isSelf ? msg.threadId : msg.senderId, // self-DM: portal peer is the thread, not us
      senderName: msg.isSelf ? undefined : msg.senderName,
      resolveGroupName: this.deps.resolveGroupName,
    });

    const intent = msg.isSelf ? this.intentForSelf() : await this.intentForSender(msg, portal.room_id);

    // Extra content fields merged into every post. For our own (double-puppeted)
    // messages this marks them so OutboundHandler never loops them back to Zalo.
    // Zalo quote → Matrix reply: map the quoted msgId to its bridged Matrix event.
    const extraContent: Record<string, unknown> = {};
    if (msg.isSelf) extraContent[SELF_BRIDGE_MARKER] = true;
    if (msg.replyToMsgId) {
      const target = this.deps.store.getEventByZaloMsgId(msg.replyToMsgId);
      if (target?.eventId) extraContent['m.relates_to'] = { 'm.in_reply_to': { event_id: target.eventId } };
    }

    let eventId: string | null = null;
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
          /** Uploads the preview image as the posting intent; returns the mxc:// URI. */
          const upload = (buffer: Buffer, uploadOptions: { type: string; name: string }) =>
            intent.uploadContent(buffer, uploadOptions);
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
      case 'notice': {
        const sent = await intent.sendMessage(portal.room_id, {
          msgtype: 'm.notice',
          body: msg.content.text,
          ...extraContent,
        });
        eventId = sent.event_id;
        break;
      }
      case 'photo': {
        try {
          const bridged = await bridgeInboundPhoto(
            intent,
            portal.room_id,
            msg.content,
            this.deps.mediaMaxBytes,
            extraContent,
          );
          eventId = bridged.eventId;
        } catch (err) {
          const sent = await intent.sendMessage(portal.room_id, {
            msgtype: 'm.notice',
            body: `[Zalo photo could not be bridged: ${(err as Error).message}]`,
            ...extraContent,
          });
          eventId = sent.event_id;
        }
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
      case 'media': {
        const media = msg.content.media;
        // Videos and documents are routinely bigger than the photo cap
        const maxBytes =
          media.kind === 'video' || media.kind === 'file'
            ? Math.max(this.deps.mediaMaxBytes, LARGE_MEDIA_MAX_BYTES)
            : this.deps.mediaMaxBytes;
        const bytes = await fetchFirstMedia(media.urls, maxBytes);
        if (bytes) {
          /** Uploads the media bytes as the posting intent; returns the mxc:// URI. */
          const upload = (buffer: Buffer, uploadOptions: { type: string; name: string }) =>
            intent.uploadContent(buffer, uploadOptions);
          const mediaEvent = await buildMediaEvent(upload, media, bytes);
          const sent = await intent.sendEvent(portal.room_id, mediaEvent.type, {
            ...mediaEvent.content,
            ...extraContent,
          });
          eventId = sent.event_id;
        } else {
          const sent = await intent.sendMessage(portal.room_id, {
            msgtype: 'm.notice',
            body: `[Zalo ${media.kind} could not be bridged${media.filename ? `: ${media.filename}` : ''}]\n${media.urls[0] ?? ''}`,
            ...extraContent,
          });
          eventId = sent.event_id;
        }
        break;
      }
      case 'unsupported': {
        const sent = await intent.sendMessage(portal.room_id, {
          msgtype: 'm.notice',
          body:
            msg.content.msgType === 'e2ee'
              ? '🔒 Tin nhắn mã hoá đầu cuối của Zalo — bridge không giải mã được. Mở Zalo trên điện thoại để đọc. (End-to-end encrypted Zalo message — open Zalo on your phone to read it.)'
              : `[Zalo message type not supported by bridge: ${msg.content.msgType}]`,
          ...extraContent,
        });
        eventId = sent.event_id;
        break;
      }
    }
    // Own phone messages are posted as the owner and will round-trip back to the
    // appservice; mark the event so OutboundHandler never re-sends it to Zalo.
    if (msg.isSelf && eventId) this.deps.bridgedEventIds.add(eventId);
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

  /**
   * Own messages sent from the phone: double-puppet as the owner so they appear
   * in Beeper on the right-hand side. The owner is a real account OUTSIDE the
   * appservice namespace, so we must NOT call ensureRegistered (that 403s / tries
   * to register an existing external user). hungryserv lets the as_token act as
   * the owner directly (verified: whoami?user_id=owner → 200), so we just use the
   * intent and let the first real send confirm/deny capability.
   */
  private intentForSelf() {
    return ownerIntent(this.deps.bridge, this.deps.ownerUserId);
  }
}
