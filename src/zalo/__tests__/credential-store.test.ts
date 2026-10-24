import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials, saveCredentials } from '../credential-store.ts';

let tempDir: string;
let credsPath: string;
const keyPath = () => path.join(tempDir, '.creds.json.key');
const creds = { imei: 'imei-1', cookie: [], userAgent: 'ua' } as unknown as Parameters<typeof saveCredentials>[1];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-test-'));
  credsPath = path.join(tempDir, 'creds.json');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('credential store', () => {
  it('round-trips encrypted credentials', () => {
    saveCredentials(credsPath, creds);
    expect(fs.readFileSync(credsPath, 'utf8')).toMatch(/^ZBENC1:/);
    expect(loadCredentials(credsPath)).toEqual(creds);
  });

  it('does not replace a missing key with a new one (the file stays recoverable)', () => {
    saveCredentials(credsPath, creds);
    const key = fs.readFileSync(keyPath(), 'utf8');
    fs.renameSync(keyPath(), `${keyPath()}.bak`);
    expect(loadCredentials(credsPath)).toBeNull();
    expect(fs.existsSync(keyPath())).toBe(false); // no fresh random key written
    fs.renameSync(`${keyPath()}.bak`, keyPath()); // key restored → credentials readable again
    expect(fs.readFileSync(keyPath(), 'utf8')).toBe(key);
    expect(loadCredentials(credsPath)).toEqual(creds);
  });
});
