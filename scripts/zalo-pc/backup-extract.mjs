// Decrypt + unpack a Zalo PC "Xuất dữ liệu" backup (*.zl.zip, format V2).
// Format (Zalo PC main-dist/preload-render.js, class with getCipherKey/getFormattedIv):
//   file = AES-256-CBC( plain tar stream of <userId>/ZaloDownloads/... ), PKCS7, no header
//   key  = SHA-256(UIN)          UIN = session `dkey` (scripts/zalo-pc/get-uin.mjs), not the user id
//   iv   = ascii("zie" + UIN.slice(0, 13))
// Entries: <userId>/ZaloDownloads/database/<userId>_zmessage.zdb  (NDJSON, one Core.Message per line)
//          <userId>/ZaloDownloads/database/<userId>_zconversation.zdb
//          <userId>/ZaloDownloads/resource/<convId>/{picture,video,file,fileNoise}/...  (media)
//
// Usage: node backup-extract.mjs <backup.zl.zip> <uinFile> <outDir> [--peek | --list | --all]
//   default extracts only database/*.zdb; --all also extracts media; --list prints
//   "size<TAB>path" for every entry; --peek only checks the key on the first block.
// The backup file is only read. The UIN is read from a file so it never lands in shell history.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [backupFile, uinFile, outDir, flag] = process.argv.slice(2);
if (!backupFile || !uinFile)
  throw new Error('usage: node backup-extract.mjs <backup.zl.zip> <uinFile> <outDir> [--peek|--list|--all]');
const uin = fs.readFileSync(uinFile, 'utf8').trim();
const iv = Buffer.from('zie' + uin.slice(0, 13));
if (iv.length !== 16) throw new Error('UIN too short for the IV — wrong key file?');
const decipher = crypto.createDecipheriv('aes-256-cbc', crypto.createHash('sha256').update(uin).digest(), iv);

