// Conversation sync from Zalo's recent-history feed: the bot command `sync` (pre-creates
// portals for pinned conversations + every group, discovers DM threads, best-effort
// backfills recent messages) and the automatic catch-up after every listener reconnect
// (messages missed during sleep / restart). Paced deliberately —
// burst API traffic on the user's MAIN Zalo account is a ban-risk surface.
import type { InboundHandler } from './inbound-handler.ts';
import type { MappingStore } from './mapping-store.ts';
import type { PortalManager } from './portal-manager.ts';
import type { ZaloClient } from '../zalo/zalo-client.ts';
import type { ZaloMessage, ZaloThreadType } from '../zalo/types.ts';
import { errorMessage } from '../error-message.ts';

/** Pause before every Zalo API call of the sync. */
const PACE_MS = 1_500;
/** Messages fetched per group via getGroupHistory. */
const HISTORY_COUNT = 30;
// Recent-history pages per thread type (each page spans many threads) — how far back
// DM threads are discovered. Zalo Web exposes no DM list other than this.
const HISTORY_PAGES = 10;
// Catch-up pages per thread type after a reconnect (~50 messages each): covers a night of
// sleep on a busy account without unbounded paging
const CATCH_UP_PAGES = 10;

/** Resolves after `ms` milliseconds. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * getPinConversations returns prefixed ids — "u<uid>" for DMs, "g<groupId>" for
 * groups (zca-js setPinnedConversations builds them the same way). Unprefixed ids
 * fall back to group-list membership.
 *
 * @param rawId - Pinned conversation id as returned by Zalo.
 * @param groupSet - All known group ids, used to classify unprefixed ids.
 * @returns The bare thread id and its type.
 */
export function parsePinnedId(
  rawId: string,
  groupSet: ReadonlySet<string>,
): { threadId: string; type: 'user' | 'group' } {
  const prefixed = /^([ug])(\d+)$/.exec(rawId);
  if (prefixed) return { threadId: prefixed[2]!, type: prefixed[1] === 'g' ? 'group' : 'user' };
  return { threadId: rawId, type: groupSet.has(rawId) ? 'group' : 'user' };
}

/**
 * Returns the older of two Zalo msgIds. Zalo msgIds are numeric strings, increasing over time,
 * so they are compared as BigInt; a non-numeric id falls back to string comparison.
 */
function olderMsgId(firstMsgId: string, secondMsgId: string): string {
  try {
    return BigInt(firstMsgId) < BigInt(secondMsgId) ? firstMsgId : secondMsgId;
  } catch {
    return firstMsgId < secondMsgId ? firstMsgId : secondMsgId;
  }
}

/** Collaborators of {@link SyncManager}. */
export type SyncManagerDeps = {
  zalo: ZaloClient;
  portals: PortalManager;
  inbound: InboundHandler;
  store: MappingStore;
};

/** Runs the `sync` bot command; at most one sync at a time. */
export class SyncManager {
  private readonly deps: SyncManagerDeps;
  /** True while a sync is in progress (re-entrancy guard). */
  private running = false;

  /** @param deps - Zalo client, portal manager, inbound handler and mapping store. */
  constructor(deps: SyncManagerDeps) {
    this.deps = deps;
  }

  /**
   * Runs one sync unless one is already running.
   *
   * @returns A human-readable summary for the management room ("Sync already running." when busy).
   * @throws Zalo API errors outside the per-conversation try/catch (pinned/group list, history pages).
   */
  async run(): Promise<string> {
    if (this.running) return 'Sync already running.';
    this.running = true;
    try {
      return await this.doRun();
    } finally {
      this.running = false;
    }
  }

