// Portal provisioning against a REAL SQLite store and a mocked Bridge/Intent —
// exercises the race protection and restart idempotency the plan calls out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bridge } from 'matrix-appservice-bridge';
import { MappingStore } from '../mapping-store.ts';
import { PortalManager } from '../portal-manager.ts';
import { PuppetRegistry } from '../puppet-registry.ts';
import type { ZaloProfile } from '../../zalo/types.ts';

const OWNER = '@owner:beeper.com';

/**
 * Minimal Bridge stub: every getIntent() returns one shared Intent mock whose
 * createRoom hands out sequential room ids, so tests can count room creations.
 */
function mockBridge() {
  let roomCounter = 0;
  const createRoom = vi.fn(async (_opts: unknown) => ({ room_id: `!room${++roomCounter}:beeper.local` }));
  const intent = {
    createRoom,
    ensureRegistered: vi.fn(async () => undefined),
    setDisplayName: vi.fn(async () => undefined),
    setAvatarUrl: vi.fn(async () => undefined),
    join: vi.fn(async () => undefined),
    matrixClient: { leaveRoom: vi.fn(async () => undefined) },
    invite: vi.fn(async () => undefined),
    uploadContent: vi.fn(async () => 'mxc://logo'),
    sendStateEvent: vi.fn(async () => ({ event_id: '$s' })),
    userId: '@sh-zalobot:beeper.local',
    opts: { registered: false },
  };
  const bridge = {
    getIntent: vi.fn(() => intent),
    getBot: vi.fn(() => ({ getUserId: () => '@sh-zalobot:beeper.local' })),
  } as unknown as Bridge;
  return { bridge, intent, createRoom };
}

