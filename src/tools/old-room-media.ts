// Media of a message as the old room holds it. When a rebuild can no longer reach a message's
// media (no backup copy, Zalo CDN link expired), the old room's event still points at the
// bytes the bridge uploaded when the message was first bridged: the importer downloads them
// from there instead of posting the message as text. Pure: the importer fetches the events.

/** A Matrix event, as far as its kind and media matter. */
type EventShape = { type: string; content: Record<string, unknown> };

/** Where an old event's media lives: `file` is set when it was uploaded encrypted. */
type MediaRef = { mxc: string; file?: unknown; mimetype?: string; width?: number; height?: number };

const MEDIA_KINDS = new Set(['m.image', 'm.video', 'm.audio', 'm.file', 'm.sticker']);

/** The kind of a message event: its msgtype, `m.sticker` for stickers, `unknown` otherwise. */
export function messageKind(event: EventShape): string {
  if (event.type === 'm.sticker') return 'm.sticker';
  const msgtype = event.content.msgtype;
  return typeof msgtype === 'string' ? msgtype : 'unknown';
}

/** Whether a message kind carries media (image, video, audio, file or sticker). */
export const isMediaKind = (kind: string): boolean => MEDIA_KINDS.has(kind);

/** Media kind of a rebuilt message, as the importer's media descriptor names it. */
export type RebuiltMediaKind = 'image' | 'video' | 'audio' | 'file' | 'sticker';

/**
 * The descriptor kind for a Matrix message kind (`m.image` → `image`, ...), or null when the
 * kind carries no media. Used when the export records a message as a link but the old room
 * holds it as media, so the rebuilt event must take its kind from the old event.
 */
export function mediaKindOf(kind: string): RebuiltMediaKind | null {
  return isMediaKind(kind) ? (kind.slice(2) as RebuiltMediaKind) : null;
}

/**
 * The media reference of a media event, or null for anything else (text, or media without
 * a url: nothing to download).
 */
export function mediaRef(event: EventShape): MediaRef | null {
  if (!isMediaKind(messageKind(event))) return null;
  const { url, file, info } = event.content as {
    url?: unknown;
    file?: { url?: unknown };
    info?: { mimetype?: unknown; w?: unknown; h?: unknown };
  };
  const mxc = typeof url === 'string' ? url : typeof file?.url === 'string' ? file.url : undefined;
  if (!mxc) return null;
  return {
    mxc,
    ...(file && typeof url !== 'string' ? { file } : {}),
    ...(typeof info?.mimetype === 'string' ? { mimetype: info.mimetype } : {}),
    ...(typeof info?.w === 'number' ? { width: info.w } : {}),
    ...(typeof info?.h === 'number' ? { height: info.h } : {}),
  };
}
