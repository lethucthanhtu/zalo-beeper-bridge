import { describe, expect, it, vi } from "vitest";
import { buildLinkPreview, buildMediaEvent } from "../media-content.ts";
import { sniffMimetype } from "../media-handler.ts";

const bytes = (...b: number[]) => Buffer.from([...b, ...new Array(16).fill(0)]);

describe("sniffMimetype", () => {
  it("trusts the bytes over Zalo's content-type", () => {
    expect(sniffMimetype(Buffer.from("GIF89a........"), "image/jpeg")).toBe("image/gif");
    expect(sniffMimetype(bytes(0xff, 0xd8, 0xff), "application/octet-stream")).toBe("image/jpeg");
    expect(sniffMimetype(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/jpeg")).toBe("image/png");
    expect(sniffMimetype(Buffer.from("RIFF\0\0\0\0WEBPVP8X"), "")).toBe("image/webp");
    expect(sniffMimetype(Buffer.from("\0\0\0\x20ftypisom...."), "image/jpeg")).toBe("video/mp4");
  });

  it("recognises raw ADTS AAC voice notes Zalo serves as image/jpeg", () => {
    expect(sniffMimetype(bytes(0xff, 0xf9, 0x50, 0x60), "image/jpeg")).toBe("audio/aac");
    expect(sniffMimetype(bytes(0xff, 0xf1, 0x50, 0x80), "image/jpeg")).toBe("audio/aac");
    expect(sniffMimetype(Buffer.from("#!AMR\n........"), "image/jpeg")).toBe("audio/amr");
  });

  it("keeps the fallback for unknown bytes", () => {
    expect(sniffMimetype(Buffer.from("hello world....."), "text/plain")).toBe("text/plain");
  });
});

describe("buildMediaEvent", () => {
  const upload = vi.fn(async () => "mxc://x/y");

  it("marks voice notes as MSC3245 voice with an audio type", async () => {
    const { type, content } = await buildMediaEvent(
      upload,
      { kind: "audio", urls: [], filename: "zalo-voice.m4a", durationMs: 5474.4 },
      { buffer: Buffer.alloc(10), mimetype: "image/jpeg" },
    );
    expect(type).toBe("m.room.message");
    expect(content).toMatchObject({
      msgtype: "m.audio",
      body: "zalo-voice.m4a",
      info: { mimetype: "audio/aac", size: 10, duration: 5474 },
      "org.matrix.msc3245.voice": {},
      "org.matrix.msc1767.audio": { duration: 5474 },
    });
  });

  it("builds stickers, files with names and reuses a cached mxc", async () => {
    upload.mockClear();
    const sticker = await buildMediaEvent(upload, { kind: "sticker", urls: [], stickerId: 1 }, { buffer: Buffer.alloc(4), mimetype: "image/webp", width: 130, height: 130 }, { mxcUrl: "mxc://x/cached" });
    expect(upload).not.toHaveBeenCalled();
    expect(sticker).toMatchObject({ type: "m.sticker", content: { body: "sticker", url: "mxc://x/cached", info: { w: 130, h: 130 } } });
    const file = await buildMediaEvent(upload, { kind: "file", urls: [], filename: "a.pdf" }, { buffer: Buffer.alloc(3), mimetype: "application/pdf" });
    expect(file.content).toMatchObject({ msgtype: "m.file", body: "a.pdf", filename: "a.pdf", url: "mxc://x/y" });
  });
});

describe("buildLinkPreview", () => {
  it("keeps a text-only preview when there is no thumbnail", async () => {
    const preview = await buildLinkPreview(vi.fn(), { url: "https://a.vn/x", title: "Trang A", description: "tóm tắt" }, 1000);
    expect(preview).toEqual({ matched_url: "https://a.vn/x", "og:url": "https://a.vn/x", "og:title": "Trang A", "og:description": "tóm tắt" });
  });
});
