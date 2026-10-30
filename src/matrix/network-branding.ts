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
import { bridgeIdFor } from '../bridge/puppet-registry.ts';
import type { ZaloThreadType } from '../zalo/types.ts';

/** How the bridge presents itself in Beeper: config `network` section + the computed state key. */
export type NetworkBranding = {
  name: string;
  logoPath: string;
  /** stable network id (protocol.id / com.beeper.bridge.network), e.g. "zalo" */
  networkId: string;
  /** `<homeserver_domain>/<registration id>` — the bridge-info state_key */
  stateKey: string;
};

/**
 * Branding for this bridge: the config's `network` section plus the bridge-info state
 * key `<domain>/<registration id>` (as mautrix bridgev2 computes it); without a
 * registration id, `<domain>/<bridge name>`.
 */
export function bridgeBranding(
  config: { matrix: { domain: string }; network: { name: string; logoPath: string; networkId: string } },
  registration: { id?: string | null; sender_localpart?: string | null },
): NetworkBranding {
  const bridgeId = registration.id || bridgeIdFor(registration.sender_localpart ?? undefined);
  return { ...config.network, stateKey: `${config.matrix.domain}/${bridgeId}` };
}

/** Bridge-info state event types Beeper reads (current + legacy half-shot name). */
const BRIDGE_EVENT_TYPES = ['m.bridge', 'uk.half-shot.bridge'];

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
    // bot-sdk 0.10 types omit PATCH, but its undici transport sends any method
    .doRequest('PATCH' as 'PUT', `/_matrix/client/v3/profile/${encodeURIComponent(botMxid)}`, null, profile)
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
 * @param receiver - Zalo uid of the account the portal belongs to (`channel.fi.mau.receiver`,
 *   as mautrix bridgev2 sets it, so Beeper can tell logins apart); omitted when unknown.
 */
export async function tagPortalNetwork(
  intent: Intent,
  roomId: string,
  channelId: string,
  channelName: string,
  threadType: ZaloThreadType,
  branding: NetworkBranding,
  botMxid: string,
  receiver?: string | null,
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
    channel: { id: channelId, displayname: channelName, ...(receiver ? { 'fi.mau.receiver': receiver } : {}) },
    'com.beeper.room_type.v2': threadType === 'group' ? 'group_dm' : 'dm',
  };
  for (const eventType of BRIDGE_EVENT_TYPES) {
    await intent
      .sendStateEvent(roomId, eventType, branding.stateKey, content)
      .catch((err: Error) => console.warn(`${eventType} state failed for ${roomId}:`, err.message));
  }
}
