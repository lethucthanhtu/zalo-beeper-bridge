// Websocket frame tap in front of the zca-js listener (zca-js 2.1.2/2.2.0 unchanged).
//
// Zalo delivers 1-1 messages of accounts in its E2EE rollout as cmd 551 instead of
// 501 (Zalo Web: SignalCommands.MSG.RECEIVE_ONEONE). zca-js only handles 501, so
// those DMs were dropped silently — the listener looked "connected" but no DM ever
// arrived. The payload envelope is identical, so rewriting the header cmd to 501
// routes them through the normal DM handler (zca-js PR #384, closed unmerged).
// Unknown cmds are logged once each so future protocol drift is visible.

// version(u8) | cmd(u16 LE) | subCmd(i8) — mirrors zca-js listen.js getHeader
const HEADER_BYTES = 4;
const E2EE_DM_CMD = 551;
const DM_CMD = 501;
// Every cmd zca-js 2.1.2 listen.js handles (plus 551, rerouted here)
const KNOWN_CMDS = new Set([1, 2, 501, 502, 510, 511, 521, 522, 551, 601, 602, 610, 611, 612, 3000]);

export function readHeader(frame: Buffer): { version: number; cmd: number; subCmd: number } | null {
  if (frame.byteLength < HEADER_BYTES) return null;
  return { version: frame[0]!, cmd: frame.readUInt16LE(1), subCmd: frame[3]! };
}

/** Returns the frame to hand to zca-js (a rewritten copy for E2EE DM pushes). */
export function rerouteFrame(frame: Buffer): Buffer {
  const header = readHeader(frame);
  if (!header || header.version !== 1 || header.cmd !== E2EE_DM_CMD || header.subCmd !== 0) return frame;
  const copy = Buffer.from(frame);
  copy.writeUInt16LE(DM_CMD, 1);
  return copy;
}

// ZALO_WS_TRACE=1 logs every frame header (cmd/subCmd/size only, never content)
const TRACE = process.env.ZALO_WS_TRACE === "1";

/** Structure of a decoded payload — key names, types and array sizes, never values. */
export function describeShape(value: unknown, depth = 3): string {
  if (Array.isArray(value)) return `[${value.length}]${value.length && depth > 0 ? describeShape(value[0], depth - 1) : ""}`;
  if (value && typeof value === "object") {
    if (depth <= 0) return "{…}";
    return `{${Object.entries(value).map(([k, v]) => `${k}:${describeShape(v, depth - 1)}`).join(",")}}`;
  }
  return typeof value;
}

// Mirrors zca-js utils.decodeEventData (not exported by the package)
async function decodePayload(body: { data?: unknown; encrypt?: unknown }, cipherKey: string | undefined): Promise<unknown> {
  if (typeof body.data !== "string" || typeof body.encrypt !== "number") return body;
  if (body.encrypt === 0) return JSON.parse(body.data);
  let buf: Buffer = Buffer.from(body.encrypt === 1 ? body.data : decodeURIComponent(body.data), "base64");
  if (body.encrypt !== 1 && cipherKey && buf.length >= 48) {
    const bytes = new Uint8Array(buf);
    const algorithm = { name: "AES-GCM", iv: bytes.slice(0, 16), tagLength: 128, additionalData: bytes.slice(16, 32) };
    const key = await crypto.subtle.importKey("raw", new Uint8Array(Buffer.from(cipherKey, "base64")), algorithm, false, ["decrypt"]);
    buf = Buffer.from(await crypto.subtle.decrypt(algorithm, key, bytes.slice(32)));
  }
  if (body.encrypt === 2 || body.encrypt === 3) {
    const { gunzipSync } = await import("node:zlib");
    try {
      buf = gunzipSync(buf);
    } catch {
      // not compressed
    }
  }
  return JSON.parse(buf.toString("utf8"));
}

type WsLike = { onmessage: ((event: { data: unknown }) => unknown) | null };
const tapped = new WeakSet<object>();
const reportedCmds = new Set<number>();

/** Wraps the listener's current websocket (call on every "connected" — zca-js opens a new ws per (re)connect). */
export function installFrameTap(listener: unknown): void {
  const ws = (listener as { ws?: WsLike | null }).ws;
  if (!ws || tapped.has(ws) || typeof ws.onmessage !== "function") return;
  tapped.add(ws);
  const original = ws.onmessage;
  ws.onmessage = (event) => {
    const { data } = event;
    if (!(data instanceof Buffer)) return original.call(ws, event);
    const header = readHeader(data);
    if (TRACE && header) console.log(`[zalo:ws] cmd=${header.cmd} sub=${header.subCmd} bytes=${data.byteLength}`);
    if (header && !KNOWN_CMDS.has(header.cmd) && !reportedCmds.has(header.cmd)) {
      reportedCmds.add(header.cmd);
      console.log(`[zalo] unhandled ws cmd ${header.cmd} (subCmd ${header.subCmd}) — not bridged`);
      if (TRACE) {
        const cipherKey = (listener as { cipherKey?: string }).cipherKey;
        void (async () => JSON.parse(data.subarray(HEADER_BYTES).toString("utf8")) as { data?: unknown; encrypt?: unknown })()
          .then((body) => decodePayload(body, cipherKey))
          .then((decoded) => {
            console.log(`[zalo:ws] cmd ${header.cmd} shape: ${describeShape(decoded)}`);
            // Server error frames carry only a code + message (no user content) — log them
            const err = decoded as { error_code?: unknown; error_message?: unknown; data?: { error_code?: unknown; error_message?: unknown } };
            if (err && typeof err === "object" && "error_code" in err) {
              console.log(`[zalo:ws] cmd ${header.cmd} error ${String(err.error_code)} "${String(err.error_message)}" / inner ${String(err.data?.error_code)} "${String(err.data?.error_message)}"`);
            }
          })
          .catch((err) => console.log(`[zalo:ws] cmd ${header.cmd} undecodable: ${(err as Error).message}`));
      }
    }
    if (header?.cmd === E2EE_DM_CMD && !reportedCmds.has(E2EE_DM_CMD)) {
      reportedCmds.add(E2EE_DM_CMD);
      console.log("[zalo] E2EE DM push (cmd 551) seen — rerouting to the DM handler");
    }
    return original.call(ws, { ...event, data: rerouteFrame(data) });
  };
}
