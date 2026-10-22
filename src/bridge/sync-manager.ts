// On-demand conversation sync (bot command `sync`): pre-creates portals for
// pinned conversations + every group, discovers DM threads from Zalo's recent
// history pages, and best-effort backfills recent messages. Paced deliberately —
// burst API traffic on the user's MAIN Zalo account is a ban-risk surface.
import type { InboundHandler } from "./inbound-handler.ts";
import type { MappingStore } from "./mapping-store.ts";
import type { PortalManager } from "./portal-manager.ts";
import type { ZaloClient } from "../zalo/zalo-client.ts";
import type { ZaloMessage, ZaloThreadType } from "../zalo/types.ts";

const PACE_MS = 1_500;
const HISTORY_COUNT = 30;
// Recent-history pages per thread type (each page spans many threads) — how far back
// DM threads are discovered. Zalo Web exposes no DM list other than this.
const HISTORY_PAGES = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * getPinConversations returns prefixed ids — "u<uid>" for DMs, "g<groupId>" for
 * groups (zca-js setPinnedConversations builds them the same way). Unprefixed ids
 * fall back to group-list membership.
 */
export function parsePinnedId(raw: string, groupSet: ReadonlySet<string>): { threadId: string; type: "user" | "group" } {
  const prefixed = /^([ug])(\d+)$/.exec(raw);
  if (prefixed) return { threadId: prefixed[2]!, type: prefixed[1] === "g" ? "group" : "user" };
  return { threadId: raw, type: groupSet.has(raw) ? "group" : "user" };
}

// Zalo msgIds are numeric strings, increasing over time
function olderMsgId(a: string, b: string): string {
  try {
    return BigInt(a) < BigInt(b) ? a : b;
  } catch {
    return a < b ? a : b;
  }
}

export interface SyncManagerDeps {
  zalo: ZaloClient;
  portals: PortalManager;
  inbound: InboundHandler;
  store: MappingStore;
}

export class SyncManager {
  private readonly deps: SyncManagerDeps;
  private running = false;

  constructor(deps: SyncManagerDeps) {
    this.deps = deps;
  }

  /** Returns a human-readable summary for the management room. */
  async run(): Promise<string> {
    if (this.running) return "Sync already running.";
    this.running = true;
    try {
      return await this.doRun();
    } finally {
      this.running = false;
    }
  }

  /** Walks recent-history pages backwards for one thread type, collecting into `out`. */
  private async collectRecentHistory(threadType: ZaloThreadType, out: Map<string, ZaloMessage>): Promise<{ pages: number; complete: boolean }> {
    let before: string | null = null;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      await sleep(PACE_MS);
      const batch = await this.deps.zalo.fetchRecentMessagesPage(threadType, before);
      if (batch === null) return { pages: page, complete: false };
      if (batch.length === 0) return { pages: page, complete: true };
      let oldest = batch[0]!.msgId;
      for (const msg of batch) {
        out.set(msg.msgId, msg);
        oldest = olderMsgId(oldest, msg.msgId);
      }
      if (oldest === before) return { pages: page + 1, complete: true }; // no further progress
      before = oldest;
    }
    return { pages: HISTORY_PAGES, complete: false };
  }

  private async doRun(): Promise<string> {
    const { zalo, portals, inbound, store } = this.deps;
    const pinned = await zalo.getPinnedThreadIds();
    const groupIds = await zalo.getAllGroupIds();
    // Without the group list we cannot classify pinned ids — a pinned group
    // misfiled as a DM would persist a corrupt portal with no repair path. Abort.
    if (groupIds === null) return "Sync aborted: could not fetch the group list from Zalo (classification unsafe). Try again shortly.";
    const groupSet = new Set(groupIds);

    // Recent history across all threads first: it is the only source of DM threads
    // A room that already shows messages is left alone (history would land below newer
    // messages); empty rooms — e.g. created by an earlier sync — are safe to fill
    const hadPortal = (threadId: string) => {
      const portal = store.getPortalByThread(threadId);
      return portal !== undefined && store.roomHasMessages(portal.room_id);
    };
    const knownBefore = new Set<string>();
    const history = new Map<string, ZaloMessage>();
    const userPages = await this.collectRecentHistory("user", history);
    const groupPages = await this.collectRecentHistory("group", history);

    // Pinned first (user-curated), then every group
    const targets: Array<{ threadId: string; type: "user" | "group" }> = [];
    for (const raw of pinned) {
      const target = parsePinnedId(raw, groupSet);
      if (!targets.some((t) => t.threadId === target.threadId)) targets.push(target);
    }
    for (const id of groupIds) {
      if (!targets.some((t) => t.threadId === id)) targets.push({ threadId: id, type: "group" });
    }

    let portalsEnsured = 0;
    const failures: string[] = [];

    for (const msg of history.values()) if (hadPortal(msg.threadId)) knownBefore.add(msg.threadId);
    for (const target of targets) if (hadPortal(target.threadId)) knownBefore.add(target.threadId);

    for (const target of targets) {
      await sleep(PACE_MS);
      try {
        if (target.type === "user") {
          const profile = await zalo.getUserProfile(target.threadId);
          await portals.getOrCreatePortal({
            threadId: target.threadId,
            threadType: "user",
            senderId: target.threadId, // DM peer uid == thread id
            senderName: profile?.displayName,
          });
        } else {
          await portals.getOrCreatePortal({
            threadId: target.threadId,
            threadType: "group",
            senderId: "",
            resolveGroupName: (id) => zalo.getGroupName(id),
          });
          for (const msg of await zalo.getGroupHistory(target.threadId, HISTORY_COUNT)) history.set(msg.msgId, msg);
        }
        portalsEnsured++;
      } catch (err) {
        failures.push(`${target.threadId}: ${(err as Error).message}`);
      }
    }

    // Replay oldest-first, ONLY into conversations with no bridged messages before this sync:
    // posting old messages into a live room would land them below newer ones.
    // Inbound creates any missing portal (DMs) and dedup skips known msgIds.
    const replay = [...history.values()]
      .filter((m) => !knownBefore.has(m.threadId))
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const msg of replay) inbound.handle(msg);
    const dmThreads = new Set(replay.filter((m) => m.threadType === "user").map((m) => m.threadId));
    const groupThreads = new Set(replay.filter((m) => m.threadType === "group").map((m) => m.threadId));

    const lines = [
      `Sync done: ${portalsEnsured}/${targets.length} pinned/group conversations ensured (${pinned.length} pinned, ${groupIds.length} groups).`,
      `Recent history: ${replay.length} messages across ${dmThreads.size} DMs + ${groupThreads.size} groups ` +
        `(${userPages.pages} DM pages${userPages.complete ? ", complete" : ""}; ${groupPages.pages} group pages${groupPages.complete ? ", complete" : ""}).`,
      "Empty conversations are filled oldest-first in the background (timestamps = sync time); rooms that already had messages are left as-is.",
      "Zalo keeps no server-side DM history: DMs appear from their next message on.",
    ];
    if (failures.length) lines.push(`Failures: ${failures.join("; ")}`);
    return lines.join("\n");
  }
}
