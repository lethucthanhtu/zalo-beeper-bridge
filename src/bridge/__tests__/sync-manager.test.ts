import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePinnedId, SyncManager, type SyncManagerDeps } from '../sync-manager.ts';
import type { ZaloMessage, ZaloThreadType } from '../../zalo/types.ts';

/** Builds a minimal inbound text message (its text is its msgId; the sender is the thread id). */
const makeMessage = (msgId: string, threadId: string, threadType: ZaloThreadType, timestamp: number): ZaloMessage => ({
  msgId,
  threadId,
  threadType,
  senderId: threadId,
  timestamp,
  isSelf: false,
  content: { kind: 'text', text: msgId },
});

/**
 * Builds a SyncManager over in-memory fakes.
 *
 * @param pages - Recent-history pages served per thread type, in order (`null` = Zalo did not
 *   answer); once exhausted an empty page is served. Group g1 always exists, with one history message.
 * @param existingPortals - Thread ids whose portal exists and already has messages.
 * @param emptyPortals - Thread ids whose portal exists but is still empty.
 * @returns The manager plus recorders: requested pages, handled (replayed) messages, created portals.
 */
function setup(
  pages: Record<ZaloThreadType, Array<ZaloMessage[] | null>>,
  existingPortals: string[] = [],
  emptyPortals: string[] = [],
) {
  const requested: Array<[ZaloThreadType, string | null]> = [];
  const handled: ZaloMessage[] = [];
  const created: string[] = [];
  const deps = {
    zalo: {
      getPinnedThreadIds: async () => [],
      getAllGroupIds: async () => ['g1'],
      /** Records the request and serves the next scripted page for  (empty once exhausted). */
      fetchRecentMessagesPage: async (type: ZaloThreadType, before: string | null) => {
        requested.push([type, before]);
        return pages[type].shift() ?? [];
      },
      getGroupHistory: async () => [makeMessage('50', 'g1', 'group', 50)],
      getGroupName: async () => 'Group',
      getUserProfile: async () => null,
    },
    portals: {
      getOrCreatePortal: async (portalRequest: { threadId: string }) => void created.push(portalRequest.threadId),
    },
    inbound: { handle: (message: ZaloMessage) => void handled.push(message) },
    store: {
      getPortalByThread: (threadId: string) =>
        existingPortals.includes(threadId) || emptyPortals.includes(threadId) ? { room_id: `!${threadId}` } : undefined,
      roomHasMessages: (roomId: string) => existingPortals.includes(roomId.slice(1)),
    },
  } as unknown as SyncManagerDeps;
  return { sync: new SyncManager(deps), requested, handled, created };
}

/** Runs a sync to completion under fake timers (flushes the PACE_MS sleeps) and returns its summary. */
async function runSync(sync: SyncManager): Promise<string> {
  const pending = sync.run();
  await vi.runAllTimersAsync();
  return pending;
}

describe('SyncManager', () => {
  afterEach(() => vi.useRealTimers());

  it('pages DM history backwards and replays new conversations oldest-first', async () => {
    vi.useFakeTimers();
    const { sync, requested, handled, created } = setup({
      user: [
        [makeMessage('300', 'dmA', 'user', 300), makeMessage('200', 'dmB', 'user', 200)],
        [makeMessage('100', 'dmA', 'user', 100)],
        [],
      ],
      group: [[]],
    });
    const summary = await runSync(sync);
    expect(requested).toEqual([
      ['user', null],
      ['user', '200'],
      ['user', '100'],
      ['group', null],
    ]);
    expect(created).toEqual(['g1']);
    expect(handled.map((message) => message.msgId)).toEqual(['50', '100', '200', '300']);
    expect(summary).toContain('2 DMs + 1 groups');
  });

  it('does not replay history into conversations that already had a portal', async () => {
    vi.useFakeTimers();
    const { sync, handled } = setup(
      { user: [[makeMessage('300', 'dmOld', 'user', 300), makeMessage('200', 'dmNew', 'user', 200)], []], group: [[]] },
      ['dmOld', 'g1'],
    );
    await runSync(sync);
    expect(handled.map((message) => message.threadId)).toEqual(['dmNew']);
  });

  it('stops paging when Zalo does not answer', async () => {
    vi.useFakeTimers();
    const { sync, requested } = setup({ user: [null], group: [null] });
    const summary = await runSync(sync);
    expect(requested).toHaveLength(2);
    expect(summary).toContain('0 DM pages');
  });

  it('strips the u/g prefix from pinned conversation ids', () => {
    const groups = new Set(['777']);
    expect(parsePinnedId('u1111111111111111111', groups)).toEqual({ threadId: '1111111111111111111', type: 'user' });
    expect(parsePinnedId('g2222222222222222222', groups)).toEqual({ threadId: '2222222222222222222', type: 'group' });
    expect(parsePinnedId('777', groups)).toEqual({ threadId: '777', type: 'group' });
    expect(parsePinnedId('123', groups)).toEqual({ threadId: '123', type: 'user' });
  });

  it('backfills portals that exist but are still empty', async () => {
    vi.useFakeTimers();
    const { sync, handled } = setup(
      {
        user: [[makeMessage('300', 'dmFull', 'user', 300), makeMessage('200', 'dmEmpty', 'user', 200)], []],
        group: [[]],
      },
      ['dmFull'],
      ['dmEmpty', 'g1'],
    );
    await runSync(sync);
    expect(handled.map((message) => message.threadId)).toEqual(['g1', 'dmEmpty']);
  });
});
