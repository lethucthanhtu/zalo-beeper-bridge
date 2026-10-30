import { describe, expect, it, vi } from 'vitest';
import { ZaloClient } from '../zalo-client.ts';

/** A logged-in client whose zca-js api is a stub. */
function clientWith(api: Record<string, unknown>) {
  const client = new ZaloClient({ credsPath: 'unused.json', messagesPerMinute: 600, burst: 10 });
  (client as unknown as { api: unknown }).api = api;
  return client;
}

describe('ZaloClient.sendText', () => {
  it('sends a text with a link via sendLink so Zalo shows a preview', async () => {
    const api = {
      parseLink: vi.fn().mockResolvedValue({}),
      sendLink: vi.fn().mockResolvedValue({ msgId: 42 }),
      sendMessage: vi.fn(),
    };
    const result = await clientWith(api).sendText('t1', 'user', 'xem https://a.vn/x nhé');
    expect(api.sendLink).toHaveBeenCalledWith({ msg: 'xem https://a.vn/x nhé', link: 'https://a.vn/x' }, 't1', 0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ msgId: '42' });
  });

  it('sends plain text when Zalo cannot parse the link', async () => {
    const api = {
      parseLink: vi.fn().mockRejectedValue(new Error('parse failed')),
      sendLink: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ message: { msgId: 7 } }),
    };
    expect(await clientWith(api).sendText('t1', 'group', 'https://a.vn')).toEqual({ msgId: '7' });
    expect(api.sendLink).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith('https://a.vn', 't1', 1);
  });

  it('never re-sends after a failed sendLink (Zalo may have delivered it)', async () => {
    const api = {
      parseLink: vi.fn().mockResolvedValue({}),
      sendLink: vi.fn().mockRejectedValue(new Error('network')),
      sendMessage: vi.fn(),
    };
    await expect(clientWith(api).sendText('t1', 'user', 'https://a.vn')).rejects.toThrow('network');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps quotes/mentions on sendMessage (sendLink supports neither)', async () => {
    const api = { parseLink: vi.fn(), sendLink: vi.fn(), sendMessage: vi.fn().mockResolvedValue({ message: {} }) };
    const mentions = [{ uid: 'u', pos: 0, len: 2 }];
    await clientWith(api).sendText('t1', 'group', '@A https://a.vn', undefined, undefined, mentions);
    expect(api.parseLink).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith({ msg: '@A https://a.vn', mentions }, 't1', 1);
  });
});
