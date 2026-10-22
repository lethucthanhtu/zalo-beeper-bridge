import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePinnedId, SyncManager, type SyncManagerDeps } from "../sync-manager.ts";
import type { ZaloMessage, ZaloThreadType } from "../../zalo/types.ts";

const msg = (msgId: string, threadId: string, threadType: ZaloThreadType, timestamp: number): ZaloMessage => ({
  msgId,
  threadId,
  threadType,
  senderId: threadId,
  timestamp,
  isSelf: false,
  content: { kind: "text", text: msgId },
});

function setup(pages: Record<ZaloThreadType, Array<ZaloMessage[] | null>>, existingPortals: string[] = [], emptyPortals: string[] = []) {
  const requested: Array<[ZaloThreadType, string | null]> = [];
  const handled: ZaloMessage[] = [];
  const created: string[] = [];
  const deps = {
    zalo: {
      getPinnedThreadIds: async () => [],
      getAllGroupIds: async () => ["g1"],
      fetchRecentMessagesPage: async (type: ZaloThreadType, before: string | null) => {
        requested.push([type, before]);
        return pages[type].shift() ?? [];
      },
      getGroupHistory: async () => [msg("50", "g1", "group", 50)],
      getGroupName: async () => "Group",
      getUserProfile: async () => null,
    },
    portals: { getOrCreatePortal: async (ctx: { threadId: string }) => void created.push(ctx.threadId) },
    inbound: { handle: (m: ZaloMessage) => void handled.push(m) },
    store: {
      getPortalByThread: (id: string) => (existingPortals.includes(id) || emptyPortals.includes(id) ? { room_id: `!${id}` } : undefined),
      roomHasMessages: (roomId: string) => existingPortals.includes(roomId.slice(1)),
    },
  } as unknown as SyncManagerDeps;
  return { sync: new SyncManager(deps), requested, handled, created };
}

async function runSync(sync: SyncManager): Promise<string> {
  const pending = sync.run();
  await vi.runAllTimersAsync();
  return pending;
}

describe("SyncManager", () => {
  afterEach(() => vi.useRealTimers());

  it("pages DM history backwards and replays new conversations oldest-first", async () => {
    vi.useFakeTimers();
    const { sync, requested, handled, created } = setup({
      user: [[msg("300", "dmA", "user", 300), msg("200", "dmB", "user", 200)], [msg("100", "dmA", "user", 100)], []],
      group: [[]],
    });
    const summary = await runSync(sync);
    expect(requested).toEqual([
      ["user", null],
      ["user", "200"],
      ["user", "100"],
      ["group", null],
    ]);
    expect(created).toEqual(["g1"]);
    expect(handled.map((m) => m.msgId)).toEqual(["50", "100", "200", "300"]);
    expect(summary).toContain("2 DMs + 1 groups");
  });

  it("does not replay history into conversations that already had a portal", async () => {
    vi.useFakeTimers();
    const { sync, handled } = setup(
      { user: [[msg("300", "dmOld", "user", 300), msg("200", "dmNew", "user", 200)], []], group: [[]] },
      ["dmOld", "g1"],
    );
    await runSync(sync);
    expect(handled.map((m) => m.threadId)).toEqual(["dmNew"]);
  });

  it("stops paging when Zalo does not answer", async () => {
    vi.useFakeTimers();
    const { sync, requested } = setup({ user: [null], group: [null] });
    const summary = await runSync(sync);
    expect(requested).toHaveLength(2);
    expect(summary).toContain("0 DM pages");
  });

  it("strips the u/g prefix from pinned conversation ids", () => {
    const groups = new Set(["777"]);
    expect(parsePinnedId("u2852257225922374180", groups)).toEqual({ threadId: "2852257225922374180", type: "user" });
    expect(parsePinnedId("g6703944863817960632", groups)).toEqual({ threadId: "6703944863817960632", type: "group" });
    expect(parsePinnedId("777", groups)).toEqual({ threadId: "777", type: "group" });
    expect(parsePinnedId("123", groups)).toEqual({ threadId: "123", type: "user" });
  });

  it("backfills portals that exist but are still empty", async () => {
    vi.useFakeTimers();
    const { sync, handled } = setup({ user: [[msg("300", "dmFull", "user", 300), msg("200", "dmEmpty", "user", 200)], []], group: [[]] }, ["dmFull"], ["dmEmpty", "g1"]);
    await runSync(sync);
    expect(handled.map((m) => m.threadId)).toEqual(["g1", "dmEmpty"]);
  });
});
