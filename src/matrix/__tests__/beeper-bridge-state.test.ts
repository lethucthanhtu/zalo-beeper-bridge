import { afterEach, describe, expect, it, vi } from 'vitest';
import { createZaloStatePublisher } from '../beeper-bridge-state.ts';

afterEach(() => vi.unstubAllGlobals());

describe('createZaloStatePublisher', () => {
  it('still files the state under the last account after the session is gone (dead / logout)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    let ownId: string | null = '42';
    const publish = createZaloStatePublisher({
      homeserverUrl: 'https://matrix.beeper.com/_hungryserv/alice',
      bridgeId: 'sh-zalo',
      asToken: 'token',
      fallbackName: 'Zalo',
      getOwnId: () => ownId,
      getOwnProfile: async () => null,
      uploadAvatar: async () => undefined,
    });

    await publish('CONNECTED');
    ownId = null; // the listener died: zalo-client drops the session before emitting
    await publish('BAD_CREDENTIALS');

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(bodies.map((body) => [body.state_event, body.remote_id])).toEqual([
      ['CONNECTED', '42'],
      ['BAD_CREDENTIALS', '42'],
    ]);
  });
});
