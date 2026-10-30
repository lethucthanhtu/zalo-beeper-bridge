import { describe, expect, it } from 'vitest';
import { bridgeBranding } from '../network-branding.ts';

const config = {
  matrix: { domain: 'beeper.local' },
  network: { name: 'Zalo', logoPath: 'assets/zalo-logo.png', networkId: 'zalo' },
};

describe('bridgeBranding', () => {
  it('keys bridge-info by the registration id, like mautrix bridgev2', () => {
    const branding = bridgeBranding(config, {
      id: '00000000-0000-4000-8000-000000000000',
      sender_localpart: 'sh-zalobot',
    });
    expect(branding.stateKey).toBe('beeper.local/00000000-0000-4000-8000-000000000000');
    expect(branding.name).toBe('Zalo');
  });

  it('falls back to the bridge name when the registration has no id', () => {
    expect(bridgeBranding(config, { sender_localpart: 'sh-zalobot' }).stateKey).toBe('beeper.local/sh-zalo');
  });
});
