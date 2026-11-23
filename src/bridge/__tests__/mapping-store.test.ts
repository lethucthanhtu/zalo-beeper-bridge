import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
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
  it('finds a bridged message by client msgId + sender (reply fallback)', () => {
    store.recordMessage('g1', '!r:x', '$a', 'inbound', null, '111', 'alice');
    store.recordMessage('g2', '!r:x', '$b', 'inbound', null, '111', 'bob');
    store.recordMessage('g3', '!r:x', '$own', 'outbound', null, '222');
    expect(store.getEventIdByCliMsgId('!r:x', '111', 'bob')).toBe('$b');
    expect(store.getEventIdByCliMsgId('!r:x', '222', 'me')).toBe('$own'); // outbound rows have no sender
    expect(store.getEventIdByCliMsgId('!other:x', '111', 'alice')).toBeNull();
  });

  it('tracks reactions per target and sender, and drops them with the room', () => {
    store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!r:x', name: null });
    const row = { room_id: '!r:x', target_msg_id: 'm1', sender_id: 'me', zalo_icon: '/-heart' };
    store.recordReaction({ event_id: '$1', ...row });
    store.recordReaction({ event_id: '$2', ...row, zalo_icon: '/-strong' });
    store.recordReaction({ event_id: '$1', ...row, zalo_icon: 'ignored' });
    expect(store.getReactions('m1', 'me').map((r) => r.zalo_icon)).toEqual(['/-heart', '/-strong']);
    store.deleteReaction('$1');
    expect(store.getReactionByEventId('$1')).toBeNull();
    store.deletePortal('t1');
    expect(store.getReactionByEventId('$2')).toBeNull();
  });

  it('maps a poll to its start event, options and last known votes, and drops it with the room', () => {
    store.insertPortal({ thread_id: 'g1', thread_type: 'group', room_id: '!g:x', name: null });
    const options = [
      { optionId: 11, answerId: 'o11', content: 'Pho' },
      { optionId: 12, answerId: 'o12', content: 'Bun' },
    ];
    store.recordPoll({ pollId: 4242, roomId: '!g:x', eventId: '$poll', creatorId: 'u2', options, multi: true });
    store.recordPoll({ pollId: 4242, roomId: '!g:x', eventId: '$ignored', creatorId: 'u9', options: [], multi: false });
    expect(store.getPollById(4242)).toEqual({
      pollId: 4242,
      roomId: '!g:x',
      eventId: '$poll',
      creatorId: 'u2',
      options,
      multi: true,
      closed: false,
      votes: {},
    });
    expect(store.getPollByEventId('$poll')?.pollId).toBe(4242);
    expect(store.getPollByEventId('$nope')).toBeNull();

    store.setPollVotes(4242, { u3: [11], me: [] });
    expect(store.getPollById(4242)?.votes).toEqual({ u3: [11], me: [] });
    store.closePoll(4242);
    expect(store.getPollById(4242)?.closed).toBe(true);

    store.deletePortal('g1');
    expect(store.getPollById(4242)).toBeNull();
  });

  it('drops the polls of an abandoned room', () => {
    store.recordPoll({ pollId: 1, roomId: '!old:x', eventId: '$p', creatorId: null, options: [], multi: false });
    store.deleteRoomMessages('!old:x');
    expect(store.getPollById(1)).toBeNull();
  });

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
    // a message missing from the rebuild stays mapped to the old room
    expect(store.getEventByZaloMsgId('live-only')).toEqual({ eventId: '$b', roomId: '!old:x' });
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

