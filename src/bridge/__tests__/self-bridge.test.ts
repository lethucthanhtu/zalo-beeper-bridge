import type { WeakEvent } from 'matrix-appservice-bridge';
import { describe, expect, it } from 'vitest';
import { isOwnEcho, rememberBridgedEvent, SELF_BRIDGE_MARKER, type BridgedEvents } from '../self-bridge.ts';

const OWNER = '@owner:beeper.com';
const event = (fields: Partial<WeakEvent> = {}): WeakEvent =>
  ({ type: 'm.room.message', sender: OWNER, event_id: '$e1', content: { body: 'hi' }, ...fields }) as WeakEvent;

describe('isOwnEcho', () => {
  it('lets a fresh owner event through and claims its id', () => {
    const bridged: BridgedEvents = new Set();
    expect(isOwnEcho(event(), OWNER, bridged, true)).toBe(false);
    expect(bridged.has('$e1')).toBe(true);
    // the redelivered transaction is now skipped
    expect(isOwnEcho(event(), OWNER, bridged, true)).toBe(true);
  });

  it('does not claim when asked not to', () => {
    const bridged: BridgedEvents = new Set();
    expect(isOwnEcho(event(), OWNER, bridged, false)).toBe(false);
    expect(bridged.size).toBe(0);
  });

  it('skips events the bridge posted as the owner (marker or remembered id)', () => {
    expect(isOwnEcho(event({ content: { [SELF_BRIDGE_MARKER]: true } }), OWNER, new Set(), true)).toBe(true);
    expect(isOwnEcho(event(), OWNER, new Set(['$e1']), false)).toBe(true);
  });

  it('skips other senders without remembering them', () => {
    const bridged: BridgedEvents = new Set();
    expect(isOwnEcho(event({ sender: '@sh-zalo_1:beeper.com' }), OWNER, bridged, true)).toBe(true);
    expect(bridged.size).toBe(0);
  });

  it('passes an owner event without an id (nothing to claim)', () => {
    expect(isOwnEcho(event({ event_id: undefined }), OWNER, new Set(), true)).toBe(false);
  });
});

describe('rememberBridgedEvent', () => {
  it('drops the oldest ids once the set outgrows 5000', () => {
    const bridged: BridgedEvents = new Set();
    for (let i = 0; i <= 5000; i++) rememberBridgedEvent(bridged, `$${i}`);
    expect(bridged.size).toBe(4000);
    expect(bridged.has('$0')).toBe(false);
    expect(bridged.has('$5000')).toBe(true);
  });
});
