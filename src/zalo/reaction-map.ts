// Maps between Matrix reaction emoji (unicode) and Zalo reaction icon codes.
// Zalo has a fixed palette; unmapped emoji fall back to the closest / HEART.
import type { Reactions as ZcaReactions } from 'zca-js';

// zca-js's `Reactions` enum codes, copied as plain strings so this mapping (used by bridge/)
// loads without zca-js at runtime; `satisfies` makes tsc reject a code zca-js doesn't know.
const Reactions = {
  NONE: '',
  HEART: '/-heart',
  LIKE: '/-strong',
  HAHA: ':>',
  TEARS_OF_JOY: ":')",
  WOW: ':o',
  CRY: ':-((',
  ANGRY: ':-h',
  KISS: ':-*',
  ROSE: '/-rose',
  BROKEN_HEART: '/-break',
  DISLIKE: '/-weak',
} as const satisfies Record<string, `${ZcaReactions}`>;

/** Zalo icon code that removes all of the account's reactions on a message. */
export const REACTION_NONE = Reactions.NONE;

// Unicode emoji → Zalo icon code
const EMOJI_TO_ZALO: Record<string, string> = {
  '❤️': Reactions.HEART,
  '❤': Reactions.HEART,
  '👍': Reactions.LIKE,
  '😆': Reactions.HAHA,
  '😂': Reactions.TEARS_OF_JOY,
  '😮': Reactions.WOW,
  '😢': Reactions.CRY,
  '😠': Reactions.ANGRY,
  '😡': Reactions.ANGRY,
  '😘': Reactions.KISS,
  '🌹': Reactions.ROSE,
  '💔': Reactions.BROKEN_HEART,
  '👎': Reactions.DISLIKE,
};

// Zalo icon code → unicode emoji (for inbound rendering)
const ZALO_TO_EMOJI: Record<string, string> = {
  [Reactions.HEART]: '❤️',
  [Reactions.LIKE]: '👍',
  [Reactions.HAHA]: '😆',
  [Reactions.TEARS_OF_JOY]: '😂',
  [Reactions.WOW]: '😮',
  [Reactions.CRY]: '😢',
  [Reactions.ANGRY]: '😠',
  [Reactions.KISS]: '😘',
  [Reactions.ROSE]: '🌹',
  [Reactions.BROKEN_HEART]: '💔',
  [Reactions.DISLIKE]: '👎',
};

// Zalo PC's local Reaction DB stores reactions as numeric rTypes, not icon codes. Verified
// against bridged reactions (2026-11-21) for 0/2/3/5/7/20/32; the rest follow zca-js's
// ReactionType numbering.
const RTYPE_TO_ZALO: Record<string, string> = {
  '0': Reactions.HAHA,
  '2': Reactions.CRY,
  '3': Reactions.LIKE,
  '4': Reactions.DISLIKE,
  '5': Reactions.HEART,
  '7': Reactions.TEARS_OF_JOY,
  '8': Reactions.KISS,
  '20': Reactions.ANGRY,
  '32': Reactions.WOW,
  '65': Reactions.BROKEN_HEART,
  '120': Reactions.ROSE,
};

/**
 * History import: Zalo PC reaction type number → Zalo reaction icon code.
 * Unknown types become HEART so the reaction is never lost.
 *
 * @param rType - Numeric reaction type from Zalo PC's Reaction DB (number or its string form).
 * @returns The zca icon code, usable with {@link zaloToEmoji}.
 */
export function zaloRTypeToIcon(rType: string | number): string {
  return RTYPE_TO_ZALO[String(rType)] ?? Reactions.HEART;
}

/**
 * Outbound (Beeper→Zalo): Matrix reaction emoji → Zalo reaction icon code.
 * Zalo only accepts its fixed palette, so unmapped emoji become HEART.
 */
export function emojiToZalo(emoji: string): string {
  return EMOJI_TO_ZALO[emoji] ?? Reactions.HEART;
}

/**
 * Inbound (Zalo→Beeper): Zalo reaction icon code → unicode emoji for the Matrix reaction.
 * Unknown codes render as ❤️ so the reaction is never lost.
 */
export function zaloToEmoji(icon: string): string {
  return ZALO_TO_EMOJI[icon] ?? '❤️';
}
