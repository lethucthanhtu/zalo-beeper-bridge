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
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import decodeJxl, { init as initJxl } from "@jsquash/jxl/decode.js";
import encodeJpeg, { init as initJpeg } from "@jsquash/jpeg/encode.js";

const [root, owner, outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: node backup-media.mjs <ZaloDownloads dir> <ownerUid> <outDir>");
const require = createRequire(import.meta.url);
const wasm = (spec) => WebAssembly.compile(fs.readFileSync(require.resolve(spec)));
await initJxl(await wasm("@jsquash/jxl/codec/dec/jxl_dec.wasm"));
await initJpeg(await wasm("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"));

const MEDIA_TYPES = new Set([2, 3, 7, 18, 19]); // photo, voice, GIF, video, file
const MIME = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic"]);

/** Real format from the first bytes; null when unknown. */
function sniff(b) {
  const hex = b.subarray(0, 8).toString("hex");
  if (hex.startsWith("ffd8ff")) return "jpg";
  if (hex.startsWith("89504e47")) return "png";
  if (hex.startsWith("47494638")) return "gif";
  if (hex.startsWith("52494646") && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (hex.startsWith("ff0a") || hex.startsWith("0000000c4a584c20")) return "jxl";
  if (b.subarray(4, 8).toString("latin1") === "ftyp") return b.subarray(8, 10).toString("latin1") === "qt" ? "mov" : "mp4";
  if (hex.startsWith("25504446")) return "pdf";
  if (hex.startsWith("504b0304")) return "zip";
  return null;
}

function denoise(buf) {
  const out = Buffer.from(buf.subarray(0, buf.length - 6));
  for (let i = 0; i < Math.min(100, out.length); i++) out[i] ^= 0x93;
  return out;
}

const params = (m) => {
  try {
    const p = m.message?.params;
    return p ? (typeof p === "string" ? JSON.parse(p) : p) : {};
  } catch {
    return {};
  }
};
const convOf = (m) => (String(m.toUid).startsWith("g") ? m.toUid : m.fromUid === "0" ? m.toUid : m.fromUid);
const senderOf = (m) => (m.fromUid === "0" ? owner : m.fromUid);

// Media messages, indexed the two ways backup file names refer to them
const zdb = path.join(root, "database", `${owner}_zmessage.zdb`);
const byCli = new Map();
const byChecksum = new Map();
for (const line of fs.readFileSync(zdb, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (!MEDIA_TYPES.has(m.msgType)) continue;
  (byCli.get(String(m.cliMsgId)) ?? byCli.set(String(m.cliMsgId), []).get(String(m.cliMsgId))).push(m);
  const sum = params(m).checksum;
  if (sum) (byChecksum.get(sum) ?? byChecksum.set(sum, []).get(sum)).push(m);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// msgId → best file (resource/ over flat copies, plain over fileNoise)
const best = new Map();
let files = 0;
let unmatched = 0;
for (const p of walk(root)) {
  const rel = path.relative(root, p).split(path.sep);
  const name = rel.at(-1);
  if (rel[0] === "database" || name === ".rescache") continue;
  files++;
  const noise = rel.includes("fileNoise");
  let cands = [];
  const r = /^(\d+)_(\d+)_(g?\d+)(?:_[0-9a-f]{32})?(?:\.[a-z0-9]+)?$/i.exec(name);
  if (rel[0] === "resource" && r) {
    const [, cli, sender, conv] = r;
    const same = (byCli.get(cli) ?? []).filter((m) => convOf(m) === conv);
    cands = same.filter((m) => senderOf(m) === sender);
    if (!cands.length) cands = same;
  } else if (/^[0-9a-f]{32}$/.test(name)) cands = byChecksum.get(name) ?? [];
  if (!cands.length) {
    unmatched++;
    continue;
  }
  const score = (noise ? 0 : 2) + (rel[0] === "resource" ? 1 : 0);
  for (const m of cands) {
    const prev = best.get(String(m.msgId));
    if (!prev || score > prev.score) best.set(String(m.msgId), { path: p, noise, score, msg: m });
  }
}

fs.mkdirSync(outDir, { recursive: true });
const index = {};
let skipped = 0;
for (const [msgId, f] of best) {
  try {
    let buf = fs.readFileSync(f.path);
    if (f.noise) buf = denoise(buf);
    const p = params(f.msg);
    const title = f.msg.message?.title || "";
    const declared = String(p.fileExt || path.extname(title).slice(1) || "").toLowerCase();
    const sniffed = sniff(buf);
    let ext = sniffed ?? (declared || "bin");
    // A photo, or a file named like an image, whose bytes are no image is unusable
    // (e.g. Intune-encrypted attachments): leave it to the importer's text fallback
    if ((f.msg.msgType === 2 || IMAGE_EXT.has(declared)) && !["jpg", "png", "gif", "webp", "jxl"].includes(sniffed ?? "")) {
      skipped++;
      console.warn(`${msgId}: not a readable image (${title || "photo"}) — skipped`);
      continue;
    }
    let w;
    let h;
    if (ext === "jxl") {
      const img = await decodeJxl(buf);
      ({ width: w, height: h } = img);
      buf = Buffer.from(await encodeJpeg(img, { quality: 90 }));
      ext = "jpg";
    }
    if (ext === "zip" && ["docx", "xlsx", "pptx"].includes(declared)) ext = declared;
    const file = `${msgId}.${ext}`;
    fs.writeFileSync(path.join(outDir, file), buf);
    index[msgId] = {
      file,
      mimetype: MIME[ext] ?? "application/octet-stream",
      size: buf.length,
      ...(w ? { w, h } : {}),
      ...(f.msg.msgType === 19 && title ? { name: title } : {}),
    };
  } catch (err) {
    skipped++;
    console.warn(`${msgId}: ${err.message}`);
  }
}
fs.writeFileSync(path.join(outDir, "media-index.json"), JSON.stringify(index));
console.log(`${files} media files, ${unmatched} unmatched; ${Object.keys(index).length} messages prepared, ${skipped} skipped → ${outDir}`);
