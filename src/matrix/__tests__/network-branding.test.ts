import { describe, expect, it } from 'vitest';
import { bridgeBranding } from '../network-branding.ts';

const config = {
  matrix: { domain: 'beeper.local' },
  network: { name: 'Zalo', logoPath: 'assets/zalo-logo.png', networkId: 'zalo' },
};

describe('bridgeBranding', () => {
  it('keys bridge-info by the registration id, like mautrix bridgev2, and marks the old key legacy', () => {
    const branding = bridgeBranding(config, { id: '862af65b-7daa', sender_localpart: 'sh-zalobot' });
    expect(branding.stateKey).toBe('beeper.local/862af65b-7daa');
    expect(branding.legacyStateKeys).toEqual(['beeper.local/sh-zalo']);
    expect(branding.name).toBe('Zalo');
  });

  it('falls back to the bridge name when the registration has no id', () => {
    expect(bridgeBranding(config, { sender_localpart: 'sh-zalobot' }).stateKey).toBe('beeper.local/sh-zalo');
  });
});
