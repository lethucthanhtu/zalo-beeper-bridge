// Minimal Chrome DevTools Protocol client for the Zalo PC (Electron) main window.
// Zalo PC must be started with a local debug port:
//   "%LOCALAPPDATA%\Programs\Zalo\Zalo-<version>\Zalo.exe" --remote-debugging-port=9229
// Only Runtime.evaluate is used: reads go through the app's own (already decrypted)
// data layer, nothing is sent to Zalo servers.

const CDP_URL = process.env.ZALO_CDP_URL ?? 'http://127.0.0.1:9229';

/** webpack require handle, cached on window (Zalo PC ships webpack 4 chunks) */
export const PRELUDE =
  'if(!window.__zbr){window.webpackJsonp.push([["__zbr_probe"],{__zbr_probe:(m,e,r)=>{window.__zbr=r}},[["__zbr_probe"]]])};';

/**
 * Connects to the "Zalo" page target over its CDP websocket.
 *
 * @returns `evaluate(expression)` — runs JS in the Zalo window (promises awaited, result
 *   returned by value; throws with the first 500 chars of the exception details when the
 *   expression throws) — and `close()` to drop the websocket.
 * @throws When the CDP endpoint is unreachable or no page titled "Zalo" exists.
 */
export async function connectZaloPc() {
  const targets = await (await fetch(`${CDP_URL}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page' && target.title === 'Zalo');
  if (!page)
    throw new Error(`Zalo main window not found at ${CDP_URL} — is Zalo PC running with --remote-debugging-port?`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let lastRequestId = 0;
  /** CDP request id → { resolve, reject } of the matching reply */
  const pendingRequests = new Map();
  socket.onmessage = (event) => {
    const reply = JSON.parse(event.data);
    pendingRequests.get(reply.id)?.resolve(reply);
    pendingRequests.delete(reply.id);
  };
  /** Fails every in-flight request — otherwise their callers would wait forever. */
  const failPending = (reason) => {
    for (const { reject } of pendingRequests.values()) reject(new Error(reason));
    pendingRequests.clear();
  };
  socket.onclose = () => failPending('CDP connection to Zalo PC closed (was Zalo PC quit or restarted?)');
  socket.onerror = () => failPending('CDP connection to Zalo PC failed');
  /**
   * Evaluates `expression` in the Zalo page via `Runtime.evaluate` (10-minute CDP timeout).
   *
   * @param {string} expression - JavaScript source to run inside Zalo PC.
   * @returns The expression's (awaited) value, serialised by value.
   * @throws When the expression throws, CDP rejects the request, or the connection drops.
   */
  const evaluate = async (expression) => {
    const id = ++lastRequestId;
    const reply = await new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true, timeout: 600000 },
        }),
      );
    });
    // A protocol-level error (bad params, target gone) carries no result at all
    if (reply.error) throw new Error(`CDP error ${reply.error.code}: ${reply.error.message}`);
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 500));
    return reply.result?.result?.value;
  };
  return { evaluate, close: () => socket.close() };
}
