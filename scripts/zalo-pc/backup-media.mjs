// Backup media → files the history importer can upload (its --media-dir).
// Maps every media file of an extracted Zalo PC backup (backup-extract.mjs --all) to its
// message, decodes Zalo's "fileNoise" obfuscation, re-encodes JPEG XL photos as JPEG
// (no Matrix client renders JXL) and writes <outDir>/<msgId>.<ext> plus
// <outDir>/media-index.json = { msgId: { file, mimetype, size, w?, h?, name? } }.
//
// Usage: node scripts/zalo-pc/backup-media.mjs <ZaloDownloads dir> <ownerUid> <outDir>
//   <ZaloDownloads dir> = <extractDir>/<ownerUid>/ZaloDownloads (holds database/ and resource/)
// Needs the dev dependencies @jsquash/jxl + @jsquash/jpeg (npm install, not --omit=dev).
//
// File naming in the backup (verified against all 1,487 files of a real backup):
//   resource/<convId>/<picture|video|file|fileNoise>/<cliMsgId>_<senderUid>_<convId>[_<md5 of a photo URL>][.ext]
//     senderUid is the owner's real uid for own messages (fromUid "0" in the rows)
//   file/[group/]<md5>, fileNoise/[group/]<md5>  — older flat copies, md5 = params.checksum
//   fileNoise: first 100 bytes XOR 0x93 + a 6-byte "\x07zAlO\x07" trailer
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import decodeJxl, { init as initJxl } from '@jsquash/jxl/decode.js';
import encodeJpeg, { init as initJpeg } from '@jsquash/jpeg/encode.js';

const [downloadsDir, ownerUid, outDir] = process.argv.slice(2);
if (!outDir) throw new Error('usage: node backup-media.mjs <ZaloDownloads dir> <ownerUid> <outDir>');
const require = createRequire(import.meta.url);
/** Compiles a codec .wasm shipped inside node_modules (the jsquash codecs need it passed to init()). */
const compileWasm = (moduleSpecifier) => WebAssembly.compile(fs.readFileSync(require.resolve(moduleSpecifier)));
await initJxl(await compileWasm('@jsquash/jxl/codec/dec/jxl_dec.wasm'));
await initJpeg(await compileWasm('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'));

const MEDIA_TYPES = new Set([2, 3, 7, 18, 19]); // photo, voice, GIF, video, file
const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  amr: 'audio/amr',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic']);

/**
 * Real format from the first bytes; null when unknown.
 *
 * @param bytes - File contents.
 * @returns A file extension (jpg/png/gif/webp/jxl/mov/mp4/pdf/zip) or `null`.
 */
function sniff(bytes) {
  const hex = bytes.subarray(0, 8).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'jpg';
  if (hex.startsWith('89504e47')) return 'png';
  if (hex.startsWith('47494638')) return 'gif';
  if (hex.startsWith('52494646') && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (hex.startsWith('ff0a') || hex.startsWith('0000000c4a584c20')) return 'jxl';
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp')
    return bytes.subarray(8, 10).toString('latin1') === 'qt' ? 'mov' : 'mp4';
  if (hex.startsWith('25504446')) return 'pdf';
  if (hex.startsWith('504b0304')) return 'zip';
  return null;
}

/**
 * Undoes Zalo's "fileNoise" obfuscation: drops the 6-byte trailer and XORs the first
 * 100 bytes with 0x93.
 *
 * @param noisyBytes - Contents of a fileNoise file (not modified).
 * @returns A new buffer with the original file contents.
 */
function denoise(noisyBytes) {
  const out = Buffer.from(noisyBytes.subarray(0, noisyBytes.length - 6));
  for (let i = 0; i < Math.min(100, out.length); i++) out[i] ^= 0x93;
  return out;
}

/** The message's `message.params` (a JSON string or object) as an object; `{}` when absent or unparsable. */
const params = (message) => {
  try {
    const rawParams = message.message?.params;
    return rawParams ? (typeof rawParams === 'string' ? JSON.parse(rawParams) : rawParams) : {};
  } catch {
    return {};
  }
};
/** Conversation id of a row: the group id ("g…") for groups, else the DM peer uid (fromUid "0" = sent by the owner). */
const convOf = (message) =>
  String(message.toUid).startsWith('g') ? message.toUid : message.fromUid === '0' ? message.toUid : message.fromUid;
/** Sender uid of a row, with the owner's "0" replaced by the real owner uid (as used in backup file names). */
const senderOf = (message) => (message.fromUid === '0' ? ownerUid : message.fromUid);

// Media messages, indexed the two ways backup file names refer to them
const messageDbPath = path.join(downloadsDir, 'database', `${ownerUid}_zmessage.zdb`);
const mediaByCliMsgId = new Map();
const mediaByChecksum = new Map();
for (const line of fs.readFileSync(messageDbPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (!MEDIA_TYPES.has(message.msgType)) continue;
  (
    mediaByCliMsgId.get(String(message.cliMsgId)) ??
    mediaByCliMsgId.set(String(message.cliMsgId), []).get(String(message.cliMsgId))
  ).push(message);
  const checksum = params(message).checksum;
  if (checksum) (mediaByChecksum.get(checksum) ?? mediaByChecksum.set(checksum, []).get(checksum)).push(message);
}

/**
 * Recursively yields every file path below `dir` (depth-first, synchronous reads).
 *
 * @param dir - Directory to walk.
 */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(entryPath);
    else yield entryPath;
  }
}

