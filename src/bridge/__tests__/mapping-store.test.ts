import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MappingStore } from '../mapping-store.ts';

let tempDir: string;
let dbPath: string;
let store: MappingStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  dbPath = path.join(tempDir, 'test.db');
  store = new MappingStore(dbPath);
});

afterEach(() => {
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('MappingStore', () => {
  it('persists portals across reopen (restart survival)', () => {
    store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!r1:x', name: 'Alice' });
    store.close();
    store = new MappingStore(dbPath);
    expect(store.getPortalByThread('t1')).toMatchObject({ room_id: '!r1:x', thread_type: 'user', name: 'Alice' });
    expect(store.isPortalRoom('!r1:x')).toBe(true);
    expect(store.isPortalRoom('!other:x')).toBe(false);
  });

  it('rejects duplicate portals for the same thread or room', () => {
    store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!r1:x', name: null });
    expect(() => store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!r2:x', name: null })).toThrow();
    expect(() => store.insertPortal({ thread_id: 't2', thread_type: 'group', room_id: '!r1:x', name: null })).toThrow();
  });

  it('dedups messages via recordMessage (INSERT OR IGNORE semantics)', () => {
    expect(store.recordMessage('m1', '!r1:x', '$e1', 'inbound')).toBe(true);
    expect(store.recordMessage('m1', '!r1:x', '$e2', 'inbound')).toBe(false); // replay
    expect(store.hasMessage('m1')).toBe(true);
    expect(store.hasMessage('m2')).toBe(false);
  });

  it('backfills event_id and cli_msg_id across the outbound/echo race (either order)', () => {
    // echo first (cli only), then outbound (event only)
    store.recordMessage('mA', '!r:x', null, 'outbound', null, 'cliA');
    store.recordMessage('mA', '!r:x', '$evA', 'outbound', null, null);
    expect(store.getZaloTargetByEventId('$evA')).toEqual({
      zaloMsgId: 'mA',
      cliMsgId: 'cliA',
      roomId: '!r:x',
      direction: 'outbound',
    });

    // outbound first (event only), then echo (cli only)
    store.recordMessage('mB', '!r:x', '$evB', 'outbound', null, null);
    store.recordMessage('mB', '!r:x', null, 'outbound', null, 'cliB');
    expect(store.getZaloTargetByEventId('$evB')).toEqual({
      zaloMsgId: 'mB',
      cliMsgId: 'cliB',
      roomId: '!r:x',
      direction: 'outbound',
    });
  });

  it('tracks puppet display-name changes for profile sync', () => {
    expect(store.upsertPuppet('u1', '@sh-zalo_u1:x', 'Old Name')).toBe(true); // new with name
    expect(store.upsertPuppet('u1', '@sh-zalo_u1:x', 'Old Name')).toBe(false); // unchanged
    expect(store.upsertPuppet('u1', '@sh-zalo_u1:x', 'New Name')).toBe(true); // renamed
    expect(store.upsertPuppet('u2', '@sh-zalo_u2:x', null)).toBe(false); // new without name
  });
  it('repoints a rebuilt thread to its new room, keeping reply/recall data', () => {
    store.insertPortal({ thread_id: 't1', thread_type: 'group', room_id: '!old:x', name: 'G' });
    store.recordMessage('m1', '!old:x', '$a', 'inbound', '{"q":1}', 'c1', 'u9', 'webchat');
    store.recordMessage('live-only', '!old:x', '$b', 'inbound');
    store.repointPortal({ thread_id: 't1', thread_type: 'group', room_id: '!new:x', name: null }, [
      { msgId: 'm1', eventId: '$a2', direction: 'inbound', cliMsgId: 'c1', msgType: '1' },
      { msgId: 'm0', eventId: '$z', direction: 'outbound', cliMsgId: null, msgType: '1' },
    ]);
    expect(store.getPortalByThread('t1')).toMatchObject({ room_id: '!new:x', name: 'G' });
    expect(store.getEventByZaloMsgId('m1')).toEqual({ eventId: '$a2', roomId: '!new:x' });
    expect(store.getQuoteJsonByEventId('$a2')).toBe('{"q":1}');
    expect(store.getSeenTargetByEventId('$a2')).toMatchObject({ senderId: 'u9', msgType: 'webchat' });
    expect(store.getEventByZaloMsgId('m0')).toEqual({ eventId: '$z', roomId: '!new:x' });
    expect([...store.getRoomMessageIds('!old:x')]).toEqual(['live-only']);
  });
  it('drops mappings of a removed room but never of a live portal', () => {
    store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!live:x', name: null });
    store.recordMessage('a', '!old:x', '$a', 'inbound');
    store.recordMessage('b', '!live:x', '$b', 'inbound');
    expect(store.deleteRoomMessages('!old:x')).toBe(1);
    expect(store.hasMessage('a')).toBe(false);
    expect(() => store.deleteRoomMessages('!live:x')).toThrow();
    expect(store.hasMessage('b')).toBe(true);
  });
});

describe('MappingStore accounts (multi-account groundwork, schema v7)', () => {
  it('upgrades a v6 database without touching existing rows, then files them under the first account', async () => {
    store.close();
    fs.rmSync(dbPath);
    // A schema-v6 database as the live bridge has it today
    const { default: Database } = await import('better-sqlite3');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE portal (thread_id TEXT PRIMARY KEY, thread_type TEXT NOT NULL, room_id TEXT NOT NULL UNIQUE, name TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE puppet (zalo_uid TEXT PRIMARY KEY, mxid TEXT NOT NULL UNIQUE, display_name TEXT, updated_at INTEGER NOT NULL, avatar_url TEXT, profile_checked_at INTEGER);
      CREATE TABLE message (zalo_msg_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, event_id TEXT UNIQUE, direction TEXT NOT NULL, ts INTEGER NOT NULL, quote_json TEXT, cli_msg_id TEXT, sender_id TEXT, msg_type TEXT);
      INSERT INTO portal VALUES ('t1', 'user', '!r1:x', 'Alice', 1);
      INSERT INTO message VALUES ('m1', '!r1:x', '$e1', 'inbound', 1, NULL, 'c1', 't1', 'webchat');
      PRAGMA user_version = 6;
    `);
    legacy.close();

    store = new MappingStore(dbPath);
    expect(store.getPortalByThread('t1')).toEqual({
      thread_id: 't1',
      thread_type: 'user',
      room_id: '!r1:x',
      name: 'Alice',
      account_id: null,
    });
    expect(store.getEventIdByMsgId('m1')).toBe('$e1'); // lookups unchanged
    expect(store.listAccounts()).toEqual([]);
    expect(store.currentAccountId).toBeNull();

    expect(store.bindAccount('111', 'zalo-creds.session.json')).toEqual({ portals: 1, messages: 1 });
    expect(store.getPortalByThread('t1')?.account_id).toBe('111');
    // a reconnect re-binds without reassigning anything
    expect(store.bindAccount('111', 'zalo-creds.session.json')).toEqual({ portals: 0, messages: 0 });
    expect(store.listAccounts()).toMatchObject([{ zalo_uid: '111', creds_path: 'zalo-creds.session.json' }]);
  });

  it('stamps new portals and messages with the bound account', () => {
    store.insertPortal({ thread_id: 'before', thread_type: 'user', room_id: '!b:x', name: null });
    store.bindAccount('222', 'creds-222.json');
    store.insertPortal({ thread_id: 't2', thread_type: 'group', room_id: '!r2:x', name: 'G' });
    store.recordMessage('m2', '!r2:x', '$e2', 'inbound');
    store.markOutboundHandled('$e3', '!r2:x');
    expect(store.getPortalByThread('t2')?.account_id).toBe('222');
    expect(store.getPortalByThread('before')?.account_id).toBe('222'); // backfilled on bind
    expect(store.getAllPortals().every((portal) => portal.account_id === '222')).toBe(true);
    // a second account keeps the first one's rows
    store.bindAccount('333', 'creds-333.json');
    store.insertPortal({ thread_id: 't3', thread_type: 'user', room_id: '!r3:x', name: null });
    expect(store.getPortalByThread('t2')?.account_id).toBe('222');
    expect(store.getPortalByThread('t3')?.account_id).toBe('333');
    expect(store.listAccounts().map((account) => account.zalo_uid)).toEqual(['222', '333']);
  });

  it('lets the history importer stamp rows for a known account without recording a login', () => {
    store.insertPortal({ thread_id: 'old', thread_type: 'user', room_id: '!o:x', name: null });
    store.useAccount('444');
    store.insertPortal({ thread_id: 'imported', thread_type: 'user', room_id: '!i:x', name: null });
    expect(store.getPortalByThread('imported')?.account_id).toBe('444');
    expect(store.getPortalByThread('old')?.account_id).toBeNull(); // left for the bridge's bindAccount
    expect(store.listAccounts()).toEqual([]);
  });

  it('opens an already-migrated database without migrating again', () => {
    store.close();
    store = new MappingStore(dbPath); // second open: v7 already, no duplicate-column error
    expect(store.listAccounts()).toEqual([]);
  });
});
