// Entrypoint: load config → start Zalo client + appservice → route events.
// Top-level module (top-level await): everything below runs once at process start.
// Startup throws (missing config / as_token / user namespace, ghost namespace mismatch)
// are deliberate fail-fast exits.
import fs from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { loadConfig } from './config.ts';
import { EchoSuppressor } from './bridge/echo-suppressor.ts';
import { InboundHandler } from './bridge/inbound-handler.ts';
import { MappingStore } from './bridge/mapping-store.ts';
import { OutboundHandler } from './bridge/outbound-handler.ts';
import { PortalManager } from './bridge/portal-manager.ts';
import { PresenceHandler } from './bridge/presence-handler.ts';
import { assertGhostNamespace, bridgeIdFor, PuppetRegistry } from './bridge/puppet-registry.ts';
import { SyncManager } from './bridge/sync-manager.ts';
import { createBridge, startBridge } from './matrix/appservice.ts';
import { AVATAR_MAX_BYTES, createZaloStatePublisher } from './matrix/beeper-bridge-state.ts';
import { fetchMediaCapped } from './bridge/media-handler.ts';
import { handleBotEvent, type BotCommandContext } from './matrix/bot-commands.ts';
import { bridgeBranding, ensureNetworkIdentity } from './matrix/network-branding.ts';
import { ZaloClient } from './zalo/zalo-client.ts';

const config = loadConfig();

const zalo = new ZaloClient({
  credsPath: config.zalo.credsPath,
  messagesPerMinute: config.zalo.messagesPerMinute,
  burst: config.zalo.burst,
});

const store = new MappingStore(config.bridge.dbPath);

const botContext: BotCommandContext = {
  // bridge is assigned right below; handleBotEvent only runs after startBridge
  bridge: undefined as unknown as BotCommandContext['bridge'],
  zalo,
  ownerUserId: config.matrix.owner,
};

const echoSuppressor = new EchoSuppressor();

// `outbound` and `presence` are declared further down; these handlers only run once
// startBridge() is listening, by which time both exist.
const bridge = createBridge(
  config,
  /**
   * Matrix timeline/state event: portal traffic goes to the outbound (Matrix → Zalo) handler,
   * everything else to the management-bot command handler.
   */
  async (event) => {
    // Portal rooms carry conversation traffic (outbound); everything else is bot commands
    if (event.room_id && store.isPortalRoom(event.room_id)) {
      await outbound.handle(event);
      return;
    }
    await handleBotEvent(botContext, event);
  },
  /**
   * Matrix ephemeral EDU: the owner's read receipts in a portal are mirrored onto Zalo as "seen".
   */
  async (event) => {
    // Ephemeral: owner's read receipts + typing in a portal → mirror onto Zalo.
    // Presence events carry no room_id and are ignored.
    if (event.type === 'm.receipt') {
      if (store.isPortalRoom(event.room_id))
        await presence.handleOwnerReceipt(event.room_id, event.content as Record<string, unknown>);
    }
    // Typing mirroring disabled on request — re-enable by uncommenting:
    // else if (event.type === "m.typing") {
    //   if (store.isPortalRoom(event.room_id)) await presence.handleOwnerTyping(event.room_id, event.content.user_ids ?? []);
    // }
  },
);
botContext.bridge = bridge;

// Registration holds the as_token, ghost namespace, and the appservice id used to
// build the bridge-info state_key (<domain>/<registration id> — see network-branding.ts)
const registration = loadYaml(fs.readFileSync(config.matrix.registrationPath, 'utf8')) as {
  id?: string;
  as_token?: string;
  sender_localpart?: string;
  namespaces?: { users?: Array<{ regex: string }> };
};
const asToken = registration.as_token;
if (!asToken) throw new Error(`No as_token in ${config.matrix.registrationPath}`);
// bridge name = sender_localpart minus the trailing "bot" (sh-zalobot → sh-zalo):
// used for the remote-state endpoint, the double-puppet source tag and the ghost prefix
const bridgeAppId = bridgeIdFor(registration.sender_localpart);
const branding = bridgeBranding(config, registration);

// Shared between in/out handlers: event_ids the bridge posted as the owner (own
// phone messages) + events already sent outbound — prevents re-sending / loops.
const bridgedEventIds = new Set<string>();

const puppets = new PuppetRegistry(
  bridge,
  store,
  config.matrix.domain,
  (uid) => zalo.getUserProfile(uid),
  `${bridgeAppId}_`,
);
const portals = new PortalManager(bridge, store, puppets, config.matrix.owner, branding);
const inbound = new InboundHandler({
  bridge,
  store,
  puppets,
  portals,
  echo: echoSuppressor,
  ownerUserId: config.matrix.owner,
  mediaMaxBytes: config.bridge.mediaMaxBytes,
  resolveGroupName: (threadId) => zalo.getGroupName(threadId),
  resolveStickerUrl: (stickerId) => zalo.getStickerImageUrl(stickerId),
  getOwnZaloId: () => zalo.ownId,
  bridgedEventIds,
});

const outbound = new OutboundHandler({
  bridge,
  store,
  puppets,
  zalo,
  echo: echoSuppressor,
  ownerUserId: config.matrix.owner,
  mediaMaxBytes: config.bridge.mediaMaxBytes,
  homeserverUrl: config.matrix.homeserverUrl,
  matrixToken: asToken,
  bridgedEventIds,
});
const syncManager = new SyncManager({ zalo, portals, inbound, store });
botContext.runSync = () => syncManager.run();

