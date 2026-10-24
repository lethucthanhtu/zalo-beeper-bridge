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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [file, uinFile, outDir, flag] = process.argv.slice(2);
if (!file || !uinFile) throw new Error("usage: node backup-extract.mjs <backup.zl.zip> <uinFile> <outDir> [--peek|--list|--all]");
const uin = fs.readFileSync(uinFile, "utf8").trim();
const iv = Buffer.from("zie" + uin.slice(0, 13));
if (iv.length !== 16) throw new Error("UIN too short for the IV — wrong key file?");
const decipher = crypto.createDecipheriv("aes-256-cbc", crypto.createHash("sha256").update(uin).digest(), iv);

const str = (b) => b.toString("utf8").replace(/\0.*$/s, "");
const oct = (b) => parseInt(b.toString("latin1").replace(/\0.*$/s, "").trim() || "0", 8);
let buf = Buffer.alloc(0);
let cur = null; // entry being read
let longName = null; // GNU long-name / pax path for the next header
let done = false;
let count = 0;

function header(h) {
  if (h.every((x) => x === 0)) return null; // end-of-archive block
  if (h.subarray(257, 262).toString("latin1") !== "ustar") throw new Error("bad tar header — wrong UIN (key)?");
  let name = str(h.subarray(0, 100));
  const prefix = str(h.subarray(345, 500));
  if (prefix) name = `${prefix}/${name}`;
  if (longName) [name, longName] = [longName, null];
  return { name, size: oct(h.subarray(124, 136)), type: String.fromCharCode(h[156] || 48) };
}

function feed(chunk) {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  while (!done) {
    if (!cur) {
      if (buf.length < 512) return;
      const h = header(buf.subarray(0, 512));
      buf = buf.subarray(512);
      if (!h) {
        done = true;
        return;
      }
      if (flag === "--peek") {
        console.log(`key OK — first entry: ${h.name}`);
        process.exit(0);
      }
      cur = { ...h, left: h.size, pad: (512 - (h.size % 512)) % 512, meta: [] };
      const isFile = h.type === "0";
      if (isFile && flag === "--list") console.log(`${h.size}\t${h.name}`);
      if (isFile && outDir && flag !== "--list" && (flag === "--all" || h.name.includes("/database/"))) {
        const dst = path.join(outDir, h.name.replace(/[:?<>|]/g, "_"));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        cur.out = fs.openSync(dst, "w");
        count++;
      }
    }
    const n = Math.min(cur.left, buf.length);
    if (n > 0) {
      const part = buf.subarray(0, n);
      if (cur.type === "L" || cur.type === "x") cur.meta.push(Buffer.from(part));
      else if (cur.out) fs.writeSync(cur.out, part);
      buf = buf.subarray(n);
      cur.left -= n;
    }
    if (cur.left > 0 || buf.length < cur.pad) return;
    buf = buf.subarray(cur.pad);
    if (cur.type === "L") longName = str(Buffer.concat(cur.meta));
    if (cur.type === "x") longName = /\d+ path=([^\n]*)\n/.exec(Buffer.concat(cur.meta).toString("utf8"))?.[1] ?? null;
    if (cur.out) fs.closeSync(cur.out);
    cur = null;
  }
}

const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
rs.on("data", (c) => {
  try {
    feed(decipher.update(c));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
});
rs.on("end", () => {
  feed(decipher.final());
  if (flag !== "--list") console.log(`extracted ${count} file(s) into ${outDir}`);
});
