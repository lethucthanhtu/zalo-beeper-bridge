// Zalo call log bubbles (link-card messages with action `recommened.calltime` /
// `recommened.misscall`). Their title is the literal "sendBubbleMessage" and they carry
// no href, so they need their own rendering — shared by the live bridge and the importer.

/** Card actions Zalo uses for call log bubbles (Zalo's own spelling of "recommended"). */
export const CALL_ACTIONS = new Set(['recommened.calltime', 'recommened.misscall']);

/** Call details Zalo stores in the card's `params` JSON. */
type CallParams = {
  /** call length in seconds (0 for a missed call) */
  duration?: number;
  /** 1 when the account owner placed the call */
  isCaller?: number;
  /** 1 = video call, 0 = voice call */
  calltype?: number;
};

/**
 * Beeper's `com.beeper.action_message` content field (mautrix-go `event.BeeperActionMessage`).
 * Beeper clients render an m.text event that carries it as a call tile instead of a text
 * bubble; clients that don't know it just show the body.
 */
export type BeeperActionMessage = { type: 'call'; call_type: 'voice' | 'video' };

/** Parses the card `params` (JSON string or object); malformed params yield {}. */
function parseCallParams(params: unknown): CallParams {
  try {
    return ((typeof params === 'string' ? JSON.parse(params) : params) ?? {}) as CallParams;
  } catch {
    return {};
  }
}

/** The `com.beeper.action_message` payload for a Zalo call bubble (voice unless calltype is 1). */
export function callActionMessage(params: unknown): BeeperActionMessage {
  return { type: 'call', call_type: Number(parseCallParams(params).calltype) === 1 ? 'video' : 'voice' };
}

/** Seconds → "m:ss" (or "h:mm:ss" for calls of an hour or more). */
function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds).padStart(2, '0')}`;
  return hours ? `${hours}:${mmss}` : mmss;
}

/**
 * Readable one-line text for a Zalo call bubble, e.g. "📞 Cuộc gọi đến · 0:26",
 * "📹 Cuộc gọi video đi · 1:05" or "📞 Cuộc gọi nhỡ".
 *
 * @param action the card action (`recommened.calltime` or `recommened.misscall`)
 * @param params the card's `params` (JSON string or already-parsed object); unparsable
 *   or missing params still yield a generic call line
 * @param options.icon prefix the 📞/📹 emoji (default true); off for call action messages,
 *   where Beeper draws its own call icon
 */
export function describeCall(action: string, params: unknown, options: { icon?: boolean } = {}): string {
  const call = parseCallParams(params);
  const isVideo = Number(call.calltype) === 1;
  const icon = options.icon === false ? '' : isVideo ? '📹 ' : '📞 ';
  const kind = isVideo ? 'Cuộc gọi video' : 'Cuộc gọi';
  const outgoing = Number(call.isCaller) === 1;
  if (action === 'recommened.misscall') {
    return outgoing ? `${icon}${kind} đi không được trả lời` : `${icon}${kind} nhỡ`;
  }
  const seconds = Number(call.duration);
  const length = Number.isFinite(seconds) && seconds > 0 ? ` · ${formatDuration(seconds)}` : '';
  return `${icon}${kind} ${outgoing ? 'đi' : 'đến'}${length}`;
}
