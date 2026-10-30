// Ephemeral signals: Zalo seen/typing/reactions → ghost receipts, typing and reactions in
// Matrix, and the owner's Beeper read receipts / typing → "seen" / typing on Zalo.
// Beeper's own privacy settings decide what is mirrored: with "send typing notifications"
// off it sends no m.typing, with read receipts off only private ones (not m.read).
import type { MappingStore } from './mapping-store.ts';
import type { PuppetRegistry } from './puppet-registry.ts';
import { zaloToEmoji } from '../zalo/reaction-map.ts';
import type { ZaloClient } from '../zalo/zalo-client.ts';
import type { ZaloReactionEvent, ZaloSeenEvent, ZaloTypingEvent } from '../zalo/types.ts';
import { errorMessage } from '../error-message.ts';

/** A ghost's typing indicator is cleared after this long without a new typing event. */
const TYPING_STOP_MS = 8_000;

/** Mirrors read receipts, typing indicators and reactions between Zalo and Matrix portals. */
export class PresenceHandler {
  private readonly store: MappingStore;
  private readonly puppets: PuppetRegistry;
  /** own Zalo uid — group seenUids can include it; a ghost of the OWNER must never join */
  private readonly getOwnZaloId: () => string | null;
  /** auto-stop timers keyed by roomId|uid so repeated typing events extend, not stack */
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();

  private readonly zalo: ZaloClient;
  private readonly ownerUserId: string;

  /**
   * @param store - Portal and message mappings.
   * @param puppets - Ghost intents for Zalo users.
   * @param zalo - Zalo client, used to send seen/typing to Zalo.
   * @param ownerUserId - Owner's Matrix ID (whose receipts/typing are mirrored to Zalo).
   * @param getOwnZaloId - Own Zalo uid (null while logged out).
   */
  constructor(
    store: MappingStore,
    puppets: PuppetRegistry,
    zalo: ZaloClient,
    ownerUserId: string,
    getOwnZaloId: () => string | null,
  ) {
    this.store = store;
    this.puppets = puppets;
    this.zalo = zalo;
    this.ownerUserId = ownerUserId;
    this.getOwnZaloId = getOwnZaloId;
  }

  /**
   * Owner read a portal in Beeper → mark seen on Zalo (m.receipt EDU).
   * Does nothing when the room is not a portal, the owner has no `m.read` receipt in the EDU,
   * or the read event has no seen target with cliMsgId + senderId.
   *
   * @param roomId - Room the receipt EDU belongs to.
   * @param content - EDU content: `{ [eventId]: { 'm.read': { [userId]: ... } } }`.
   * @throws Errors from `zalo.sendSeen`.
   */
  async handleOwnerReceipt(roomId: string, content: Record<string, unknown>): Promise<void> {
    const portal = this.store.getPortalByRoom(roomId);
    if (!portal) return;
    // Find the most recent read event id belonging to the owner
    let readEventId: string | null = null;
    for (const [eventId, receipts] of Object.entries(content)) {
      const readBy = (receipts as { 'm.read'?: Record<string, unknown> })['m.read'];
      if (readBy && this.ownerUserId in readBy) readEventId = eventId;
    }
    if (!readEventId) return;
    const target = this.store.getSeenTargetByEventId(readEventId);
    if (!target?.cliMsgId || !target.senderId) return;
    await this.zalo.sendSeen(
      portal.thread_id,
      portal.thread_type,
      target.zaloMsgId,
      target.cliMsgId,
      target.senderId,
      target.msgType ?? 'webchat',
    );
  }

  /**
   * Owner typing in a portal → show typing on Zalo (m.typing EDU).
   *
   * @param roomId - Room the typing EDU belongs to.
   * @param userIds - Users currently typing; nothing happens unless the owner is among them.
   */
  async handleOwnerTyping(roomId: string, userIds: string[]): Promise<void> {
    if (!userIds.includes(this.ownerUserId)) return;
    const portal = this.store.getPortalByRoom(roomId);
    if (!portal) return;
    await this.zalo.sendTyping(portal.thread_id, portal.thread_type);
  }

