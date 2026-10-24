// Maps between Matrix reaction emoji (unicode) and Zalo reaction icon codes.
// Zalo has a fixed palette; unmapped emoji fall back to the closest / HEART.
import { Reactions } from 'zca-js';

// Unicode emoji → Zalo icon code
const EMOJI_TO_ZALO: Record<string, Reactions> = {
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

/**
 * Outbound (Beeper→Zalo): Matrix reaction emoji → Zalo reaction icon code.
 * Zalo only accepts its fixed palette, so unmapped emoji become HEART.
 */
export function emojiToZalo(emoji: string): Reactions {
  return EMOJI_TO_ZALO[emoji] ?? Reactions.HEART;
}

/**
 * Inbound (Zalo→Beeper): Zalo reaction icon code → unicode emoji for the Matrix reaction.
 * Unknown codes render as ❤️ so the reaction is never lost.
 */
export function zaloToEmoji(icon: string): string {
  return ZALO_TO_EMOJI[icon] ?? '❤️';
}
