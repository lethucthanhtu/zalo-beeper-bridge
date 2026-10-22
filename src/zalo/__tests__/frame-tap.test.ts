import { describe, expect, it } from "vitest";
import { installFrameTap, readHeader, rerouteFrame } from "../frame-tap.ts";

function frame(version: number, cmd: number, subCmd: number, body = '{"data":"x","encrypt":2}'): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt8(version, 0);
  header.writeUInt16LE(cmd, 1);
  header.writeInt8(subCmd, 3);
  return Buffer.concat([header, Buffer.from(body)]);
}

describe("frame tap", () => {
  it("rewrites E2EE DM pushes (cmd 551) to the DM cmd 501, payload untouched", () => {
    const original = frame(1, 551, 0);
    const routed = rerouteFrame(original);
    expect(readHeader(routed)).toEqual({ version: 1, cmd: 501, subCmd: 0 });
    expect(routed.subarray(4).equals(original.subarray(4))).toBe(true);
    expect(readHeader(original)?.cmd).toBe(551); // input not mutated
  });

  it("leaves every other frame alone", () => {
    for (const f of [frame(1, 501, 0), frame(1, 521, 0), frame(1, 551, 1), frame(2, 551, 0)]) {
      expect(rerouteFrame(f)).toBe(f);
    }
  });

  it("wraps the listener websocket once and feeds the rerouted frame to zca-js", () => {
    const seen: number[] = [];
    const ws = { onmessage: (event: { data: unknown }) => void seen.push(readHeader(event.data as Buffer)!.cmd) };
    const listener = { ws };
    installFrameTap(listener);
    installFrameTap(listener); // idempotent per websocket
    ws.onmessage({ data: frame(1, 551, 0) });
    ws.onmessage({ data: frame(1, 521, 0) });
    expect(seen).toEqual([501, 521]);
  });
});