  /**
   * Zalo "seen" event → Matrix read receipts sent by the ghosts of the readers.
   * Skips unknown portals and messages that were never bridged; per-ghost receipt failures
   * are logged, not thrown.
   *
   * @param event - Zalo seen event (msgId, thread and, for groups, the reader uids).
   */
  async handleSeen(event: ZaloSeenEvent): Promise<void> {
    const portal = this.store.getPortalByThread(event.threadId);
    if (!portal) return;
    const eventId = this.store.getEventIdByMsgId(event.msgId);
    if (!eventId) return; // message predates the bridge or wasn't bridged

    // DM: the peer (thread id) saw it; group: exactly the uids Zalo reports.
    // Never emit a receipt for the owner's own uid — that would join an
    // owner-doppelganger ghost into the room ("seen by @sh-zalo_<own-uid>").
    const ownId = this.getOwnZaloId();
    const readerUids = (event.threadType === 'user' ? [event.threadId] : event.seenUids).filter(
      (uid) => String(uid) !== ownId && uid !== '',
    );
    for (const uid of readerUids) {
      await this.puppets
        .intentFor(uid)
        .sendReadReceipt(portal.room_id, eventId)
        .catch((err: unknown) => console.warn(`read receipt ${uid}@${portal.room_id} failed:`, errorMessage(err)));
    }
  }

  /**
   * Inbound reaction (Zalo→Beeper): ghost annotates the bridged Matrix event.
   * Removals (no icon) are skipped; a failed send is logged, not thrown.
   *
   * @param event - Zalo reaction event.
   * @throws Errors from `puppets.ensurePuppet` (ghost registration/profile).
   */
  async handleReaction(event: ZaloReactionEvent): Promise<void> {
    // Our own reaction (made from Beeper) echoes back via selfListen — it's already
    // shown as the owner's reaction, so re-posting it as a ghost of ourselves would
    // create a nameless "@sh-zalo_<own-uid>" reaction. Skip it.
    if (event.isSelf || event.senderId === this.getOwnZaloId()) return;
    const target = this.store.getEventByZaloMsgId(event.targetMsgId);
    if (!target?.eventId) return; // reacted-to message not bridged
    if (!event.icon) return; // reaction removal — Matrix has no clean un-react via appservice; skip
    // ensurePuppet so the reacting ghost has a name + avatar (they may not have messaged yet)
    const intent = await this.puppets.ensurePuppet(event.senderId, event.senderName);
    await intent
      .sendEvent(target.roomId, 'm.reaction', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: target.eventId, key: zaloToEmoji(event.icon) },
      })
      .catch((err: unknown) => console.warn('inbound reaction failed:', errorMessage(err)));
  }

  /**
   * Zalo typing event → the sender's ghost shows typing in the portal, auto-cleared after
   * TYPING_STOP_MS (Zalo sends no "stopped typing"). A new event for the same room/user resets
   * the timer. Matrix typing errors are swallowed (typing is cosmetic).
   *
   * @param event - Zalo typing event.
   */
  async handleTyping(event: ZaloTypingEvent): Promise<void> {
    if (event.uid === this.getOwnZaloId()) return;
    const portal = this.store.getPortalByThread(event.threadId);
    if (!portal) return;
    const intent = this.puppets.intentFor(event.uid);
    const timerKey = `${portal.room_id}|${event.uid}`;

    await intent.sendTyping(portal.room_id, true).catch(() => undefined);
    const existingTimer = this.typingTimers.get(timerKey);
    if (existingTimer) clearTimeout(existingTimer);
    this.typingTimers.set(
      timerKey,
      setTimeout(() => {
        this.typingTimers.delete(timerKey);
        void intent.sendTyping(portal.room_id, false).catch(() => undefined);
      }, TYPING_STOP_MS),
    );
  }
}