// Fail fast if computed ghost MXIDs cannot be registered under this appservice
const usersRegex = registration.namespaces?.users?.[0]?.regex;
if (!usersRegex) throw new Error(`No user namespace in ${config.matrix.registrationPath}`);
assertGhostNamespace(usersRegex, puppets.mxidFor('1234567890'));

// Beeper needs a remote-account state to show the network and its chats (see beeper-bridge-state.ts)
const publishZaloState = createZaloStatePublisher({
  homeserverUrl: config.matrix.homeserverUrl,
  bridgeId: bridgeAppId,
  asToken,
  fallbackName: config.network.name,
  getOwnId: () => zalo.ownId,
  getOwnProfile: (uid) => zalo.getUserProfile(uid),
  /** Downloads the own Zalo avatar (CDN-guarded, size-capped) and re-hosts it as mxc://. */
  uploadAvatar: async (avatarUrl) => {
    const { buffer, mimetype } = await fetchMediaCapped(avatarUrl, AVATAR_MAX_BYTES);
    return bridge.getIntent().uploadContent(buffer, { type: mimetype, name: 'zalo-avatar' });
  },
});

// Ghost name/avatar repair runs once per process: ghosts created by the history
// importer never had their Zalo profile looked up (no names, no avatars).
// Zalo rate-limits getUserInfo ("Vượt quá số request cho phép" at 50 uids / 2 s), so
// the repair is paced gently and, after a refused lookup, waits an hour before the
// next connect may retry — protecting the account matters more than finishing fast.
const PROFILE_REPAIR_PACE = { batchSize: 20, pauseMs: 15_000 };
const PROFILE_REPAIR_RETRY_AFTER_MS = 60 * 60 * 1000;
let profileRepairStarted = false;
let profileRepairFailedAt = 0;

// Zalo listener lifecycle → logs + Beeper remote-account state
zalo.on('connected', () => {
  console.log('[zalo] listener connected');
  void portals.repairDmGhostNames().catch((err) => console.warn('DM name repair failed:', err));
  if (!profileRepairStarted && Date.now() - profileRepairFailedAt >= PROFILE_REPAIR_RETRY_AFTER_MS) {
    profileRepairStarted = true;
    void puppets
      .repairMissingProfiles((uids) => zalo.getUserProfiles(uids), PROFILE_REPAIR_PACE)
      .then(({ named, withAvatar, checked, complete }) => {
        console.log(`[bridge] profile repair: ${checked} profiles checked, ${named} named, ${withAvatar} avatars set`);
        // a lookup failed mid-way (e.g. Zalo refused): retry on a connect after the cooldown
        if (!complete) {
          profileRepairStarted = false;
          profileRepairFailedAt = Date.now();
        }
      })
      .catch((err) => {
        profileRepairStarted = false;
        profileRepairFailedAt = Date.now();
        console.warn('profile repair failed:', err);
      });
  }
  void publishZaloState('CONNECTED');
});
zalo.on('reconnecting', (attempt, delayMs) => {
  console.warn(`[zalo] listener reconnecting (attempt ${attempt}, in ${delayMs}ms)`);
  void publishZaloState('TRANSIENT_DISCONNECT');
});
zalo.on('dead', (reason) => {
  console.error(`[zalo] listener DEAD: ${reason} — send 'login' in the management room`);
  void publishZaloState('BAD_CREDENTIALS');
});
// Every Zalo message (incoming and own) → inbound handler (Zalo → Matrix)
zalo.on('message', (message) => {
  // Ids only, never content — enough to tell "Zalo sent nothing" from "bridging failed"
  console.log(
    `[zalo] ${message.isSelf ? 'own' : 'in'} ${message.threadType} ${message.content.kind} thread=${message.threadId} msg=${message.msgId}`,
  );
  inbound.handle(message);
});
const presence = new PresenceHandler(store, puppets, zalo, config.matrix.owner, () => zalo.ownId);
// Zalo ephemeral signals → ghost read receipts / typing / reactions in Matrix (errors logged)
zalo.on(
  'seen',
  (seenEvent) => void presence.handleSeen(seenEvent).catch((err) => console.warn('seen handling failed:', err)),
);
// Zalo → Matrix typing stays active; only the owner's Beeper → Zalo typing is disabled (see above)
zalo.on(
  'typing',
  (typingEvent) => void presence.handleTyping(typingEvent).catch((err) => console.warn('typing handling failed:', err)),
);
zalo.on(
  'reaction',
  (reactionEvent) =>
    void presence.handleReaction(reactionEvent).catch((err) => console.warn('reaction handling failed:', err)),
);

// Appservice MUST be up before the Zalo listener: intents throw pre-initialise,
// and the old_messages replay burst arrives immediately on ws connect
await startBridge(bridge, config);
await ensureNetworkIdentity(bridge, branding);
// Backfill the network chip on portals created before branding existed
void portals.rebrandExistingPortals().catch((err) => console.warn('portal rebrand failed:', err));
// Repair portals: drop ones built from prefixed pinned ids, then join the owner into
// any left at "invite" (invisible in Beeper) by the old broken owner auto-join
void portals
  .removeMalformedPortals()
  .then(() => portals.joinOwnerToExistingPortals())
  .catch((err) => console.warn('portal repair failed:', err));

// Silent cookie re-login at startup; QR (via 'login' command) when absent/expired
if (await zalo.loginFromSavedCredentials()) {
  zalo.startListening();
  console.log(`[zalo] re-logged in from saved credentials (uid ${zalo.ownId})`);
} else {
  console.log("[zalo] no valid saved credentials — send 'login' to the bot from Beeper");
}
