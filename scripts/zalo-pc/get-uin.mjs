// Print the backup key of the logged-in Zalo PC session (the login response's `dkey`,
// which Zalo PC calls the session UIN). It is what encrypts "Xuất dữ liệu" (.zl.zip)
// backups. SECRET: anyone holding it can decrypt your backups — write it to a private
// file and delete it when done. Read-only, one Runtime.evaluate, no network calls.
//
// Usage: node scripts/zalo-pc/get-uin.mjs > uin.txt
import { connectZaloPc, PRELUDE } from './cdp.mjs';

const { evaluate, close } = await connectZaloPc();
// Runs inside Zalo PC (keep verbatim): probes webpack module "PoHQ", then every loaded module,
// for an object (or singleton getInstance()) exposing getSessionUIN(); returns the first hit or null.
const uin = await evaluate(`(()=>{${PRELUDE}
  const r=window.__zbr; const hits=[];
  const look=(o)=>{ if(!o) return; for(const v of Object.values(o)){ try{
      if(v&&typeof v.getSessionUIN==="function"){const u=v.getSessionUIN(); if(u) hits.push(u);}
      const inst=v&&typeof v.getInstance==="function"?v.getInstance():null;
      if(inst&&typeof inst.getSessionUIN==="function"){const u=inst.getSessionUIN(); if(u) hits.push(u);}
    }catch(e){} } };
  try{ look(r("PoHQ")); }catch(e){}
  if(!hits.length && r.c){ for(const k in r.c){ look(r.c[k] && r.c[k].exports); if(hits.length) break; } }
  return hits[0]||null;
})()`);
close();
if (!uin) {
  console.error('session UIN not found — is Zalo PC logged in?');
  process.exit(1);
}
process.stdout.write(String(uin));
