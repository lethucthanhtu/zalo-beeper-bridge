import { describe, expect, it, vi } from 'vitest';
import { ZaloClient } from '../zalo-client.ts';

/** A logged-in client whose zca-js api is a stub. */
function clientWith(api: Record<string, unknown>) {
  const client = new ZaloClient({ credsPath: 'unused.json', messagesPerMinute: 600, burst: 10 });
  (client as unknown as { api: unknown }).api = api;
  return client;
}

/** parseLink result for a page Zalo could crawl */
const PARSED = {
  data: { title: 'Page', desc: '', thumb: 'https://img/t.jpg', href: 'https://a.vn/x', src: 'a.vn', media: {} },
};

describe('ZaloClient.sendText', () => {
  it('sends a text with a link via sendLink so Zalo shows a preview', async () => {
    const api = {
      parseLink: vi.fn().mockResolvedValue(PARSED),
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
      parseLink: vi.fn().mockResolvedValue(PARSED),
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

  it('sends plain text when Zalo can parse the link but build no preview (no empty card)', async () => {
    const api = {
      parseLink: vi.fn().mockResolvedValue({ data: { title: '', desc: '', thumb: '', href: 'https://a.vn' } }),
      sendLink: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ message: { msgId: 8 } }),
    };
    expect(await clientWith(api).sendText('t1', 'user', 'https://a.vn')).toEqual({ msgId: '8' });
    expect(api.sendLink).not.toHaveBeenCalled();
  });

  it('sends plain text when the owner removed the preview in Beeper', async () => {
    const api = { parseLink: vi.fn(), sendLink: vi.fn(), sendMessage: vi.fn().mockResolvedValue({ message: {} }) };
    await clientWith(api).sendText('t1', 'user', 'https://a.vn', undefined, undefined, undefined, null);
    expect(api.parseLink).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith('https://a.vn', 't1', 0);
  });

  it("builds the Zalo card from Beeper's preview title/description", async () => {
    const custom = vi.fn();
    const request = vi.fn().mockResolvedValue('response');
    const api = {
      parseLink: vi.fn().mockResolvedValue(PARSED),
      sendLink: vi.fn(),
      sendMessage: vi.fn(),
      zpwServiceMap: { chat: ['https://chat'], group: ['https://group'] },
      custom: (name: string, callback: (p: unknown) => unknown) => {
        custom(name);
        (api as Record<string, unknown>)[name] = (props: unknown) =>
          callback({
            ctx: { imei: 'imei' },
            utils: {
              makeURL: (url: string) => url,
              encodeAES: (data: string) => data,
              request,
              resolve: async () => ({ msgId: 99 }),
            },
            props,
          });
      },
    };
    const client = clientWith(api);
    const preview = { url: 'https://a.vn/x', title: 'Beeper title', description: 'Beeper desc' };
    expect(
      await client.sendText('g1', 'group', 'xem https://a.vn/x', undefined, undefined, undefined, preview),
    ).toEqual({ msgId: '99' });
    await client.sendText('g1', 'group', 'again https://a.vn/x', undefined, undefined, undefined, preview);
    expect(custom).toHaveBeenCalledTimes(1); // registered once per api
    expect(api.sendLink).not.toHaveBeenCalled();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://group/api/group/sendlink');
    const params = JSON.parse(new URLSearchParams((init as { body: URLSearchParams }).body).get('params')!);
    expect(params).toMatchObject({
      msg: 'xem https://a.vn/x',
      href: 'https://a.vn/x',
      title: 'Beeper title',
      desc: 'Beeper desc',
      thumb: 'https://img/t.jpg',
      grid: 'g1',
      imei: 'imei',
    });
  });

  it('trims sentence punctuation off the link it previews', async () => {
    const api = {
      parseLink: vi.fn().mockRejectedValue(new Error('x')),
      sendLink: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ message: {} }),
    };
    await clientWith(api).sendText('t1', 'user', 'xem (https://a.vn/x).');
    expect(api.parseLink).toHaveBeenCalledWith('https://a.vn/x');
  });
});