// msgId → best file: plain beats fileNoise first, then resource/ beats flat copies (score 3 > 2 > 1 > 0);
// on a tie the first file walked wins
const best = new Map();
let fileCount = 0;
let unmatchedCount = 0;
for (const filePath of walk(downloadsDir)) {
  const relParts = path.relative(downloadsDir, filePath).split(path.sep);
  const name = relParts.at(-1);
  if (relParts[0] === 'database' || name === '.rescache') continue;
  fileCount++;
  const noise = relParts.includes('fileNoise');
  let candidates = [];
  const resourceName = /^(\d+)_(\d+)_(g?\d+)(?:_[0-9a-f]{32})?(?:\.[a-z0-9]+)?$/i.exec(name);
  if (relParts[0] === 'resource' && resourceName) {
    const [, cliMsgId, senderUid, convId] = resourceName;
    const sameConversation = (mediaByCliMsgId.get(cliMsgId) ?? []).filter((message) => convOf(message) === convId);
    candidates = sameConversation.filter((message) => senderOf(message) === senderUid);
    if (!candidates.length) candidates = sameConversation;
  } else if (/^[0-9a-f]{32}$/.test(name)) candidates = mediaByChecksum.get(name) ?? [];
  if (!candidates.length) {
    unmatchedCount++;
    continue;
  }
  const score = (noise ? 0 : 2) + (relParts[0] === 'resource' ? 1 : 0);
  for (const message of candidates) {
    const previous = best.get(String(message.msgId));
    if (!previous || score > previous.score)
      best.set(String(message.msgId), { path: filePath, noise, score, msg: message });
  }
}

// Write each message's best file as <msgId>.<ext> and build media-index.json; per-file errors are logged and skipped
fs.mkdirSync(outDir, { recursive: true });
const index = {};
let skippedCount = 0;
for (const [msgId, chosen] of best) {
  try {
    let bytes = fs.readFileSync(chosen.path);
    if (chosen.noise) bytes = denoise(bytes);
    const messageParams = params(chosen.msg);
    const title = chosen.msg.message?.title || '';
    const declared = String(messageParams.fileExt || path.extname(title).slice(1) || '').toLowerCase();
    const sniffed = sniff(bytes);
    let ext = sniffed ?? (declared || 'bin');
    // A photo, or a file named like an image, whose bytes are no image is unusable
    // (e.g. Intune-encrypted attachments): leave it to the importer's text fallback
    if (
      (chosen.msg.msgType === 2 || IMAGE_EXT.has(declared)) &&
      !['jpg', 'png', 'gif', 'webp', 'jxl'].includes(sniffed ?? '')
    ) {
      skippedCount++;
      console.warn(`${msgId}: not a readable image (${title || 'photo'}) — skipped`);
      continue;
    }
    let width;
    let height;
    if (ext === 'jxl') {
      const decodedImage = await decodeJxl(bytes);
      ({ width, height } = decodedImage);
      bytes = Buffer.from(await encodeJpeg(decodedImage, { quality: 90 }));
      ext = 'jpg';
    }
    if (ext === 'zip' && ['docx', 'xlsx', 'pptx'].includes(declared)) ext = declared;
    const fileName = `${msgId}.${ext}`;
    fs.writeFileSync(path.join(outDir, fileName), bytes);
    index[msgId] = {
      file: fileName,
      mimetype: MIME[ext] ?? 'application/octet-stream',
      size: bytes.length,
      ...(width ? { w: width, h: height } : {}),
      ...(chosen.msg.msgType === 19 && title ? { name: title } : {}),
    };
  } catch (err) {
    skippedCount++;
    console.warn(`${msgId}: ${err.message}`);
  }
}
fs.writeFileSync(path.join(outDir, 'media-index.json'), JSON.stringify(index));
console.log(
  `${fileCount} media files, ${unmatchedCount} unmatched; ${Object.keys(index).length} messages prepared, ${skippedCount} skipped → ${outDir}`,
);
