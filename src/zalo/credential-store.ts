// Persist zca-js Credentials ({cookie, imei, userAgent}) encrypted at rest.
// A leaked plaintext session = full Zalo account takeover, so we AES-256-GCM the
// file with a key kept in a sibling 0600 key file (auto-generated once).
// Legacy plaintext JSON files are transparently read and re-encrypted on next save.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Credentials } from 'zca-js';

const MAGIC = 'ZBENC1'; // marks an encrypted payload vs legacy plaintext JSON

/** Path of the hidden sibling key file for a credentials file (`<dir>/.<name>.key`). */
function keyPathFor(credsPath: string): string {
  return path.join(path.dirname(credsPath), `.${path.basename(credsPath)}.key`);
}

/**
 * Returns the AES-256 key for a credentials file, generating and persisting a new
 * random key (base64, mode 0600, written atomically via temp file + rename) when
 * none exists yet.
 *
 * @throws on filesystem errors
 */
function loadOrCreateKey(credsPath: string): Buffer {
  const keyPath = keyPathFor(credsPath);
  if (fs.existsSync(keyPath)) return Buffer.from(fs.readFileSync(keyPath, 'utf8'), 'base64');
  const key = crypto.randomBytes(32);
  const tempKeyPath = `${keyPath}.tmp`;
  fs.rmSync(tempKeyPath, { force: true });
  fs.writeFileSync(tempKeyPath, key.toString('base64'), { mode: 0o600 });
  fs.renameSync(tempKeyPath, keyPath);
  return key;
}

/**
 * AES-256-GCM encrypts a string with a fresh random IV.
 *
 * @returns `ZBENC1:<iv>:<authTag>:<ciphertext>`, each part base64
 */
function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${MAGIC}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Reverses `encrypt`.
 *
 * @throws when the payload is malformed, the key is wrong or the data was tampered with
 */
function decrypt(payload: string, key: Buffer): string {
  const [, ivB64, tagB64, dataB64] = payload.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64!, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Reads saved zca-js credentials (encrypted, or legacy plaintext JSON). Never creates
 * a key: an encrypted file whose key file is missing is reported and ignored, so the
 * file stays decryptable if the key is restored (a fresh key is only generated when
 * new credentials are saved after the next login).
 *
 * @returns the credentials, or null when the file is missing, its key is missing, or it
 *   is corrupt or cannot be decrypted (the last three logged as a warning)
 * @throws when the existing credentials file cannot be read
 */
export function loadCredentials(credsPath: string): Credentials | null {
  if (!fs.existsSync(credsPath)) return null;
  const fileContents = fs.readFileSync(credsPath, 'utf8');
  try {
    if (fileContents.startsWith(`${MAGIC}:`)) {
      const keyPath = keyPathFor(credsPath);
      if (!fs.existsSync(keyPath)) {
        console.warn(`Credentials at ${credsPath} are encrypted but their key ${keyPath} is missing — log in again`);
        return null;
      }
      return JSON.parse(decrypt(fileContents, Buffer.from(fs.readFileSync(keyPath, 'utf8'), 'base64'))) as Credentials;
    }
    return JSON.parse(fileContents) as Credentials; // legacy plaintext — re-encrypted on next save
  } catch {
    console.warn(`Corrupt or undecryptable credentials at ${credsPath} — ignoring`);
    return null;
  }
}

/**
 * Encrypts and writes credentials atomically (hidden temp file, mode 0600, then rename),
 * creating the key file on first save.
 *
 * @throws on filesystem errors
 */
export function saveCredentials(credsPath: string, creds: Credentials): void {
  const payload = encrypt(JSON.stringify(creds), loadOrCreateKey(credsPath));
  const tempCredsPath = path.join(path.dirname(credsPath), `.${path.basename(credsPath)}.tmp`);
  fs.rmSync(tempCredsPath, { force: true });
  fs.writeFileSync(tempCredsPath, payload, { mode: 0o600 });
  fs.renameSync(tempCredsPath, credsPath);
}

/** Deletes the credentials file and its key file (logout). Missing files are ignored. */
export function clearCredentials(credsPath: string): void {
  fs.rmSync(credsPath, { force: true });
  fs.rmSync(keyPathFor(credsPath), { force: true });
}
