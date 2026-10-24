// Raw zca-js message → ZaloMessage. All zca-js payload quirks live here.
import type { MediaDescriptor } from "../bridge/media-content.ts";
import type { RawZaloMessage, ZaloContent, ZaloMessage } from "./types.ts";

/** chat.photo content shape observed in fixtures */
interface PhotoContent {
  href?: string;
  thumb?: string;
  params?: string; // JSON string: {width, height, hd, ...}
  title?: string; // Zalo puts the photo caption here
  description?: string;
}

interface StickerContent {
  id?: number;
  catId?: number;
}

function normalizeContent(msgType: string, content: unknown): ZaloContent {
  if (msgType === "webchat" && typeof content === "string") {
    return { kind: "text", text: content };
  }
  if (msgType === "chat.photo" && typeof content === "object" && content !== null) {
    const photo = content as PhotoContent;
    if (photo.href) {
      let width: number | undefined;
      let height: number | undefined;
      try {
        const params = JSON.parse(photo.params ?? "{}") as { width?: number; height?: number };
        width = params.width;
        height = params.height;
      } catch {
        // params malformed — dimensions are optional
      }
      return { kind: "photo", url: photo.href, thumbUrl: photo.thumb, width, height, caption: photo.title || photo.description || undefined };
    }
  }
  if (msgType === "chat.sticker" && typeof content === "object" && content !== null) {
    const sticker = content as StickerContent;
    if (typeof sticker.id === "number" && typeof sticker.catId === "number") {
      return { kind: "sticker", id: sticker.id, catId: sticker.catId };
    }
  }
  if (typeof content === "object" && content !== null) {
    const media = normalizeMedia(msgType, content as AttachmentContent);
    if (media) return { kind: "media", media };
  }
  // Link/card types (chat.recommended, chat.link, chat.ecard, ...) carry an href +
  // title/description — a text line with the URL plus a Beeper link preview.
  if (typeof content === "object" && content !== null) {
    const card = content as AttachmentContent;
    if (card.href) {
      const params = parseParams(card.params);
      const label = card.title || card.description || "";
      const text = label && !label.includes(card.href) ? `${label}\n${card.href}` : card.href;
      const title = (typeof params.mediaTitle === "string" && params.mediaTitle) || (card.title && card.title !== card.href ? card.title : "");
      const description = card.description && card.description !== card.href && card.description !== title ? card.description : "";
      const linkPreview = /^https?:\/\//.test(card.href)
        ? {
            url: card.href,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            ...(card.thumb && /^https?:\/\//.test(card.thumb) ? { imageUrl: card.thumb } : {}),
          }
        : undefined;
      return { kind: "text", text, ...(linkPreview ? { linkPreview } : {}) };
    }
  }
  return { kind: "unsupported", msgType };
}

interface AttachmentContent {
  href?: string;
  thumb?: string;
  title?: string;
  description?: string;
  params?: string;
}

function parseParams(params: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(params ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {}; // params malformed — all fields are optional
  }
}

const positive = (v: unknown): number | undefined => (Number(v) > 0 ? Number(v) : undefined);

/** Video / file / voice / GIF / doodle attachments → a downloadable media descriptor. */
function normalizeMedia(msgType: string, c: AttachmentContent): MediaDescriptor | null {
  if (!c.href) return null;
  const p = parseParams(c.params);
  switch (msgType) {
    case "chat.video.msg":
      return {
        kind: "video",
        urls: [c.href],
        filename: "zalo-video.mp4",
        caption: c.title || undefined,
        width: positive(p.video_width),
        height: positive(p.video_height),
        durationMs: positive(p.duration),
        size: positive(p.fileSize),
      };
    case "share.file":
      return { kind: "file", urls: [c.href], filename: c.title || "zalo-file", size: positive(p.fileSize) };
    case "chat.voice":
      return { kind: "audio", urls: [c.href], filename: "zalo-voice.m4a", durationMs: positive(p.duration), size: positive(p.fileSize) };
    case "chat.gif":
      return { kind: "image", urls: [c.href, ...(c.thumb ? [c.thumb] : [])], filename: "zalo.gif", width: positive(p.width), height: positive(p.height) };
    case "chat.doodle":
      return { kind: "image", urls: [c.href], filename: "zalo-doodle.png", width: positive(p.width), height: positive(p.height) };
    default:
      return null;
  }
}

/** Returns null for events that carry no bridgeable message (missing ids). */
export function normalizeZaloMessage(raw: RawZaloMessage): ZaloMessage | null {
  const d = raw.data;
  // uidFrom is the Phase 4 puppet key — never let "undefined" become a ghost id
  if (!d?.msgId || !raw.threadId || !d.uidFrom) return null;
  // E2EE 1-1 chats (Signal protocol): the content is ciphertext this web session cannot
  // decrypt — never post it as text, surface a notice instead
  const content: ZaloContent = d.e2ee ? { kind: "unsupported", msgType: "e2ee" } : normalizeContent(d.msgType, d.content);
  return {
    msgId: String(d.msgId),
    threadId: raw.threadId,
    threadType: raw.type === 1 ? "group" : "user",
    senderId: String(d.uidFrom),
    senderName: d.dName || undefined,
    timestamp: Number(d.ts) || Date.now(),
    isSelf: raw.isSelf === true,
    content,
    cliMsgId: d.cliMsgId != null ? String(d.cliMsgId) : undefined,
    rawMsgType: d.msgType,
    // Any message can be quoted later (Matrix reply → Zalo quote): keep the raw content
    quotable: {
      content: d.content,
      msgType: d.msgType,
      propertyExt: d.propertyExt ?? null,
      uidFrom: String(d.uidFrom),
      msgId: String(d.msgId),
      cliMsgId: String(d.cliMsgId ?? ""),
      ts: String(d.ts),
      ttl: d.ttl ?? 0,
    },
    // Zalo quote → the quoted message's global msgId (Matrix reply mapping)
    replyToMsgId: d.quote?.globalMsgId != null ? String(d.quote.globalMsgId) : undefined,
    mentions: d.mentions?.map((m) => ({ uid: String(m.uid), pos: m.pos, len: m.len })),
  };
}