/** A NUL-terminated tar string field, decoded as UTF-8. */
const readCString = (field) => field.toString('utf8').replace(/\0.*$/s, '');
/** A NUL/space-padded octal tar number field (empty = 0). */
const readOctal = (field) => parseInt(field.toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
let buffered = Buffer.alloc(0); // decrypted bytes not yet consumed by the tar parser
let currentEntry = null; // entry being read
let longName = null; // GNU long-name / pax path for the next header
let archiveEnded = false;
let extractedCount = 0;

/**
 * Parses one 512-byte ustar header block. Consumes a pending GNU long-name / pax path
 * (`longName`) as the entry name.
 *
 * @param block - The 512-byte header.
 * @returns `{ name, size, type }` (type is the typeflag char, "0" for regular files), or `null`
 *   for the all-zero end-of-archive block.
 * @throws When the block has no "ustar" magic — in practice: decrypted with the wrong UIN.
 */
function parseHeader(block) {
  if (block.every((byte) => byte === 0)) return null; // end-of-archive block
  if (block.subarray(257, 262).toString('latin1') !== 'ustar') throw new Error('bad tar header — wrong UIN (key)?');
  let name = readCString(block.subarray(0, 100));
  const prefix = readCString(block.subarray(345, 500));
  if (prefix) name = `${prefix}/${name}`;
  if (longName) [name, longName] = [longName, null];
  return { name, size: readOctal(block.subarray(124, 136)), type: String.fromCharCode(block[156] || 48) };
}

/**
 * Streaming tar parser: appends a chunk of decrypted bytes and consumes as many complete
 * headers / entry bodies as are available, keeping the remainder buffered for the next call.
 *
 * Side effects depend on `flag`: `--peek` prints the first entry and exits the process;
 * `--list` prints "size<TAB>name" per regular file; otherwise regular files under `/database/`
 * (or all of them with `--all`) are written below `outDir`, with `:?<>|` in names replaced by "_".
 * GNU long-name ("L") and pax ("x") entries are collected and applied to the next header.
 *
 * @param chunk - Decrypted bytes.
 */
function feed(chunk) {
  buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
  while (!archiveEnded) {
    if (!currentEntry) {
      if (buffered.length < 512) return;
      const header = parseHeader(buffered.subarray(0, 512));
      buffered = buffered.subarray(512);
      if (!header) {
        archiveEnded = true;
        return;
      }
      if (flag === '--peek') {
        console.log(`key OK — first entry: ${header.name}`);
        process.exit(0);
      }
      currentEntry = { ...header, left: header.size, pad: (512 - (header.size % 512)) % 512, meta: [] };
      const isFile = header.type === '0';
      if (isFile && flag === '--list') console.log(`${header.size}\t${header.name}`);
      if (isFile && outDir && flag !== '--list' && (flag === '--all' || header.name.includes('/database/'))) {
        const destination = safeDestination(outDir, header.name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        currentEntry.out = fs.openSync(destination, 'w');
        extractedCount++;
      }
    }
    const bytesToTake = Math.min(currentEntry.left, buffered.length);
    if (bytesToTake > 0) {
      const part = buffered.subarray(0, bytesToTake);
      if (currentEntry.type === 'L' || currentEntry.type === 'x') currentEntry.meta.push(Buffer.from(part));
      else if (currentEntry.out) fs.writeSync(currentEntry.out, part);
      buffered = buffered.subarray(bytesToTake);
      currentEntry.left -= bytesToTake;
    }
    if (currentEntry.left > 0 || buffered.length < currentEntry.pad) return;
    buffered = buffered.subarray(currentEntry.pad);
    if (currentEntry.type === 'L') longName = readCString(Buffer.concat(currentEntry.meta));
    if (currentEntry.type === 'x')
      longName = /\d+ path=([^\n]*)\n/.exec(Buffer.concat(currentEntry.meta).toString('utf8'))?.[1] ?? null;
    if (currentEntry.out) fs.closeSync(currentEntry.out);
    currentEntry = null;
  }
}

/**
 * Where a tar entry may be written: inside `baseDir` only. Entry names come from the
 * (untrusted) backup, so absolute paths, drive letters and `..` segments are refused
 * instead of letting a crafted archive write anywhere on disk (path traversal).
 * Characters Windows forbids in file names are replaced with `_`.
 *
 * @throws Error when the entry name would escape `baseDir`
 */
function safeDestination(baseDir, entryName) {
  const cleaned = entryName.replace(/\\/g, '/').replace(/[:?<>|*"]/g, '_');
  const segments = cleaned.split('/').filter((segment) => segment && segment !== '.');
  if (cleaned.startsWith('/') || segments.includes('..')) throw new Error(`unsafe path in backup: ${entryName}`);
  const root = path.resolve(baseDir);
  const destination = path.resolve(root, ...segments);
  if (destination !== root && !destination.startsWith(root + path.sep)) {
    throw new Error(`unsafe path in backup: ${entryName}`);
  }
  return destination;
}

/** Prints the error and aborts with exit code 1 (wrong key, corrupt archive, unreadable file). */
function fail(err) {
  console.error(err.message);
  process.exit(1);
}

// Read 1 MiB at a time, decrypt, and feed the tar parser; any parse error aborts with exit code 1
const backupStream = fs.createReadStream(backupFile, { highWaterMark: 1 << 20 });
backupStream.on('error', fail);
backupStream.on('data', (encryptedChunk) => {
  try {
    feed(decipher.update(encryptedChunk));
  } catch (err) {
    fail(err);
  }
});
backupStream.on('end', () => {
  try {
    // A wrong key usually only surfaces here, as a bad-padding error on the last block
    feed(decipher.final());
  } catch (err) {
    fail(new Error(`decryption failed — wrong UIN (key) or a truncated backup: ${err.message}`));
  }
  if (flag !== '--list') console.log(`extracted ${extractedCount} file(s) into ${outDir}`);
});
