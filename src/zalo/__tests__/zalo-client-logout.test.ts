import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZaloClient } from '../zalo-client.ts';

/** A client whose zca-js api is a stub (or null = never logged in), recording `loggedOut` events. */
function clientWith(api: Record<string, unknown> | null) {
  const client = new ZaloClient({ credsPath: 'unused-logout-test.json', messagesPerMinute: 600, burst: 10 });
  (client as unknown as { api: unknown }).api = api;
  const loggedOut = vi.fn();
  client.on('loggedOut', loggedOut);
  return { client, loggedOut };
}

describe('ZaloClient.logout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends the session on Zalo, then drops it locally', async () => {
    const api = { logout: vi.fn().mockResolvedValue({ status: true }) };
    const { client, loggedOut } = clientWith(api);
    expect(await client.logout()).toEqual({ serverLoggedOut: true });
    expect(api.logout).toHaveBeenCalledOnce();
    expect(client.isLoggedIn).toBe(false);
    expect(loggedOut).toHaveBeenCalledOnce();
  });

  it('still logs out locally when Zalo rejects the logout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = { logout: vi.fn().mockRejectedValue(new Error('setsid urls not found')) };
    const { client, loggedOut } = clientWith(api);
    expect(await client.logout()).toEqual({ serverLoggedOut: false, error: 'setsid urls not found' });
    expect(client.isLoggedIn).toBe(false);
    expect(loggedOut).toHaveBeenCalledOnce();
  });

  it('gives up on a hanging server logout and logs out locally', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = { logout: vi.fn(() => new Promise(() => {})) };
    const { client, loggedOut } = clientWith(api);
    const pending = client.logout();
    await vi.advanceTimersByTimeAsync(14_000);
    // still held while Zalo answers, so a concurrent `login` is refused
    expect(client.isLoggedIn).toBe(true);
    expect(loggedOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.serverLoggedOut).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(loggedOut).toHaveBeenCalledOnce();
  });

  it('skips the server call when no session is held', async () => {
    const { client, loggedOut } = clientWith(null);
    expect(await client.logout()).toEqual({ serverLoggedOut: false });
    expect(loggedOut).toHaveBeenCalledOnce();
  });
});
