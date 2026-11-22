// Loop guard between the two bridge directions. Inbound posts the owner's own Zalo
// messages into Beeper as the owner; the homeserver hands those events back to the
// appservice, and outbound must never send them to Zalo again. Two signals cover it:
// a marker in the content (deterministic) and an in-memory set of event_ids.
import type { WeakEvent } from 'matrix-appservice-bridge';

/**
 * Content marker on messages the bridge double-puppets as the owner (mirroring
 * the owner's own Zalo-app messages into Beeper). The homeserver echoes these
 * events back to the appservice, and the echo can beat the send-response's
 * event_id — so id-based guards race. The marker travels IN the content, so
 * OutboundHandler can drop it deterministically and never loop it back to Zalo.
 */
export const SELF_BRIDGE_MARKER = 'com.zalo-bridge.self';

/**
 * event_ids the bridge posted as the owner plus Matrix events already sent to Zalo. One
 * set is shared by the inbound, outbound and presence handlers (created in index.ts).
 * It is in memory and synchronous, so it wins the races a DB lookup can lose.
 */
export type BridgedEvents = Set<string>;

const BRIDGED_EVENTS_MAX = 5000;
const BRIDGED_EVENTS_KEEP = 4000;

/**
 * Adds an event_id to the shared set, dropping the oldest entries once it outgrows
 * 5000 (insertion order) so a long-running bridge doesn't grow it without bound.
 */
export function rememberBridgedEvent(bridged: BridgedEvents, eventId: string): void {
  bridged.add(eventId);
  if (bridged.size <= BRIDGED_EVENTS_MAX) return;
  for (const id of bridged) {
    bridged.delete(id);
    if (bridged.size <= BRIDGED_EVENTS_KEEP) break;
  }
}

/**
 * True when outbound must not send `event` to Zalo: the bridge posted it (marker or a
 * remembered event_id), someone other than the owner sent it, or it was already handled.
 * With `claim`, a fresh event_id is remembered right away, so a transaction redelivered
 * while the first send is still running is skipped too.
 */
export function isOwnEcho(event: WeakEvent, ownerUserId: string, bridged: BridgedEvents, claim: boolean): boolean {
  if ((event.content as Record<string, unknown> | undefined)?.[SELF_BRIDGE_MARKER]) return true;
  if (event.sender !== ownerUserId) return true;
  if (!event.event_id) return false;
  if (bridged.has(event.event_id)) return true;
  if (claim) rememberBridgedEvent(bridged, event.event_id);
  return false;
}