let tempDir: string;
let store: MappingStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
  store = new MappingStore(path.join(tempDir, 'test.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('PortalManager', () => {
  it('creates a DM portal once and reuses it afterwards', async () => {
    const { bridge, createRoom } = mockBridge();
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, 'beeper.local'), OWNER, {
      name: 'Zalo',
      logoPath: 'assets/zalo-logo.png',
      networkId: 'zalo',
      stateKey: 'beeper.local/sh-zalo',
    });

    const first = await portals.getOrCreatePortal({
      threadId: 't1',
      threadType: 'user',
      senderId: 'u1',
      senderName: 'Alice',
    });
    const second = await portals.getOrCreatePortal({ threadId: 't1', threadType: 'user', senderId: 'u1' });
    expect(first.room_id).toBe(second.room_id);
    expect(createRoom).toHaveBeenCalledTimes(1);
    expect(createRoom.mock.calls[0]?.[0]).toMatchObject({
      createAsClient: true,
      options: { is_direct: true, invite: [OWNER], name: 'Alice' },
    });
  });

  it('serializes CONCURRENT creation for the same thread (no duplicate rooms)', async () => {
    const { bridge, createRoom } = mockBridge();
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, 'beeper.local'), OWNER, {
      name: 'Zalo',
      logoPath: 'assets/zalo-logo.png',
      networkId: 'zalo',
      stateKey: 'beeper.local/sh-zalo',
    });

    const [first, second, third] = await Promise.all([
      portals.getOrCreatePortal({ threadId: 't1', threadType: 'user', senderId: 'u1' }),
      portals.getOrCreatePortal({ threadId: 't1', threadType: 'user', senderId: 'u1' }),
      portals.getOrCreatePortal({ threadId: 't1', threadType: 'user', senderId: 'u1' }),
    ]);
    expect(createRoom).toHaveBeenCalledTimes(1);
    expect(new Set([first.room_id, second.room_id, third.room_id]).size).toBe(1);
  });

  it('uses resolved group name, falling back to a placeholder', async () => {
    const { bridge, createRoom } = mockBridge();
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, 'beeper.local'), OWNER, {
      name: 'Zalo',
      logoPath: 'assets/zalo-logo.png',
      networkId: 'zalo',
      stateKey: 'beeper.local/sh-zalo',
    });

    const named = await portals.getOrCreatePortal({
      threadId: 'g1',
      threadType: 'group',
      senderId: 'u1',
      resolveGroupName: async () => 'Gia đình',
    });
    expect(named.name).toBe('Gia đình');

    const fallback = await portals.getOrCreatePortal({
      threadId: 'g2222222',
      threadType: 'group',
      senderId: 'u1',
      resolveGroupName: async () => null,
    });
    expect(fallback.name).toBe('Zalo group 222222');
    expect(createRoom).toHaveBeenCalledTimes(2);
  });

  it('skips creation entirely when the portal is already persisted (restart)', async () => {
    store.insertPortal({ thread_id: 't9', thread_type: 'user', room_id: '!existing:x', name: 'Bob' });
    const { bridge, createRoom } = mockBridge();
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, 'beeper.local'), OWNER, {
      name: 'Zalo',
      logoPath: 'assets/zalo-logo.png',
      networkId: 'zalo',
      stateKey: 'beeper.local/sh-zalo',
    });

    const portal = await portals.getOrCreatePortal({ threadId: 't9', threadType: 'user', senderId: 'u9' });
    expect(portal.room_id).toBe('!existing:x');
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('invites the ghost via bot when direct join fails (group first-speak)', async () => {
    const { bridge, intent } = mockBridge();
    intent.join.mockRejectedValueOnce(new Error('not invited'));
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, 'beeper.local'), OWNER, {
      name: 'Zalo',
      logoPath: 'assets/zalo-logo.png',
      networkId: 'zalo',
      stateKey: 'beeper.local/sh-zalo',
    });

    await portals.ensureGhostInRoom('u5', '!g:x');
    expect(intent.invite).toHaveBeenCalledWith('!g:x', '@sh-zalo_u5:beeper.local');
    expect(intent.join).toHaveBeenCalledTimes(2);
  });

  it('joins the owner as a pre-registered intent (ensureRegistered would hit M_EXCLUSIVE)', async () => {
    const { bridge, intent } = mockBridge();
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, 'beeper.local'), OWNER, {
      name: 'Zalo',
      logoPath: 'assets/zalo-logo.png',
      networkId: 'zalo',
      stateKey: 'beeper.local/sh-zalo',
    });
    const portal = await portals.getOrCreatePortal({ threadId: 'g9', threadType: 'group', senderId: '' });
    expect(bridge.getIntent).toHaveBeenCalledWith(OWNER);
    expect(intent.opts.registered).toBe(true);
    expect(intent.join).toHaveBeenCalledWith(portal.room_id);
  });

  it('retries a failed owner join and repairs existing portals at startup', async () => {
    const { bridge, intent } = mockBridge();
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, 'beeper.local'), OWNER, {
      name: 'Zalo',
      logoPath: 'assets/zalo-logo.png',
      networkId: 'zalo',
      stateKey: 'beeper.local/sh-zalo',
    });
    intent.join.mockRejectedValueOnce(new Error('M_EXCLUSIVE'));
    const portal = await portals.getOrCreatePortal({ threadId: 'g8', threadType: 'group', senderId: '' });
    intent.join.mockClear();
    await portals.joinOwnerToExistingPortals();
    expect(intent.join).toHaveBeenCalledWith(portal.room_id);
    intent.join.mockClear();
    await portals.joinOwnerToExistingPortals(); // already joined this run → no extra request
    expect(intent.join).not.toHaveBeenCalled();
  });

  it('removes portals built from prefixed pinned ids and their bogus puppets', async () => {
    const { bridge, intent } = mockBridge();
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, 'beeper.local'), OWNER, {
      name: 'Zalo',
      logoPath: 'assets/zalo-logo.png',
      networkId: 'zalo',
      stateKey: 'beeper.local/sh-zalo',
    });
    store.insertPortal({ thread_id: 'u123', thread_type: 'user', room_id: '!bad:beeper.local', name: null });
    store.insertPortal({ thread_id: '456', thread_type: 'group', room_id: '!good:beeper.local', name: 'G' });
    store.upsertPuppet('u123', '@sh-zalo_u123:beeper.local', null);
    store.upsertPuppet('123', '@sh-zalo_123:beeper.local', null);
    expect(await portals.removeMalformedPortals()).toBe(1);
    expect(intent.matrixClient.leaveRoom).toHaveBeenCalledWith('!bad:beeper.local');
    expect(store.getAllPortals().map((portal) => portal.thread_id)).toEqual(['456']);
    expect(store.getPuppetDisplayName('u123')).toBeNull();
  });

  it("names an unnamed DM ghost from the Zalo profile (DM opened by the owner's own message)", async () => {
    const { bridge, intent } = mockBridge();
    const resolveProfile = vi.fn(async () => ({ displayName: 'Bob' }));
    const puppets = new PuppetRegistry(bridge, store, 'beeper.local', resolveProfile);
    const portals = new PortalManager(bridge, store, puppets, OWNER, {
      name: 'Zalo',
      logoPath: 'assets/zalo-logo.png',
      networkId: 'zalo',
      stateKey: 'beeper.local/sh-zalo',
    });
    store.insertPortal({ thread_id: '777', thread_type: 'user', room_id: '!dm:beeper.local', name: null });
    store.upsertPuppet('777', '@sh-zalo_777:beeper.local', null);
    await portals.repairDmGhostNames();
    expect(resolveProfile).toHaveBeenCalledWith('777');
    expect(store.getPuppetDisplayName('777')).toBe('Bob');
    expect(intent.setDisplayName).toHaveBeenCalledWith('Bob');
    resolveProfile.mockClear();
    await portals.repairDmGhostNames(); // named now → no further lookups
    expect(resolveProfile).not.toHaveBeenCalled();
  });

  it('repairs missing names and avatars in batches, DM contacts first, and remembers empty profiles', async () => {
    const { bridge, intent } = mockBridge();
    const puppets = new PuppetRegistry(bridge, store, 'beeper.local');
    store.insertPortal({ thread_id: '900', thread_type: 'user', room_id: '!dm:beeper.local', name: null });
    store.upsertPuppet('100', '@sh-zalo_100:beeper.local', null); // group member, unnamed
    store.upsertPuppet('900', '@sh-zalo_900:beeper.local', 'Bob'); // DM peer without avatar
    store.upsertPuppet('555', '@sh-zalo_555:beeper.local', null); // deleted account
    expect(store.getPuppetsMissingProfile(60_000)[0]).toBe('900'); // DM peer first
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } }),
      );
    const fetchProfiles = vi.fn(async (uids: string[]) => {
      const profiles = new Map<string, ZaloProfile>();
      if (uids.includes('100')) profiles.set('100', { displayName: 'Carol' }); // no avatar
      if (uids.includes('900'))
        profiles.set('900', { displayName: 'Bobby', avatarUrl: 'https://s120-ava-talk.zadn.vn/b.jpg' });
      return profiles;
    });
    const result = await puppets.repairMissingProfiles(fetchProfiles, { batchSize: 2, pauseMs: 0 });
    fetchMock.mockRestore();
    expect(fetchProfiles).toHaveBeenCalledTimes(2); // 3 contacts in batches of 2
    expect(result).toEqual({ named: 1, withAvatar: 1, checked: 2, complete: true });
    expect(store.getPuppetDisplayName('100')).toBe('Carol');
    expect(store.getPuppetDisplayName('900')).toBe('Bob'); // an existing name is kept
    expect(store.getPuppetAvatarUrl('900')).toBe('https://s120-ava-talk.zadn.vn/b.jpg');
    expect(intent.setAvatarUrl).toHaveBeenCalledTimes(1);
    // everyone was checked, so nothing is pending until the recheck window passes
    expect(store.getPuppetsMissingProfile(60_000)).toEqual([]);
  });
});
