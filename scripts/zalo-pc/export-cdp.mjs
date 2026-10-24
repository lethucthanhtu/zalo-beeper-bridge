// Export Zalo PC message history through the app's own data layer over local CDP.
// Output: <outDir>/conversations.json + <outDir>/<threadKey>.ndjson (one raw Core.Message
// row per line, oldest first). threadKey = "g<groupId>" for groups, the peer uid for DMs.
//
// Usage: node scripts/zalo-pc/export-cdp.mjs <outDir> [threadKey1,threadKey2,...]
//   (no key list = every conversation Zalo PC knows)
import fs from "node:fs";
import path from "node:path";
import { connectZaloPc, PRELUDE } from "./cdp.mjs";

const [outDir, only] = process.argv.slice(2);
if (!outDir) throw new Error("usage: node export-cdp.mjs <outDir> [key1,key2,...]");
const ONLY = new Set((only ?? "").split(",").filter(Boolean));
fs.mkdirSync(outDir, { recursive: true });

const { evaluate, close } = await connectZaloPc();
const DB = `${PRELUDE} const DB=window.__zbr("fsN4").default.getInstance();`;

// Conversations + names (friends / groups) from the app's own tables
const meta = await evaluate(`(async()=>{${DB}
  const convs = await DB.Core.Conversation.getAll();
  const groups = await DB.Core.Group.getAll().catch(()=>[]);
  const friends = await DB.Core.Friend.getAll().catch(()=>[]);
  const name = (o)=>o&&(o.displayName||o.name||o.zaloName||o.dName||null);
  const gmap = Object.fromEntries(groups.map(g=>[String(g.groupId||g.userId||g.id), name(g)]));
  const fmap = Object.fromEntries(friends.map(f=>[String(f.userId||f.id), name(f)]));
  return { convs: convs.map(c=>({ key:String(c.userId), isGroup: !!c.isGroup || String(c.userId).startsWith("g"), numMsg:c.numMsg ?? null, pinned: !!c.pinned })), gmap, fmap };
})()`);
fs.writeFileSync(path.join(outDir, "conversations.json"), JSON.stringify(meta));
console.log(`conversations: ${meta.convs.length}, groups named: ${Object.keys(meta.gmap).length}, friends named: ${Object.keys(meta.fmap).length}`);

// Fields the importer uses (the rest of a Core.Message row is UI state)
const KEEP = ["msgId", "cliMsgId", "fromUid", "toUid", "msgType", "sendDttm", "serverTime", "message", "content", "msgText", "dName", "quote", "mentions", "subType", "properties", "e2eeStatus", "act", "action", "isLocalMsgId", "width", "height", "fileSize"];
let total = 0;
for (const conv of meta.convs) {
  const key = conv.key;
  if (ONLY.size && !ONLY.has(key)) continue;
  const rows = [];
  let upper = ["￿", "￿"]; // [sendDttm, msgId] exclusive upper bound, paging backwards
  for (;;) {
    const batch = await evaluate(`(async()=>{${DB}
      const keep=${JSON.stringify(KEEP)};
      const page = await DB.Core.Message.getAll({from:[${JSON.stringify(key)},"",""],to:[${JSON.stringify(key)},${JSON.stringify(upper[0])},${JSON.stringify(upper[1])}],excludeFrom:false,excludeTo:true},{index:"userId_sendDttm_msgId",direction:"prev",limit:2000,partition:${JSON.stringify(key)}});
      return page.map(m=>{const o={};for(const k of keep){if(m[k]!==undefined&&m[k]!==null&&m[k]!=="")o[k]=m[k]}return o});
    })()`);
    if (!batch.length) break;
    rows.push(...batch);
    const last = batch[batch.length - 1];
    const next = [String(last.sendDttm), String(last.msgId)];
    if (next[0] === upper[0] && next[1] === upper[1]) break;
    upper = next;
    if (batch.length < 2000) break;
  }
  rows.reverse(); // oldest first
  fs.writeFileSync(path.join(outDir, `${key}.ndjson`), rows.map((r) => JSON.stringify(r)).join("\n"));
  total += rows.length;
  process.stdout.write(`${key}:${rows.length} `);
}
console.log(`\nTOTAL messages: ${total}`);
close();
