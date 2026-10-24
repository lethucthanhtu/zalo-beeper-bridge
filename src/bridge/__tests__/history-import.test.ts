import { describe, expect, it } from "vitest";
import { dropShadowCopies, jxlToJpgUrl, parseThreadKey, quoteFallback, renderExportRow, stickerImageUrl, type ExportRow } from "../history-import.ts";

const base = { msgId: "100", cliMsgId: "200", sendDttm: "1700000000000" };

describe("parseThreadKey", () => {
  it("splits group (g-prefixed) and DM keys", () => {
    expect(parseThreadKey("g123")).toEqual({ threadId: "123", threadType: "group" });
    expect(parseThreadKey("456")).toEqual({ threadId: "456", threadType: "user" });
  });
});

describe("renderExportRow", () => {
  it("maps fromUid 0 to the owner and keeps the original timestamp", () => {
    const ev = renderExportRow({ ...base, fromUid: "0", msgType: 1, message: "chào" }, "user", "456");
    expect(ev).toMatchObject({ msgId: "100", cliMsgId: "200", timestamp: 1700000000000, sender: { kind: "owner" } });
    expect(ev?.content).toEqual({ msgtype: "m.text", body: "chào" });
  });

  it("attributes group messages to the sender ghost with its dName", () => {
    const ev = renderExportRow({ ...base, fromUid: "789", dName: "Bob", msgType: 1, message: "hi" }, "group", "123");
    expect(ev?.sender).toEqual({ kind: "ghost", uid: "789", name: "Bob" });
  });

  it("sends sender-less system rows as the bot in groups and as the peer in DMs", () => {
    const row: ExportRow = { ...base, msgType: -4, message: "Rabbit đã rời khỏi nhóm", act: "leave" };
    expect(renderExportRow(row, "group", "123")?.sender).toEqual({ kind: "bot" });
    expect(renderExportRow(row, "user", "456")?.sender).toEqual({ kind: "ghost", uid: "456" });
    expect(renderExportRow(row, "group", "123")?.content.msgtype).toBe("m.notice");
  });

  it("describes photos as image media with a text fallback", () => {
    const ev = renderExportRow(
      { ...base, fromUid: "789", msgType: 2, message: { title: "cap", hdUrl: "https://f1.zdn.vn/a.jpg", params: '{"width":10,"height":20}' } },
      "group",
      "123",
    );
    expect(ev?.content.body).toBe("📷 [Ảnh 10×20 — không còn trên máy chủ Zalo]\ncap");
    expect(ev?.media).toEqual({ kind: "image", urls: ["https://f1.zdn.vn/a.jpg"], caption: "cap", width: 10, height: 20, size: undefined });
  });

  it("rewrites JPEG XL photo URLs to their JPEG twin", () => {
    expect(jxlToJpgUrl("https://photo-stal-12.zdn.vn/no/jxl/9c59/2aOb.jxl?jxlstatus=1")).toBe("https://photo-stal-12.zdn.vn/no/jpg/9c59/2aOb.jpg");
    const ev = renderExportRow(
      { ...base, fromUid: "789", msgType: 2, message: { hdUrl: "https://p.zdn.vn/no/jxl/a/b.jxl?jxlstatus=1", oriUrl: "https://p.zdn.vn/no/jxl/a/b.jxl?jxlstatus=1" } },
      "user",
      "789",
    );
    expect(ev?.media?.urls).toEqual(["https://p.zdn.vn/no/jpg/a/b.jpg"]);
  });

  it("describes stickers, videos, files and voice as native media", () => {
    const sticker = renderExportRow({ ...base, fromUid: "789", msgType: 4, message: { id: 28408, catId: 10788, type: 7 } }, "user", "789");
    expect(sticker?.media).toEqual({ kind: "sticker", urls: [stickerImageUrl(28408)], stickerId: 28408 });
    const video = renderExportRow(
      { ...base, fromUid: "789", msgType: 18, message: { duration: 77000, oriUrl: "https://v.dlmd.me/x", params: '{"video_width":576,"video_height":1024,"fileSize":11184731}' } },
      "user",
      "789",
    );
    expect(video?.content.body).toBe("🎬 [Video 77s — không còn trên máy chủ Zalo]");
    expect(video?.media).toMatchObject({ kind: "video", urls: ["https://v.dlmd.me/x"], width: 576, height: 1024, durationMs: 77000 });
    const file = renderExportRow(
      { ...base, fromUid: "789", msgType: 19, message: { title: "a.pdf", href: "https://x.zdn.vn/y", params: '{"fileSize":"375945"}' } },
      "user",
      "789",
    );
    expect(file?.content.body).toBe("📎 [Tệp] a.pdf (367 KB) — không còn trên máy chủ Zalo");
    expect(file?.media).toEqual({ kind: "file", urls: ["https://x.zdn.vn/y"], filename: "a.pdf", size: 375945 });
    const voice = renderExportRow({ ...base, fromUid: "789", msgType: 3, message: { params: '{"m4a":"https://v.zdn.vn/a.m4a","duration":4000}' } }, "user", "789");
    expect(voice?.media).toMatchObject({ kind: "audio", urls: ["https://v.zdn.vn/a.m4a"], durationMs: 4000 });
  });

  it("keeps person mentions and drops uid-less @All ranges", () => {
    const ev = renderExportRow(
      { ...base, fromUid: "789", msgType: 1, message: "@All @Bob hi", mentions: [{ pos: 0, len: 4 }, { uid: "42", pos: 5, len: 4 }] },
      "group",
      "123",
    );
    expect(ev?.mentions).toEqual([{ uid: "42", pos: 5, len: 4 }]);
  });

  it("fills system templates from highlight names", () => {
    const params = JSON.stringify({ msg: { vi: "%1$s đã ghim tin nhắn %2$s." }, highLightsV2: [{ dpn: "Hà" }, { dpn: "abc" }] });
    const ev = renderExportRow({ ...base, fromUid: "1", msgType: -1909, message: { title: "", params } }, "group", "123");
    expect(ev?.content.body).toBe("Hà đã ghim tin nhắn abc.");
  });

  it("keeps the quote target for a Matrix reply, with a text fallback", () => {
    const ev = renderExportRow(
      { ...base, fromUid: "0", msgType: 1, message: "ok", quote: { fromD: "Cody", msg: "line1\nline2", globalMsgId: 77 } },
      "user",
      "456",
    );
    expect(ev?.content.body).toBe("ok");
    expect(ev?.quote).toEqual({ msgId: "77", fromName: "Cody", text: "line1" });
    expect(quoteFallback(ev!.quote!)).toBe("> Cody: line1\n\n");
    const media = renderExportRow({ ...base, fromUid: "0", msgType: 1, message: "ok", quote: { fromD: "Cody", msg: { title: "" } } }, "user", "456");
    expect(media?.quote).toEqual({ msgId: undefined, fromName: "Cody", text: "[đính kèm]" });
  });

  it("turns link cards into a link preview and calls into a notice", () => {
    const ev = renderExportRow(
      {
        ...base,
        fromUid: "0",
        msgType: 6,
        message: { action: "recommened.link", title: "https://a.vn/x", href: "https://a.vn/x", description: "tóm tắt", thumb: "https://photo-link-talk.zadn.vn/t", params: '{"mediaTitle":"Trang A"}' },
      },
      "user",
      "456",
    );
    expect(ev?.content.body).toBe("Trang A\nhttps://a.vn/x");
    expect(ev?.linkPreview).toEqual({ url: "https://a.vn/x", title: "Trang A", description: "tóm tắt", imageUrl: "https://photo-link-talk.zadn.vn/t" });
    const call = renderExportRow({ ...base, fromUid: "0", msgType: 6, message: { action: "recommened.calltime", title: "Cuộc gọi đi" } }, "user", "456");
    expect(call?.content).toEqual({ msgtype: "m.notice", body: "📞 Cuộc gọi đi" });
  });

  it("drops the owner's shadow copies (msgId_NNN with the real row present)", () => {
    const rows: ExportRow[] = [
      { ...base, msgId: "8274827362096_001", cliMsgId: "1789650453500", fromUid: "0", msgType: 1, message: "Ơ" },
      { ...base, msgId: "8274829777338", cliMsgId: "1789650453500", fromUid: "0", msgType: 1, message: "Ơ" },
      { ...base, msgId: "907083683716_000", cliMsgId: "1", fromUid: "0", msgType: 6, message: {} }, // only copy
    ];
    expect(dropShadowCopies(rows).map((r) => r.msgId)).toEqual(["8274829777338", "907083683716_000"]);
  });

  it("drops rows without ids or content", () => {
    expect(renderExportRow({ ...base, msgId: "", msgType: 1, message: "x" }, "user", "1")).toBeNull();
    expect(renderExportRow({ ...base, msgType: 1, message: "  " }, "user", "1")).toBeNull();
  });
});
