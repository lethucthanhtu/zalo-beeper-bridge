// Minimal Chrome DevTools Protocol client for the Zalo PC (Electron) main window.
// Zalo PC must be started with a local debug port:
//   "%LOCALAPPDATA%\Programs\Zalo\Zalo-<version>\Zalo.exe" --remote-debugging-port=9229
// Only Runtime.evaluate is used: reads go through the app's own (already decrypted)
// data layer, nothing is sent to Zalo servers.

const CDP_URL = process.env.ZALO_CDP_URL ?? "http://127.0.0.1:9229";

/** webpack require handle, cached on window (Zalo PC ships webpack 4 chunks) */
export const PRELUDE =
  'if(!window.__zbr){window.webpackJsonp.push([["__zbr_probe"],{__zbr_probe:(m,e,r)=>{window.__zbr=r}},[["__zbr_probe"]]])};';

/** Connects to the "Zalo" page target; returns evaluate(expression) and close(). */
export async function connectZaloPc() {
  const targets = await (await fetch(`${CDP_URL}/json/list`)).json();
  const page = targets.find((t) => t.type === "page" && t.title === "Zalo");
  if (!page) throw new Error(`Zalo main window not found at ${CDP_URL} — is Zalo PC running with --remote-debugging-port?`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const evaluate = async (expression) => {
    const id = ++seq;
    const res = await new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, timeout: 600000 } }));
    });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 500));
    return res.result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}
