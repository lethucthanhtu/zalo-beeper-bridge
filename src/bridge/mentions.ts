// Bridges @mentions both directions between Zalo (uid + pos/len in text) and
// Matrix (m.mentions.user_ids + an org.matrix.custom.html formatted_body of pills).
import type { ZaloMention } from '../zalo/types.ts';

/** Escapes `& < > "` for safe use in HTML text and double-quoted attributes. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Matrix-side rendering of a Zalo message's mentions. */
export type InboundMentionResult = {
  formattedBody: string;
  userIds: string[];
};

/**
 * Zalo → Matrix: turn Zalo mentions into a formatted_body with matrix.to pills
 * and the list of mentioned MXIDs. resolveMxid maps a Zalo uid to a Matrix id
 * (owner for the account itself, else the contact's ghost).
 * Out-of-range and overlapping mentions are dropped; all other text is HTML-escaped.
 *
 * @returns The HTML body and the de-duplicated mentioned MXIDs (in text order).
 */
export function buildInboundMentions(
  text: string,
  mentions: ZaloMention[],
  resolveMxid: (uid: string) => string,
): InboundMentionResult {
  const userIds = new Set<string>();
  const validMentions = mentions
    .filter((mention) => mention.pos >= 0 && mention.len > 0 && mention.pos + mention.len <= text.length)
    .sort((a, b) => a.pos - b.pos);
  let html = '';
  let cursor = 0;
  for (const mention of validMentions) {
    if (mention.pos < cursor) continue; // overlapping — skip
    const mxid = resolveMxid(mention.uid);
    userIds.add(mxid);
    html += escapeHtml(text.slice(cursor, mention.pos));
    const label = escapeHtml(text.slice(mention.pos, mention.pos + mention.len));
    // Raw MXID in the matrix.to link — clients only detect pills in this literal
    // form; percent-encoding (%40/%3A) makes them render as a plain link instead.
    html += `<a href="https://matrix.to/#/${mxid}">${label}</a>`;
    cursor = mention.pos + mention.len;
  }
  html += escapeHtml(text.slice(cursor));
  return { formattedBody: html, userIds: [...userIds] };
}

/**
 * Matrix → Zalo mentions from `m.mentions.user_ids` (Beeper sends these WITHOUT a
 * formatted_body pill). resolve maps an MXID to {uid, name}; we locate "@name" in
 * the plain body to get pos/len. Used as the primary path since Beeper omits pills.
 *
 * @returns One mention per resolvable MXID whose "@name" occurs in `body` (first occurrence);
 *   unresolvable or unlocatable MXIDs are skipped.
 */
export function mentionsFromUserIds(
  body: string,
  userIds: string[],
  resolve: (mxid: string) => { uid: string; name: string } | null,
): ZaloMention[] {
  const zaloMentions: ZaloMention[] = [];
  for (const mxid of userIds) {
    const resolved = resolve(mxid);
    if (!resolved?.name) continue;
    const label = `@${resolved.name}`;
    const pos = body.indexOf(label);
    if (pos === -1) continue;
    zaloMentions.push({ uid: resolved.uid, pos, len: label.length });
  }
  return zaloMentions;
}

/**
 * Matrix → Zalo: parse a formatted_body's matrix.to pills into Zalo mentions.
 * resolveUid maps an MXID back to a Zalo uid (null if not a bridge user).
 * pos/len are located in the plain-text `body`.
 *
 * @returns Mentions in pill order; pills for non-bridge users or whose label is not found in
 *   `body` are skipped. Repeated labels map to successive occurrences. `[]` without a formatted body.
 * @throws URIError when a pill href contains malformed percent-encoding.
 */
export function parseOutboundMentions(
  body: string,
  formattedBody: string | undefined,
  resolveUid: (mxid: string) => string | null,
): ZaloMention[] {
  if (!formattedBody) return [];
  const zaloMentions: ZaloMention[] = [];
  // Tolerant: href may sit among other attributes; the label may contain markup.
  const pillAnchorPattern = /<a\b[^>]*\bhref="https:\/\/matrix\.to\/#\/([^"]+)"[^>]*>(.*?)<\/a>/gi;
  const searchStartByLabel = new Map<string, number>(); // label → search start (handle repeats)
  let match: RegExpExecArray | null;
  while ((match = pillAnchorPattern.exec(formattedBody)) !== null) {
    const mxid = decodeURIComponent(match[1]!);
    const label = match[2]!
      .replace(/<[^>]+>/g, '') // strip any nested tags in the pill label
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
    const uid = resolveUid(mxid);
    if (!uid) continue;
    const searchFrom = searchStartByLabel.get(label) ?? 0;
    const pos = body.indexOf(label, searchFrom);
    if (pos === -1) continue;
    searchStartByLabel.set(label, pos + label.length);
    zaloMentions.push({ uid, pos, len: label.length });
  }
  return zaloMentions;
}
