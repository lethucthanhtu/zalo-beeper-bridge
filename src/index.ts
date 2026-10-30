// Entrypoint: load config → start Zalo client + appservice → route events.
// Top-level module (top-level await): everything below runs once at process start.
// Startup throws (missing config / as_token / user namespace, ghost namespace mismatch)
// are deliberate fail-fast exits.
import { Logger } from 'matrix-appservice-bridge';
import { loadConfig } from './config.ts';
import { EchoSuppressor } from './bridge/echo-suppressor.ts';
import { InboundHandler } from './bridge/inbound-handler.ts';
import { MappingStore } from './bridge/mapping-store.ts';
import { OutboundHandler } from './bridge/outbound-handler.ts';
import { PortalManager } from './bridge/portal-manager.ts';
import { PresenceHandler } from './bridge/presence-handler.ts';
import { bridgeIdFor, PuppetRegistry } from './bridge/puppet-registry.ts';
import { SyncManager } from './bridge/sync-manager.ts';
import { createBridge, loadRegistration, startBridge } from './matrix/appservice.ts';
import { AVATAR_MAX_BYTES, createZaloStatePublisher } from './matrix/beeper-bridge-state.ts';
import { fetchMediaCapped } from './bridge/media-handler.ts';
import { handleBotEvent, type BotCommandContext } from './matrix/bot-commands.ts';
import { bridgeBranding, ensureNetworkIdentity } from './matrix/network-branding.ts';
import { ZaloClient } from './zalo/zalo-client.ts';

const config = loadConfig();
// matrix-appservice-bridge logs nothing until its root logger is configured
Logger.configure({ console: config.logging.level });
// Registration: as_token, ghost namespace, and the appservice id used to build the
// bridge-info state_key (<domain>/<registration id> — see network-branding.ts)
const registration = loadRegistration(config.matrix.registrationPath);
const asToken = registration.getAppServiceToken()!;

const zalo = new ZaloClient({
  credsPath: config.zalo.credsPath,
  messagesPerMinute: config.zalo.messagesPerMinute,
  burst: config.zalo.burst,
});

const store = new MappingStore(config.bridge.dbPath);

const echoSuppressor = new EchoSuppressor();

// `outbound`, `presence` and `botContext` are declared further down; these handlers only
// run once startBridge() is listening, by which time all exist.
const bridge = createBridge(
  config,
  registration,
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
    // Owner receipts/typing in a portal → Zalo (Beeper's privacy settings decide whether
    // it sends them at all); presence events carry no room_id
    if (event.type === 'm.receipt' && store.isPortalRoom(event.room_id))
      await presence.handleOwnerReceipt(event.room_id, event.content as Record<string, unknown>);
    else if (event.type === 'm.typing' && store.isPortalRoom(event.room_id))
      await presence.handleOwnerTyping(event.room_id, event.content.user_ids);
  },
);

// bridge name = sender_localpart minus the trailing "bot" (sh-zalobot → sh-zalo):
// used for the remote-state endpoint, the double-puppet source tag and the ghost prefix
const bridgeAppId = bridgeIdFor(registration.getSenderLocalpart() ?? undefined);
const branding = bridgeBranding(config, {
  id: registration.getId(),
  sender_localpart: registration.getSenderLocalpart(),
});

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
const botContext: BotCommandContext = {
  bridge,
  zalo,
  ownerUserId: config.matrix.owner,
  runSync: () => syncManager.run(),
  listAccounts: () => store.listAccounts(),
};

// Fail fast if computed ghost MXIDs cannot be registered under this appservice
const sampleGhost = puppets.mxidFor('1234567890');
if (!registration.isUserMatch(sampleGhost, true)) {
  throw new Error(`Ghost MXID ${sampleGhost} is outside the registration's user namespace — check registration.yaml`);
}

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
  // Multi-account groundwork: remember this account and file untagged rows under it
  const ownId = zalo.ownId;
  if (ownId) {
    // a DB error (e.g. the history importer holding the write lock) must not crash the listener
    try {
      const assigned = store.bindAccount(ownId, config.zalo.credsPath);
      if (assigned.portals || assigned.messages) {
        console.log(`[bridge] account ${ownId}: ${assigned.portals} portals, ${assigned.messages} messages assigned`);
      }
    } catch (err) {
      console.warn('[bridge] recording the Zalo account failed (retried on the next connect):', err);
    }
  }
  void portals.repairDmGhostNames().catch((err: unknown) => console.warn('DM name repair failed:', err));
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
      .catch((err: unknown) => {
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
zalo.on('loggedOut', () => void publishZaloState('LOGGED_OUT'));
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
  (seenEvent) =>
    void presence.handleSeen(seenEvent).catch((err: unknown) => console.warn('seen handling failed:', err)),
);
zalo.on(
  'typing',
  (typingEvent) =>
    void presence.handleTyping(typingEvent).catch((err: unknown) => console.warn('typing handling failed:', err)),
);
zalo.on(
  'reaction',
  (reactionEvent) =>
    void presence.handleReaction(reactionEvent).catch((err: unknown) => console.warn('reaction handling failed:', err)),
);

// Appservice MUST be up before the Zalo listener: intents throw pre-initialise,
// and the old_messages replay burst arrives immediately on ws connect
await startBridge(bridge, config);
await ensureNetworkIdentity(bridge, branding);
// Backfill the network chip on portals created before branding existed
void portals.rebrandExistingPortals().catch((err: unknown) => console.warn('portal rebrand failed:', err));
// Repair portals: drop ones built from prefixed pinned ids, then join the owner into
// any left at "invite" (invisible in Beeper) by the old broken owner auto-join
void portals
  .removeMalformedPortals()
  .then(() => portals.joinOwnerToExistingPortals())
  .catch((err: unknown) => console.warn('portal repair failed:', err));

// Silent cookie re-login at startup; QR (via 'login' command) when absent/expired
if (await zalo.loginFromSavedCredentials()) {
  zalo.startListening();
  console.log(`[zalo] re-logged in from saved credentials (uid ${zalo.ownId})`);
} else {
  console.log("[zalo] no valid saved credentials — send 'login' to the bot from Beeper");
}