  /**
   * Catch-up after the Zalo listener (re)connects: Zalo does not re-push what arrived while
   * the bridge was away (sleep, restart, network drop), and one recent-feed page holds only
   * the newest ~50 messages per thread type. Pages back until a page reaches a message that
   * is already bridged (the gap is closed) or CATCH_UP_PAGES, then replays everything
   * oldest-first through the inbound pipeline (msgId dedup drops what is already bridged).
   * A fresh install (nothing bridged yet) takes one page, as before. Skipped while a sync
   * runs — it pages the same feed.
   */
  async catchUp(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { store, inbound } = this.deps;
      const maxPages = store.hasAnyMessage() ? CATCH_UP_PAGES : 1;
      const reachedBridged = (page: ZaloMessage[]) => page.some((message) => store.hasMessage(message.msgId));
      const history = new Map<string, ZaloMessage>();
      for (const threadType of ['user', 'group'] as const) {
        const { pages, complete } = await this.collectRecentHistory(threadType, history, maxPages, reachedBridged);
        console.log(`[sync] catch-up ${threadType}: ${pages} page(s)${complete ? '' : ' (stopped at the page limit)'}`);
      }
      for (const message of [...history.values()].sort((a, b) => a.timestamp - b.timestamp)) inbound.handle(message);
    } finally {
      this.running = false;
    }
  }

  /**
   * Walks recent-history pages backwards for one thread type, collecting into `collected`
   * (keyed by msgId, so overlapping pages dedupe). Paced by PACE_MS before each page.
   *
   * @param threadType - `user` (DMs) or `group`.
   * @param collected - Output map, mutated in place.
   * @param maxPages - Page limit.
   * @param isEnough - Stops after a page for which it returns true.
   * @returns Pages fetched, and whether the walk ended on its own (history end or `isEnough`;
   *   `false` when Zalo did not answer or `maxPages` was hit first).
   */
  private async collectRecentHistory(
    threadType: ZaloThreadType,
    collected: Map<string, ZaloMessage>,
    maxPages = HISTORY_PAGES,
    isEnough: (page: ZaloMessage[]) => boolean = () => false,
  ): Promise<{ pages: number; complete: boolean }> {
    let beforeMsgId: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      await sleep(PACE_MS);
      const pageMessages = await this.deps.zalo.fetchRecentMessagesPage(threadType, beforeMsgId);
      if (pageMessages === null) return { pages: page, complete: false };
      if (pageMessages.length === 0) return { pages: page, complete: true };
      let oldestMsgId = pageMessages[0]!.msgId;
      for (const message of pageMessages) {
        collected.set(message.msgId, message);
        oldestMsgId = olderMsgId(oldestMsgId, message.msgId);
      }
      if (isEnough(pageMessages)) return { pages: page + 1, complete: true };
      if (oldestMsgId === beforeMsgId) return { pages: page + 1, complete: true }; // no further progress
      beforeMsgId = oldestMsgId;
    }
    return { pages: maxPages, complete: false };
  }

  /**
   * The actual sync: collects recent DM + group history, ensures a portal for every pinned
   * conversation and group (paced, failures collected per conversation), then replays the
   * collected history oldest-first into conversations that had no bridged messages before.
   *
   * Side effects: Zalo API calls, portal (Matrix room) creation, and fire-and-forget
   * `inbound.handle` calls that post messages into Matrix in the background.
   *
   * @returns The multi-line summary for the management room.
   */
  private async doRun(): Promise<string> {
    const { zalo, portals, inbound, store } = this.deps;
    const pinned = await zalo.getPinnedThreadIds();
    const groupIds = await zalo.getAllGroupIds();
    // Without the group list we cannot classify pinned ids — a pinned group
    // misfiled as a DM would persist a corrupt portal with no repair path. Abort.
    if (groupIds === null)
      return 'Sync aborted: could not fetch the group list from Zalo (classification unsafe). Try again shortly.';
    const groupSet = new Set(groupIds);

    // Recent history across all threads first: it is the only source of DM threads
    // A room that already shows messages is left alone (history would land below newer
    // messages); empty rooms — e.g. created by an earlier sync — are safe to fill
    /** True when the thread already has a portal room that contains bridged messages. */
    const hadPortal = (threadId: string) => {
      const portal = store.getPortalByThread(threadId);
      return portal !== undefined && store.roomHasMessages(portal.room_id);
    };
    const knownBefore = new Set<string>();
    const history = new Map<string, ZaloMessage>();
    const userPages = await this.collectRecentHistory('user', history);
    const groupPages = await this.collectRecentHistory('group', history);

    // Pinned first (user-curated), then every group
    const targets: Array<{ threadId: string; type: 'user' | 'group' }> = [];
    for (const rawId of pinned) {
      const target = parsePinnedId(rawId, groupSet);
      if (!targets.some((existing) => existing.threadId === target.threadId)) targets.push(target);
    }
    for (const groupId of groupIds) {
      if (!targets.some((existing) => existing.threadId === groupId))
        targets.push({ threadId: groupId, type: 'group' });
    }

    let portalsEnsured = 0;
    const failures: string[] = [];

    for (const message of history.values()) if (hadPortal(message.threadId)) knownBefore.add(message.threadId);
    for (const target of targets) if (hadPortal(target.threadId)) knownBefore.add(target.threadId);

    for (const target of targets) {
      await sleep(PACE_MS);
      try {
        if (target.type === 'user') {
          const profile = await zalo.getUserProfile(target.threadId);
          await portals.getOrCreatePortal({
            threadId: target.threadId,
            threadType: 'user',
            senderId: target.threadId, // DM peer uid == thread id
            senderName: profile?.displayName,
          });
        } else {
          await portals.getOrCreatePortal({
            threadId: target.threadId,
            threadType: 'group',
            senderId: '',
            resolveGroupName: (groupId) => zalo.getGroupName(groupId),
          });
          for (const message of await zalo.getGroupHistory(target.threadId, HISTORY_COUNT))
            history.set(message.msgId, message);
        }
        portalsEnsured++;
      } catch (err) {
        failures.push(`${target.threadId}: ${errorMessage(err)}`);
      }
    }

    // Replay oldest-first, ONLY into conversations with no bridged messages before this sync:
    // posting old messages into a live room would land them below newer ones.
    // Inbound creates any missing portal (DMs) and dedup skips known msgIds.
    const replay = [...history.values()]
      .filter((message) => !knownBefore.has(message.threadId))
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const message of replay) inbound.handle(message);
    const dmThreads = new Set(
      replay.filter((message) => message.threadType === 'user').map((message) => message.threadId),
    );
    const groupThreads = new Set(
      replay.filter((message) => message.threadType === 'group').map((message) => message.threadId),
    );

    const lines = [
      `Sync done: ${portalsEnsured}/${targets.length} pinned/group conversations ensured (${pinned.length} pinned, ${groupIds.length} groups).`,
      `Recent history: ${replay.length} messages across ${dmThreads.size} DMs + ${groupThreads.size} groups ` +
        `(${userPages.pages} DM pages${userPages.complete ? ', complete' : ''}; ${groupPages.pages} group pages${groupPages.complete ? ', complete' : ''}).`,
      'Empty conversations are filled oldest-first in the background (timestamps = sync time); rooms that already had messages are left as-is.',
      'Zalo keeps no server-side DM history: DMs appear from their next message on.',
    ];
    if (failures.length) lines.push(`Failures: ${failures.join('; ')}`);
    return lines.join('\n');
  }
}
