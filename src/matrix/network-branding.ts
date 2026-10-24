// Makes the bridge present as a native network in Beeper (name + logo), matching
// what official mautrix bridgev2 bridges emit:
//  - bot profile: displayname + avatar + com.beeper.bridge.{service,network,is_bridge_bot}
//  - per portal: BOTH `m.bridge` and `uk.half-shot.bridge` state events, keyed by
//    `<domain>/<appservice-id>` — the load-bearing bit. The appservice id is the
//    registration's `id` (a UUID for bbctl-registered bridges, the same UUID hungryserv
//    writes as protocol.id in its own "" bridge event), exactly like mautrix bridgev2's
//    GetUniqueBridgeID — NOT the sender_localpart-derived "sh-zalo".
// (Field precedence is inferred from mautrix-go; Beeper's client is closed-source.)
import fs from 'node:fs';
import type { Bridge, Intent } from 'matrix-appservice-bridge';
import type { ZaloThreadType } from '../zalo/types.ts';

/** How the bridge presents itself in Beeper: config `network` section + the computed state key. */
export type NetworkBranding = {
  name: string;
  logoPath: string;
  /** stable network id (protocol.id / com.beeper.bridge.network), e.g. "zalo" */
  networkId: string;
  /** `<homeserver_domain>/<registration id>` — the bridge-info state_key */
  stateKey: string;
  /** state keys used by earlier versions (e.g. `beeper.local/sh-zalo`); their events are cleared */
  legacyStateKeys?: string[];
};

/**
 * Branding for this bridge: the config's `network` section plus the bridge-info state
 * key `<domain>/<registration id>` (as mautrix bridgev2 computes it). The old
 * `<domain>/<sender_localpart minus "bot">` key is listed as legacy so its events get
 * cleared. Without a registration id the legacy key stays the state key.
 */
export function bridgeBranding(
  config: { matrix: { domain: string }; network: { name: string; logoPath: string; networkId: string } },
  registration: { id?: string; sender_localpart?: string },
): NetworkBranding {
  const legacyKey = `${config.matrix.domain}/${(registration.sender_localpart ?? 'sh-zalobot').replace(/bot$/, '')}`;
  const stateKey = registration.id ? `${config.matrix.domain}/${registration.id}` : legacyKey;
  return { ...config.network, stateKey, legacyStateKeys: [legacyKey] };
}

/** Bridge-info state event types Beeper reads (current + legacy half-shot name). */
const BRIDGE_EVENT_TYPES = ['m.bridge', 'uk.half-shot.bridge'];

/**
 * Empties bridge-info events left under an outdated state key, so a room carries one
 * consistent bridge description. Only rooms that still have such an event get a write.
 * Best-effort: failures are logged.
 */
async function clearLegacyBridgeInfo(intent: Intent, roomId: string, legacyStateKeys: string[]): Promise<void> {
  for (const stateKey of legacyStateKeys) {
    for (const eventType of BRIDGE_EVENT_TYPES) {
      const existing = (await intent.matrixClient
        .getRoomStateEvent(roomId, eventType, stateKey)
        .catch(() => null)) as Record<string, unknown> | null;
      if (!existing || Object.keys(existing).length === 0) continue;
      await intent
        .sendStateEvent(roomId, eventType, stateKey, {})
        .catch((err: Error) => console.warn(`clearing legacy ${eventType} failed for ${roomId}:`, err.message));
    }
  }
}

/** mxc:// URL of the uploaded network logo; uploaded once per process. */
let cachedLogoMxc: string | null = null;

/**
 * Returns the network logo as an mxc:// URL, uploading the PNG at `logoPath` on first use
 * and caching the result for the rest of the process.
 *
 * @param intent - Intent used for the upload (any bridge intent works).
 * @param logoPath - Local path of the logo PNG.
 * @returns The mxc URL, or `null` when the logo file does not exist.
 * @throws When the upload fails.
 */
async function getLogoMxc(intent: Intent, logoPath: string): Promise<string | null> {
  if (cachedLogoMxc) return cachedLogoMxc;
  if (!fs.existsSync(logoPath)) return null;
  cachedLogoMxc = await intent.uploadContent(fs.readFileSync(logoPath), {
    type: 'image/png',
    name: 'network-logo.png',
  });
  return cachedLogoMxc;
}

/**
 * One-time bot profile: displayname + avatar + Beeper bridge-network markers.
 * Profile updates are best-effort (failures are logged as warnings); only the logo upload can throw.
 *
 * @param bridge - The running bridge; its bot intent is updated.
 * @param branding - Network name, logo and id.
 */
export async function ensureNetworkIdentity(bridge: Bridge, branding: NetworkBranding): Promise<void> {
  const intent = bridge.getIntent();
  const botMxid = intent.userId;
  const logoMxc = await getLogoMxc(intent, branding.logoPath);
  await intent
    .setDisplayName(branding.name)
    .catch((err: Error) => console.warn('bot setDisplayName failed:', err.message));
  if (logoMxc)
    await intent.setAvatarUrl(logoMxc).catch((err: Error) => console.warn('bot setAvatarUrl failed:', err.message));
  // PATCH the profile with com.beeper.bridge.* so Beeper maps the bot to a network
  const profile: Record<string, unknown> = {
    displayname: branding.name,
    'com.beeper.bridge.service': branding.networkId,
    'com.beeper.bridge.network': branding.networkId,
    'com.beeper.bridge.is_bridge_bot': true,
  };
  if (logoMxc) profile.avatar_url = logoMxc;
  await intent.matrixClient
    .doRequest('PATCH', `/_matrix/client/v3/profile/${encodeURIComponent(botMxid)}`, null, profile)
    .catch((err: Error) => console.warn('bot profile PATCH failed:', err.message));
}

/**
 * Emit both bridge-info state events so Beeper renders the portal under this
 * network. `intent` MUST be a room member with power (ghost for DMs, bot for groups).
 * State sends are best-effort (failures logged); only the logo upload can throw.
 *
 * @param intent - Room member with power to send state.
 * @param roomId - Portal room.
 * @param channelId - Zalo thread id (`channel.id`).
 * @param channelName - Display name of the conversation (`channel.displayname`).
 * @param threadType - `group` → Beeper room type `group_dm`, otherwise `dm`.
 * @param branding - Network name/logo/id and the state key.
 * @param botMxid - Bridge bot MXID (`bridgebot`).
 */
export async function tagPortalNetwork(
  intent: Intent,
  roomId: string,
  channelId: string,
  channelName: string,
  threadType: ZaloThreadType,
  branding: NetworkBranding,
  botMxid: string,
): Promise<void> {
  const logoMxc = await getLogoMxc(intent, branding.logoPath);
  const content = {
    bridgebot: botMxid,
    creator: intent.userId,
    protocol: {
      id: branding.networkId,
      displayname: branding.name,
      ...(logoMxc ? { avatar_url: logoMxc } : {}),
      external_url: 'https://zalo.me',
    },
    channel: { id: channelId, displayname: channelName },
    'com.beeper.room_type.v2': threadType === 'group' ? 'group_dm' : 'dm',
  };
  for (const eventType of BRIDGE_EVENT_TYPES) {
    await intent
      .sendStateEvent(roomId, eventType, branding.stateKey, content)
      .catch((err: Error) => console.warn(`${eventType} state failed for ${roomId}:`, err.message));
  }
  const legacyKeys = (branding.legacyStateKeys ?? []).filter((key) => key !== branding.stateKey);
  if (legacyKeys.length) await clearLegacyBridgeInfo(intent, roomId, legacyKeys);
}
