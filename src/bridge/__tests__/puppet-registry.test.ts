// Ghost MXIDs follow the bridge name from registration.yaml, so a second bridge
// (`bbctl register sh-zalo2`) gets its own namespace.
import { describe, expect, it } from 'vitest';
import type { Bridge } from 'matrix-appservice-bridge';
import type { MappingStore } from '../mapping-store.ts';
import { assertGhostNamespace, bridgeIdFor, PuppetRegistry } from '../puppet-registry.ts';

const registry = (prefix?: string) =>
  new PuppetRegistry({} as Bridge, {} as MappingStore, 'beeper.local', undefined, prefix);

describe('ghost namespace', () => {
  it('derives the bridge name from the bot localpart', () => {
    expect(bridgeIdFor('sh-zalobot')).toBe('sh-zalo');
    expect(bridgeIdFor('sh-zalo2bot')).toBe('sh-zalo2');
    expect(bridgeIdFor(undefined)).toBe('sh-zalo');
  });

  it('keeps the existing sh-zalo_ ghosts by default', () => {
    expect(registry().mxidFor('123')).toBe('@sh-zalo_123:beeper.local');
  });

  it('maps ghost MXIDs both ways and ignores other bridges', () => {
    const second = registry('sh-zalo2_');
    expect(second.mxidFor('123')).toBe('@sh-zalo2_123:beeper.local');
    expect(second.uidFor('@sh-zalo2_123:beeper.local')).toBe('123');
    expect(second.uidFor('@sh-zalo_123:beeper.local')).toBeNull();
    expect(registry().uidFor('@sh-zalo2_123:beeper.local')).toBeNull();
    expect(registry().uidFor('@owner:beeper.com')).toBeNull();
    expect(registry().uidFor('@sh-zalo_:beeper.local')).toBeNull();
    // the namespace bbctl registers for the second bridge accepts its ghosts only
    expect(() => assertGhostNamespace('@sh-zalo2_.+:beeper\.local', second.mxidFor('1'))).not.toThrow();
    expect(() => assertGhostNamespace('@sh-zalo_.+:beeper\.local', second.mxidFor('1'))).toThrow();
  });
});