describe('MappingStore media failure ledger (schema v10)', () => {
  it('lists rooms with failure notices until a rebuild repoints the message', () => {
    store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!r:x', name: 'A' });
    store.recordMessage('p1', '!r:x', '$n1', 'inbound');
    store.recordMessage('p2', '!r:x', '$n2', 'inbound');
    store.recordMediaFailure('p1', '!r:x', '$n1', 'photo', 'f1.zdn.vn: HTTP 400');
    store.recordMediaFailure('p2', '!r:x', '$n2', 'file', 'f1.zdn.vn: HTTP 400');
    expect(store.listOpenMediaFailures()).toEqual([
      { roomId: '!r:x', count: 2, lastTs: expect.any(Number), kinds: expect.arrayContaining(['photo', 'file']) },
    ]);

    // the importer rebuild re-renders p1 as a real image in a new room
    store.repointPortal({ thread_id: 't1', thread_type: 'user', room_id: '!new:x', name: null }, [
      { msgId: 'p1', eventId: '$img', direction: 'inbound', cliMsgId: null, msgType: 'chat.photo' },
    ]);
    expect(store.listOpenMediaFailures()).toEqual([
      { roomId: '!r:x', count: 1, lastTs: expect.any(Number), kinds: ['file'] },
    ]);
  });

  it('forgets the failures of a deleted room', () => {
    store.recordMessage('p1', '!old:x', '$n1', 'inbound');
    store.recordMediaFailure('p1', '!old:x', '$n1', 'photo', 'x');
    store.deleteRoomMessages('!old:x');
    store.recordMessage('p1', '!old:x', '$n1', 'inbound'); // even if the mapping came back
    expect(store.listOpenMediaFailures()).toEqual([]);
  });

  it('looks up, lists and resolves an open failure for the repair queue', () => {
    store.insertPortal({ thread_id: 'g1', thread_type: 'group', room_id: '!g:x', name: 'G' });
    store.recordMessage('p1', '!g:x', '$n1', 'inbound');
    store.recordMediaFailure('p1', '!g:x', '$n1', 'video', 'x');
    expect(store.getOpenMediaFailure('p1')).toEqual({ roomId: '!g:x', eventId: '$n1', kind: 'video' });
    expect(store.listOpenMediaFailuresSince(0)).toEqual([
      { zaloMsgId: 'p1', threadId: 'g1', threadType: 'group', ts: expect.any(Number) },
    ]);
    expect(store.listOpenMediaFailuresSince(Date.now() + 60_000)).toEqual([]);

    store.resolveMediaFailure('p1', '$video');
    expect(store.getEventIdByMsgId('p1')).toBe('$video');
    expect(store.getOpenMediaFailure('p1')).toBeNull();
    expect(store.listOpenMediaFailuresSince(0)).toEqual([]);
  });

  it('treats a failure whose message a rebuild repointed as closed', () => {
    store.insertPortal({ thread_id: 't1', thread_type: 'user', room_id: '!r:x', name: 'A' });
    store.recordMessage('p1', '!r:x', '$n1', 'inbound');
    store.recordMediaFailure('p1', '!r:x', '$n1', 'photo', 'x');
    store.repointPortal({ thread_id: 't1', thread_type: 'user', room_id: '!new:x', name: null }, [
      { msgId: 'p1', eventId: '$img', direction: 'inbound', cliMsgId: null, msgType: 'chat.photo' },
    ]);
    expect(store.getOpenMediaFailure('p1')).toBeNull();
    expect(store.listOpenMediaFailuresSince(0)).toEqual([]);
  });
});

describe('MappingStore sticker uploads (zalo_file, schema v11)', () => {
  const plain = { uploaded: { url: 'mxc://hs/plain' }, mimetype: 'image/png', size: 10, w: 120, h: 120 };
  const encrypted = {
    uploaded: { file: { url: 'mxc://hs/enc', v: 'v2' } } as never,
    mimetype: 'image/webp',
    size: 20,
  };

  it('keeps one upload per sticker and mode, across reopen', () => {
    store.putStickerMedia(42, false, plain);
    store.putStickerMedia('42', true, encrypted);
    expect(store.getStickerMedia(42, false)).toEqual(plain);
    expect(store.getStickerMedia(42, true)).toStrictEqual(encrypted);
    expect(store.getStickerMedia(43, false)).toBeNull();

    store.close();
    store = new MappingStore(dbPath);
    expect(store.getStickerMedia('42', false)).toEqual(plain);
  });

  it('replaces an upload and forgets a sticker', () => {
    store.putStickerMedia(42, false, plain);
    store.putStickerMedia(42, false, { ...plain, size: 11 });
    expect(store.getStickerMedia(42, false)?.size).toBe(11);
    store.putStickerMedia(42, true, encrypted);
    store.deleteStickerMedia(42);
    expect(store.getStickerMedia(42, false)).toBeNull();
    expect(store.getStickerMedia(42, true)).toBeNull();
  });

  it('stores rows like mautrix-telegram telegram_file: one id per mode, key only in decryption_info', () => {
    store.putStickerMedia(42, false, plain);
    store.putStickerMedia(42, true, encrypted);
    store.close();
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT id, mxc, decryption_info FROM zalo_file ORDER BY id').all();
    db.close();
    store = new MappingStore(dbPath);
    expect(rows).toEqual([
      { id: 'sticker-42', mxc: 'mxc://hs/plain', decryption_info: null },
      { id: 'sticker-42-encrypted', mxc: 'mxc://hs/enc', decryption_info: expect.stringContaining('"v":"v2"') },
    ]);
  });

  it('ignores an upload whose form does not match the mode', () => {
    store.putStickerMedia(42, true, plain);
    store.putStickerMedia(42, false, encrypted);
    expect(store.getStickerMedia(42, true)).toBeNull();
    expect(store.getStickerMedia(42, false)).toBeNull();
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
    expect(store.getPollById(1)).toBeNull(); // the poll table was added by the upgrade

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

  it('finds the newest bridged msgId per thread type (the catch-up cursor)', () => {
    expect(store.newestMsgId('user')).toBeNull(); // fresh install
    store.insertPortal({ thread_id: 'u1', thread_type: 'user', room_id: '!dm:x', name: null });
    store.insertPortal({ thread_id: 'g1', thread_type: 'group', room_id: '!grp:x', name: 'G' });
    store.recordMessage('999', '!dm:x', '$a', 'inbound');
    store.recordMessage('1000', '!dm:x', '$b', 'outbound'); // numerically newer, although "999" > "1000" as text
    store.recordMessage('1001_0001', '!dm:x', '$c', 'inbound'); // importer shadow id, not a msgId
    store.recordMessage('evt:$d', '!dm:x', '$d', 'outbound'); // synthetic outbound guard
    store.recordMessage('5000', '!grp:x', '$e', 'inbound');
    expect(store.newestMsgId('user')).toBe('1000');
    expect(store.newestMsgId('group')).toBe('5000');
  });
});
