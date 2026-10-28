// Zalo thread → Matrix portal room, created on first message.
// Creation is serialized per-thread with an in-flight promise map so concurrent
// messages from a new thread cannot provision duplicate rooms.
import type { Bridge } from 'matrix-appservice-bridge';
import { tagPortalNetwork, type NetworkBranding } from '../matrix/network-branding.ts';
import type { MappingStore, PortalRow } from './mapping-store.ts';
import { ownerIntent } from './owner-intent.ts';
import type { PuppetRegistry } from './puppet-registry.ts';
import type { ZaloThreadType } from '../zalo/types.ts';

/** What PortalManager needs to know about a thread to find or create its portal. */
export type PortalContext = {
  threadId: string;
  threadType: ZaloThreadType;
  /** ghost that triggers creation (DM peer / first group speaker) */
  senderId: string;
  senderName?: string;
  /** resolver for group display names (zca-js getGroupInfo behind the facade) */
  resolveGroupName?: (threadId: string) => Promise<string | null>;
};

/**
 * Owns the Zalo thread → Matrix portal room lifecycle: creates and brands rooms,
 * auto-joins the owner, gets group ghosts into rooms, and runs startup repairs
 * over the persisted portals.
 */
export class PortalManager {
  private readonly bridge: Bridge;
  private readonly store: MappingStore;
  private readonly puppets: PuppetRegistry;
  private readonly ownerUserId: string;
  private readonly branding: NetworkBranding;
  /** threadId → portal creation still in progress (dedups concurrent creation) */
  private readonly inFlight = new Map<string, Promise<PortalRow>>();
  /** roomIds where the owner's auto-join was ensured this run */
  private readonly ownerJoined = new Set<string>();
  /** "roomId|ghostMxid" pairs whose join + room profile were ensured this run */
  private readonly ghostJoined = new Set<string>();

  /**
   * @param bridge Appservice bridge (bot + ghost/owner Intents).
   * @param store Persistent portal/puppet mappings.
   * @param puppets Ghost registry (DM rooms are created by the peer's ghost).
   * @param ownerUserId MXID of the owner, invited to and auto-joined into every portal.
   * @param branding Network branding emitted as room state on every portal.
   */
  constructor(
    bridge: Bridge,
    store: MappingStore,
    puppets: PuppetRegistry,
    ownerUserId: string,
    branding: NetworkBranding,
  ) {
    this.bridge = bridge;
    this.store = store;
    this.puppets = puppets;
    this.ownerUserId = ownerUserId;
    this.branding = branding;
  }

  /**
   * Startup repair: older syncs created portals from prefixed pinned ids ("u123" /
   * "g123") that never match a real Zalo thread. Take the owner out of those empty
   * rooms (so they vanish from Beeper) and drop their rows + bogus puppets.
   * A failed leave is logged; the rows are dropped regardless.
   * @returns Number of portals removed.
   */
  async removeMalformedPortals(): Promise<number> {
    let removed = 0;
    for (const portal of this.store.getAllPortals()) {
      if (/^\d+$/.test(portal.thread_id)) continue;
      try {
        // Not Intent.leave(): that goes through bot-sdk's own ensureRegistered → M_EXCLUSIVE
        await ownerIntent(this.bridge, this.ownerUserId).matrixClient.leaveRoom(portal.room_id);
      } catch (err) {
        console.warn(`[bridge] owner leave ${portal.room_id} failed:`, (err as Error).message);
      }
      this.store.deletePortal(portal.thread_id);
      removed++;
    }
    this.store.deleteMalformedPuppets();
    if (removed) console.log(`[bridge] removed ${removed} malformed portal(s)`);
    return removed;
  }

  /**
   * Startup repair: join the owner into every known portal. Portals created while
   * the owner auto-join was broken are stuck at "invite" and stay invisible in Beeper.
   */
  async joinOwnerToExistingPortals(): Promise<void> {
    for (const portal of this.store.getAllPortals()) await this.ensureOwnerJoined(portal.room_id);
  }

  /**
   * Give unnamed DM ghosts their Zalo name (portals created from the owner's own
   * message had none, so Beeper listed the chat as "sh-zalo_<uid>"). Run once Zalo is
   * connected — the name comes from a Zalo profile lookup.
   */
  async repairDmGhostNames(): Promise<void> {
    for (const portal of this.store.getAllPortals()) {
      if (portal.thread_type !== 'user' || this.store.getPuppetDisplayName(portal.thread_id) !== null) continue;
      await this.puppets.ensurePuppet(portal.thread_id);
    }
  }

  /**
   * Re-emit the network state event on every existing portal (branding backfill).
   * @throws When sending the state event to a room fails (stops the backfill).
   */
  async rebrandExistingPortals(): Promise<void> {
    const botMxid = this.bridge.getBot().getUserId();
    for (const portal of this.store.getAllPortals()) {
      // State must be sent by a member with power: the ghost created DMs, the bot created groups
      const intent = portal.thread_type === 'user' ? this.puppets.intentFor(portal.thread_id) : this.bridge.getIntent();
      await tagPortalNetwork(
        intent,
        portal.room_id,
        portal.thread_id,
        this.channelName(portal),
        portal.thread_type,
        this.branding,
        botMxid,
        portal.account_id,
      );
    }
  }

  /**
   * `channel.displayname` for a portal's bridge-info: the group name, or for a DM the
   * contact's name (DM portals often have no stored name; "Zalo" was a poor stand-in).
   */
  private channelName(portal: PortalRow): string {
    const contactName = portal.thread_type === 'user' ? this.store.getPuppetDisplayName(portal.thread_id) : null;
    return portal.name ?? contactName ?? portal.thread_id;
  }

