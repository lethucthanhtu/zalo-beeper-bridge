// Zalo thread → Matrix portal room, created on first message.
// Creation is serialized per-thread with an in-flight promise map so concurrent
// messages from a new thread cannot provision duplicate rooms.
import type { Bridge } from "matrix-appservice-bridge";
import { tagPortalNetwork, type NetworkBranding } from "../matrix/network-branding.ts";
import type { MappingStore, PortalRow } from "./mapping-store.ts";
import { ownerIntent } from "./owner-intent.ts";
import type { PuppetRegistry } from "./puppet-registry.ts";
import type { ZaloThreadType } from "../zalo/types.ts";

export interface PortalContext {
  threadId: string;
  threadType: ZaloThreadType;
  /** ghost that triggers creation (DM peer / first group speaker) */
  senderId: string;
  senderName?: string;
  /** resolver for group display names (zca-js getGroupInfo behind the facade) */
  resolveGroupName?: (threadId: string) => Promise<string | null>;
}

export class PortalManager {
  private readonly bridge: Bridge;
  private readonly store: MappingStore;
  private readonly puppets: PuppetRegistry;
  private readonly ownerUserId: string;
  private readonly branding: NetworkBranding;
  private readonly inFlight = new Map<string, Promise<PortalRow>>();
  /** roomIds where the owner's auto-join was ensured this run */
  private readonly ownerJoined = new Set<string>();
  /** "roomId|ghostMxid" pairs whose join + room profile were ensured this run */
  private readonly ghostJoined = new Set<string>();

  constructor(bridge: Bridge, store: MappingStore, puppets: PuppetRegistry, ownerUserId: string, branding: NetworkBranding) {
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

  /** Re-emit the network state event on every existing portal (branding backfill). */
  async rebrandExistingPortals(): Promise<void> {
    const botMxid = this.bridge.getBot().getUserId();
    for (const portal of this.store.getAllPortals()) {
      // State must be sent by a member with power: the ghost created DMs, the bot created groups
      const intent = portal.thread_type === "user" ? this.puppets.intentFor(portal.thread_id) : this.bridge.getIntent();
      await tagPortalNetwork(intent, portal.room_id, portal.thread_id, portal.name ?? this.branding.name, portal.thread_type, this.branding, botMxid);
    }
  }

  isPortalRoom(roomId: string): boolean {
    return this.store.isPortalRoom(roomId);
  }

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
   * A failure is retried on the next message for that room.
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

  private async createPortal(ctx: PortalContext): Promise<PortalRow> {
    let row: PortalRow;
    if (ctx.threadType === "user") {
      // DM portal: created BY the ghost so Beeper renders it as a direct chat
      const ghostIntent = await this.puppets.ensurePuppet(ctx.senderId, ctx.senderName);
      const { room_id } = await ghostIntent.createRoom({
        createAsClient: true,
        options: {
          invite: [this.ownerUserId],
          is_direct: true,
          preset: "trusted_private_chat",
          name: ctx.senderName,
        },
      });
      row = { thread_id: ctx.threadId, thread_type: "user", room_id, name: ctx.senderName ?? null };
    } else {
      const groupName = (await ctx.resolveGroupName?.(ctx.threadId).catch(() => null)) ?? `Zalo group ${ctx.threadId.slice(-6)}`;
      const { room_id } = await this.bridge.getIntent().createRoom({
        options: {
          invite: [this.ownerUserId],
          preset: "private_chat",
          name: groupName,
        },
      });
      row = { thread_id: ctx.threadId, thread_type: "group", room_id, name: groupName };
    }
    this.store.insertPortal(row);
    // Network state must be sent by the room creator (ghost for DM, bot for group)
    const brandIntent = ctx.threadType === "user" ? this.puppets.intentFor(ctx.senderId) : this.bridge.getIntent();
    await tagPortalNetwork(brandIntent, row.room_id, row.thread_id, row.name ?? this.branding.name, row.thread_type, this.branding, this.bridge.getBot().getUserId());
    await this.ensureOwnerJoined(row.room_id);
    return row;
  }

  /**
   * Group ghosts must be invited by the bot before their first send, and need a
   * per-room member profile — some clients render the bare MXID otherwise.
   */
  async ensureGhostInRoom(zaloUid: string, roomId: string, displayName?: string): Promise<void> {
    const ghostMxid = this.puppets.mxidFor(zaloUid);
    const key = `${roomId}|${ghostMxid}`;
    if (this.ghostJoined.has(key)) return;

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
    this.ghostJoined.add(key);
  }
}
