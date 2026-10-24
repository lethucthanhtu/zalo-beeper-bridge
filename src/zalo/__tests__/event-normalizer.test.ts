// Fixtures mirror live shapes captured in Phase 1 (spike/raw-events.ndjson,
// documented in plans/.../reports/phase-01-spike-findings.md), identifiers anonymized.
import { describe, expect, it } from "vitest";
import { normalizeZaloMessage } from "../event-normalizer.ts";
import type { RawZaloMessage } from "../types.ts";

const dmText: RawZaloMessage = {
  type: 0,
  threadId: "1111111111111111111",
  isSelf: false,
  data: {
    msgId: "7998805079701",
    msgType: "webchat",
    uidFrom: "1111111111111111111",
    dName: "Test Sender",
    ts: "1782964481836",
    content: "xin chào",
  },
};

describe("normalizeZaloMessage", () => {
  it("normalizes DM text and captures the quotable payload", () => {
    const m = normalizeZaloMessage(dmText);
    expect(m).toEqual({
      msgId: "7998805079701",
      threadId: "1111111111111111111",
      threadType: "user",
      senderId: "1111111111111111111",
      senderName: "Test Sender",
      timestamp: 1782964481836,
      isSelf: false,
      content: { kind: "text", text: "xin chào" },
      rawMsgType: "webchat",
      quotable: {
        content: "xin chào",
        msgType: "webchat",
        propertyExt: null,
        uidFrom: "1111111111111111111",
        msgId: "7998805079701",
        cliMsgId: "",
        ts: "1782964481836",
        ttl: 0,
      },
    });
  });

  it("normalizes group text with type=1", () => {
    const m = normalizeZaloMessage({
      ...dmText,
      type: 1,
      threadId: "2222222222222222222",
      data: { ...dmText.data, content: "Lô" },
    });
    expect(m?.threadType).toBe("group");
    expect(m?.threadId).toBe("2222222222222222222");
    expect(m?.senderId).toBe("1111111111111111111"); // uidFrom stays the puppet key
    expect(m?.content).toEqual({ kind: "text", text: "Lô" });
  });

  it("normalizes chat.photo with dimensions from params JSON", () => {
    const m = normalizeZaloMessage({
      ...dmText,
      data: {
        ...dmText.data,
        msgType: "chat.photo",
        content: {
          href: "https://photo-stal-19.zdn.vn/x/y.jpg",
          thumb: "https://photo-stal-19.zdn.vn/x/y-thumb.jpg",
          params: '{"height":4032,"width":3024,"hd":"https://cdn/hd.jpg"}',
        },
      },
    });
    expect(m?.content).toEqual({
      kind: "photo",
      url: "https://photo-stal-19.zdn.vn/x/y.jpg",
      thumbUrl: "https://photo-stal-19.zdn.vn/x/y-thumb.jpg",
      width: 3024,
      height: 4032,
    });
  });

  it("keeps photo without dimensions when params is malformed", () => {
    const m = normalizeZaloMessage({
      ...dmText,
      data: { ...dmText.data, msgType: "chat.photo", content: { href: "https://cdn/p.jpg", params: "{broken" } },
    });
    expect(m?.content).toMatchObject({ kind: "photo", url: "https://cdn/p.jpg", width: undefined });
  });

  it("normalizes chat.sticker to id+catId", () => {
    const m = normalizeZaloMessage({
      ...dmText,
      data: { ...dmText.data, msgType: "chat.sticker", content: { id: 18009, catId: 10130, type: 7 } },
    });
    expect(m?.content).toEqual({ kind: "sticker", id: 18009, catId: 10130 });
  });

  it("marks unknown msgTypes unsupported and marks isSelf", () => {
    const m = normalizeZaloMessage({
      ...dmText,
      isSelf: true,
      data: { ...dmText.data, msgType: "chat.todo", content: { something: true } },
    });
    expect(m?.isSelf).toBe(true);
    expect(m?.content).toEqual({ kind: "unsupported", msgType: "chat.todo" });
  });

  it("normalizes video / file / voice / GIF attachments to media descriptors", () => {
    const of = (msgType: string, content: unknown) => normalizeZaloMessage({ ...dmText, data: { ...dmText.data, msgType, content } })?.content;
    expect(of("chat.video.msg", { href: "https://v.dlmd.me/a", params: '{"duration":7000,"video_width":576,"video_height":1024,"fileSize":99}' })).toEqual({
      kind: "media",
      media: { kind: "video", urls: ["https://v.dlmd.me/a"], filename: "zalo-video.mp4", caption: undefined, width: 576, height: 1024, durationMs: 7000, size: 99 },
    });
    expect(of("share.file", { title: "a.pdf", href: "https://f.zdn.vn/a", params: '{"fileSize":"375945"}' })).toEqual({
      kind: "media",
      media: { kind: "file", urls: ["https://f.zdn.vn/a"], filename: "a.pdf", size: 375945 },
    });
    expect(of("chat.voice", { href: "https://v.zdn.vn/a.m4a", params: '{"duration":4000}' })).toMatchObject({ kind: "media", media: { kind: "audio", durationMs: 4000 } });
    expect(of("chat.gif", { href: "https://zalo-gif.zadn.vn/a.gif", thumb: "https://zalo-gif.zadn.vn/a.jpg" })).toMatchObject({
      kind: "media",
      media: { kind: "image", urls: ["https://zalo-gif.zadn.vn/a.gif", "https://zalo-gif.zadn.vn/a.jpg"] },
    });
  });

  it("renders link cards as text with a Beeper link preview", () => {
    const m = normalizeZaloMessage({
      ...dmText,
      data: {
        ...dmText.data,
        msgType: "chat.recommended",
        content: { href: "https://lttt.dev/x", title: "https://lttt.dev/x", description: "Mô tả", thumb: "https://photo-link-talk.zadn.vn/t.jpg", params: '{"mediaTitle":"Trang X"}' },
      },
    });
    expect(m?.content).toEqual({
      kind: "text",
      text: "https://lttt.dev/x",
      linkPreview: { url: "https://lttt.dev/x", title: "Trang X", description: "Mô tả", imageUrl: "https://photo-link-talk.zadn.vn/t.jpg" },
    });
  });

  it("returns null when msgId is missing", () => {
    const m = normalizeZaloMessage({ ...dmText, data: { ...dmText.data, msgId: "" } });
    expect(m).toBeNull();
  });

  it("never exposes E2EE ciphertext as text (cmd 551 pushes carry an e2ee field)", () => {
    const msg = normalizeZaloMessage({
      type: 0,
      threadId: "111",
      isSelf: false,
      data: { msgId: "9", msgType: "webchat", uidFrom: "111", ts: "1", content: "MwohBQ==", e2ee: '{"version":1,"compat_version":0,"iid":603}' },
    });
    expect(msg?.content).toEqual({ kind: "unsupported", msgType: "e2ee" });
  });
});