  /** True when the Matrix room is a portal (delegates to the store). */
  isPortalRoom(roomId: string): boolean {
    return this.store.isPortalRoom(roomId);
  }

  /**
   * Returns the thread's portal, creating it on first use. An existing portal
   * gets its owner auto-join (re)ensured; concurrent calls for a thread that is
   * still being created share the same in-flight creation, so exactly one room is
   * provisioned.
   * @throws When room creation or branding fails (the next message retries).
   */
  async getOrCreatePortal(ctx: PortalContext): Promise<PortalRow> {
    const existing = this.store.getPortalByThread(ctx.threadId);
    if (existing) {
      await this.ensureOwnerJoined(existing.room_id);
      return existing;
    }

    const pending = this.inFlight.get(ctx.threadId);
    if (pending) return pending;

    const creation = this.createPortal(ctx).finally(() => this.inFlight.delete(ctx.threadId));
    this.inFlight.set(ctx.threadId, creation);
    return creation;
  }

  /**
   * Auto-accept the portal invite as the owner (hungryserv lets the as_token
   * double-puppet the owner). Without this, chats stay invisible until the user
   * manually accepts, and sending fails with "no permission" while un-joined.
   * A failure is retried on the next message for that room (logged, never thrown).
   */
  private async ensureOwnerJoined(roomId: string): Promise<void> {
    if (this.ownerJoined.has(roomId)) return;
    try {
      await ownerIntent(this.bridge, this.ownerUserId).join(roomId);
      this.ownerJoined.add(roomId);
    } catch (err) {
      console.warn(`[bridge] owner auto-join ${roomId} failed (manual accept needed):`, (err as Error).message);
    }
  }

  /**
   * Creates the Matrix room, persists the portal row right away, then brands it
   * and joins the owner.
   */
  private async createPortal(ctx: PortalContext): Promise<PortalRow> {
    const row = await this.provisionRoom(ctx);
    this.store.insertPortal(row);
    await this.finishRoom(row, ctx.senderId);
    return row;
  }

  /**
   * History rebuild: a fully set-up portal room (branding, owner joined) that is NOT
   * recorded yet — live traffic keeps using the old room until the importer repoints.
   */
  async createDetachedPortal(ctx: PortalContext): Promise<PortalRow> {
    const row = await this.provisionRoom(ctx);
    await this.finishRoom(row, ctx.senderId);
    return row;
  }

  /**
   * Post-creation setup shared by live and detached portals: tags the room with
   * the network branding state and auto-joins the owner.
   * @param row The newly created portal.
   * @param senderId Zalo uid of the DM peer whose ghost created the room.
   */
  private async finishRoom(row: PortalRow, senderId: string): Promise<void> {
    // Network state must be sent by the room creator (ghost for DM, bot for group)
    const brandIntent = row.thread_type === 'user' ? this.puppets.intentFor(senderId) : this.bridge.getIntent();
    await tagPortalNetwork(
      brandIntent,
      row.room_id,
      row.thread_id,
      this.channelName(row),
      row.thread_type,
      this.branding,
      this.bridge.getBot().getUserId(),
      row.account_id ?? this.store.currentAccountId,
    );
    await this.ensureOwnerJoined(row.room_id);
  }

  /**
   * Creates the Matrix room for a thread (not persisted). DMs are created by the
   * peer's ghost as a direct chat; groups by the bot, named from `resolveGroupName`
   * or "Zalo group <last 6 id digits>". The owner is invited in both cases.
   * @returns The portal row describing the new room.
   */
  private async provisionRoom(ctx: PortalContext): Promise<PortalRow> {
    let row: PortalRow;
    if (ctx.threadType === 'user') {
      // DM portal: created BY the ghost so Beeper renders it as a direct chat
      const ghostIntent = await this.puppets.ensurePuppet(ctx.senderId, ctx.senderName);
      const { room_id } = await ghostIntent.createRoom({
        createAsClient: true,
        options: {
          invite: [this.ownerUserId],
          is_direct: true,
          preset: 'trusted_private_chat',
          name: ctx.senderName,
        },
      });
      row = { thread_id: ctx.threadId, thread_type: 'user', room_id, name: ctx.senderName ?? null };
    } else {
      const groupName =
        (await ctx.resolveGroupName?.(ctx.threadId).catch(() => null)) ?? `Zalo group ${ctx.threadId.slice(-6)}`;
      const { room_id } = await this.bridge.getIntent().createRoom({
        options: {
          invite: [this.ownerUserId],
          preset: 'private_chat',
          name: groupName,
        },
      });
      row = { thread_id: ctx.threadId, thread_type: 'group', room_id, name: groupName };
    }
    return row;
  }

  /**
   * Group ghosts must be invited by the bot before their first send, and need a
   * per-room member profile — some clients render the bare MXID otherwise.
   * Tries a direct join first and falls back to bot invite + join; a failed
   * profile update is only logged. Cached per room+ghost for this run.
   * @throws When the invite or the second join fails.
   */
  async ensureGhostInRoom(zaloUid: string, roomId: string, displayName?: string): Promise<void> {
    const ghostMxid = this.puppets.mxidFor(zaloUid);
    const joinKey = `${roomId}|${ghostMxid}`;
    if (this.ghostJoined.has(joinKey)) return;

    const ghostIntent = this.puppets.intentFor(zaloUid);
    try {
      await ghostIntent.join(roomId);
    } catch {
      await this.bridge.getIntent().invite(roomId, ghostMxid);
      await ghostIntent.join(roomId);
    }
    if (displayName) {
      await ghostIntent
        .setRoomUserProfile(roomId, { displayname: displayName })
        .catch((err: Error) => console.warn(`setRoomUserProfile(${ghostMxid}) failed:`, err.message));
    }
    this.ghostJoined.add(joinKey);
  }
}
