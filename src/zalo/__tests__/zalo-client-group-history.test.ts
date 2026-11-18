import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZaloClient } from '../zalo-client.ts';

const GROUP = '2222222222222222222';

/** A group text message as zca-js getCloudMessage returns it (identifiers anonymized). */
function groupMsg(msgId: number) {
  return {
    type: 1,
    threadId: GROUP,
    isSelf: false,
    data: {
      msgId: String(msgId),
      msgType: 'webchat',
      uidFrom: '1111111111111111111',
      dName: 'Test Sender',
      ts: String(1_782_964_000_000 + msgId),
      content: `m${msgId}`,
    },
  };
}

/** One getCloudMessage reply page, newest-first like Zalo's. */
function page(ids: number[], extra: Record<string, unknown> = {}) {
  return {
    groupMsgs: ids.map(groupMsg),
    lastMsgId: ids.length ? String(ids[ids.length - 1]) : '0',
    maxMsgId: '0',
    hasMore: 0,
    isOld: 0,
    isFiltered: 0,
    ...extra,
  };
}

/** Descending range of message ids: range(10, 3) = [10, 9, 8]. */
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from - i);

/** A client whose zca-js api only has a stubbed getCloudMessage. */
function clientWith(getCloudMessage: ReturnType<typeof vi.fn>) {
  const client = new ZaloClient({ credsPath: 'unused-history-test.json', messagesPerMinute: 600, burst: 10 });
  (client as unknown as { api: unknown }).api = { getCloudMessage };
  return client;
}

/** Message ids of the normalized history, in returned order. */
const ids = (messages: { msgId: string }[]) => messages.map((m) => Number(m.msgId));

describe('ZaloClient.getGroupHistory', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns [] without a session', async () => {
    const client = new ZaloClient({ credsPath: 'unused.json', messagesPerMinute: 600, burst: 10 });
    expect(await client.getGroupHistory(GROUP)).toEqual([]);
  });

  it('pages back through lastMsgId while hasMore, oldest-first, trimmed to count', async () => {
    const getCloudMessage = vi
      .fn()
      .mockResolvedValueOnce(page(range(100, 20), { hasMore: 1, isOld: 1 }))
      .mockResolvedValueOnce(page(range(80, 20), { hasMore: 1, isOld: 1 }));
    const history = await clientWith(getCloudMessage).getGroupHistory(GROUP, 30);
    expect(getCloudMessage).toHaveBeenNthCalledWith(1, GROUP, undefined, undefined);
    expect(getCloudMessage).toHaveBeenNthCalledWith(2, GROUP, '81', { isOld: 1 });
    expect(getCloudMessage).toHaveBeenCalledTimes(2); // 40 collected >= 30
    expect(ids(history)).toEqual(range(100, 30).reverse()); // newest 30, oldest first
  });

  it('starts from maxMsgId when the first page is empty', async () => {
    const getCloudMessage = vi
      .fn()
      .mockResolvedValueOnce(page([], { maxMsgId: 500 }))
      .mockResolvedValueOnce(page(range(500, 5)));
    const history = await clientWith(getCloudMessage).getGroupHistory(GROUP, 30);
    expect(getCloudMessage).toHaveBeenNthCalledWith(2, GROUP, '500', undefined);
    expect(getCloudMessage).toHaveBeenCalledTimes(2); // hasMore=0 ends paging
    expect(ids(history)).toEqual(range(500, 5).reverse());
  });

  it('stops on an empty filtered page', async () => {
    const getCloudMessage = vi.fn().mockResolvedValueOnce(page([], { maxMsgId: 500, isFiltered: 1 }));
    expect(await clientWith(getCloudMessage).getGroupHistory(GROUP)).toEqual([]);
    expect(getCloudMessage).toHaveBeenCalledOnce();
  });

  it('makes at most 4 calls', async () => {
    let next = 1000;
    const getCloudMessage = vi.fn(async () => {
      const p = page(range(next, 2), { hasMore: 1 });
      next -= 2;
      return p;
    });
    const history = await clientWith(getCloudMessage).getGroupHistory(GROUP, 30);
    expect(getCloudMessage).toHaveBeenCalledTimes(4);
    expect(history).toHaveLength(8);
  });

  it('ends quietly on -69 and keeps the pages already fetched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getCloudMessage = vi
      .fn()
      .mockResolvedValueOnce(page(range(100, 10), { hasMore: 1 }))
      .mockRejectedValueOnce(Object.assign(new Error('Stop retry'), { code: -69 }));
    const history = await clientWith(getCloudMessage).getGroupHistory(GROUP, 30);
    expect(ids(history)).toEqual(range(100, 10).reverse());
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs other failures and keeps the pages already fetched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getCloudMessage = vi
      .fn()
      .mockResolvedValueOnce(page(range(100, 10), { hasMore: 1 }))
      .mockRejectedValueOnce(new Error('network down'));
    const history = await clientWith(getCloudMessage).getGroupHistory(GROUP, 30);
    expect(history).toHaveLength(10);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('logs only cursor metadata, never content, under ZALO_WS_TRACE=1', async () => {
    vi.stubEnv('ZALO_WS_TRACE', '1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const getCloudMessage = vi.fn().mockResolvedValueOnce(page(range(100, 3)));
    await clientWith(getCloudMessage).getGroupHistory(GROUP);
    vi.unstubAllEnvs();
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain(`getCloudMessage ${GROUP} cursor=newest msgs=3`);
    expect(line).not.toContain('m100');
  });
});
