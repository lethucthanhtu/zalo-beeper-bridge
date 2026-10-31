// Normalized Zalo event model — the only shapes the bridge layer sees.
// Derived from live fixtures captured in Phase 1 (plans/.../reports/phase-01-spike-findings.md).
import type { LinkPreview, MediaDescriptor } from '../bridge/media-content.ts';

export type ZaloThreadType = 'user' | 'group';

export type ZaloContent =
  | { kind: 'text'; text: string; linkPreview?: LinkPreview }
  /** system-style line posted as m.notice (e.g. a call log bubble) */
  | { kind: 'notice'; text: string }
  | { kind: 'photo'; url: string; thumbUrl?: string; width?: number; height?: number; caption?: string }
  /** shared location → m.location; `text` is the fallback body (label, address, maps link) */
  | { kind: 'location'; latitude: number; longitude: number; label: string; text: string }
  | { kind: 'sticker'; id: number; catId: number }
  /** video / file / voice / GIF / doodle — rendered by bridge/media-content.ts */
  | { kind: 'media'; media: MediaDescriptor }
  /** the account deleted these messages "for me" on another device (chat.delete) */
  | { kind: 'delete'; msgIds: string[] }
  | { kind: 'unsupported'; msgType: string };

export type ZaloMessage = {
  msgId: string;
  threadId: string;
  threadType: ZaloThreadType;
  /** uidFrom — universal puppet key (equals the sender's DM threadId) */
  senderId: string;
  senderName?: string;
  /** epoch millis */
  timestamp: number;
  /** true when sent by the bridged account itself (any device) — zca-js selfListen */
  isSelf: boolean;
  content: ZaloContent;
  /** client message id — needed by Zalo reaction/undo APIs */
  cliMsgId?: string;
  /** raw Zalo msgType (e.g. webchat, chat.photo) — needed to build seen events */
  rawMsgType?: string;
  /** Raw fields needed to quote this message later (Matrix reply → Zalo quote) */
  quotable?: ZaloQuotePayload;
  /** msgId of the message this one replies to (Zalo quote → Matrix reply) */
  replyToMsgId?: string;
  /** @mentions in a group message (uid + position/length in the text) */
  mentions?: ZaloMention[];
};

export type ZaloMention = {
  uid: string;
  pos: number;
  len: number;
};

/** A contact's display name and avatar URL (Zalo CDN), as far as Zalo returns them. */
export type ZaloProfile = { displayName?: string; avatarUrl?: string };

/** A contact reacted to a message. */
export type ZaloReactionEvent = {
  threadId: string;
  threadType: ZaloThreadType;
  senderId: string;
  senderName?: string;
  /** true when the reaction is the account's own (echoed back by selfListen) */
  isSelf: boolean;
  /** the message being reacted to */
  targetMsgId: string;
  /** Zalo reaction icon code ("/-heart", ":>", ... ; "" = removed) */
  icon: string;
};

/** Subset of TMessage that zca-js sendMessage accepts as `quote`. */
export type ZaloQuotePayload = {
  content: unknown; // string for text, object for media
  msgType: string;
  propertyExt: unknown;
  uidFrom: string;
  msgId: string;
  cliMsgId: string;
  ts: string;
  ttl: number;
};

/** Read-receipt event: someone saw messages in a thread. */
export type ZaloSeenEvent = {
  threadId: string;
  threadType: ZaloThreadType;
  msgId: string;
  /** group only: uids that saw the message; empty for DMs (the peer saw it) */
  seenUids: string[];
};

/** Typing indicator from a contact. */
export type ZaloTypingEvent = {
  threadId: string;
  threadType: ZaloThreadType;
  uid: string;
};

/** Raw zca-js listener "message" event shape (subset we rely on). */
export type RawZaloMessage = {
  type: number; // 0=User, 1=Group (zca-js ThreadType)
  threadId: string;
  isSelf: boolean;
  data: {
    msgId: string;
    msgType: string;
    uidFrom: string;
    dName?: string;
    ts: string | number;
    content: unknown;
    cliMsgId?: string;
    propertyExt?: unknown;
    ttl?: number;
    quote?: { globalMsgId?: string | number };
    mentions?: Array<{ uid: string; pos: number; len: number }>;
    /** present on end-to-end-encrypted 1-1 pushes (ws cmd 551): content is Signal ciphertext */
    e2ee?: unknown;
  };
};
