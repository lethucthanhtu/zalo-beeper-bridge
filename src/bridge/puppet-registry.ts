// Zalo uid → Matrix ghost (@<bridge>_<uid>:domain, e.g. @sh-zalo_<uid>): registration + displayname sync.
import type { Bridge, Intent } from 'matrix-appservice-bridge';
import { fetchMediaCapped } from './media-handler.ts';
import type { MappingStore } from './mapping-store.ts';

/** Default ghost localpart prefix (bridge registered as `sh-zalo`). */
export const GHOST_PREFIX = 'sh-zalo_';

/**
 * Bridge name from the registration's bot localpart: `bbctl register <name>` makes the bot
 * `<name>bot` and the ghost namespace `@<name>_.+`, so a second bridge (`sh-zalo2`) differs.
 */
export const bridgeIdFor = (senderLocalpart?: string): string => (senderLocalpart ?? 'sh-zalobot').replace(/bot$/, '');

/**
 * Looks up a Zalo contact's profile. Resolves null when the lookup is not possible
 * yet (e.g. Zalo not logged in) so the caller can retry later.
 */
export type ProfileResolver = (uid: string) => Promise<{ displayName?: string; avatarUrl?: string } | null>;

/**
 * Maps Zalo uids to Matrix ghost users: registers ghosts on first use and keeps
 * their displayname/avatar in sync with the Zalo profile (persisted in MappingStore).
 */
export class PuppetRegistry {
  private readonly bridge: Bridge;
  private readonly store: MappingStore;
  private readonly domain: string;
  private readonly resolveProfile?: ProfileResolver;
  private readonly ghostPrefix: string;
  /** ghost MXIDs already registered this run (skips the ensureRegistered round-trip) */
  private readonly registered = new Set<string>();
  /** uids whose missing name was already looked up this run (one Zalo call each) */
  private readonly nameLookups = new Set<string>();

  /**
   * @param bridge Appservice bridge that hands out ghost Intents.
   * @param store Persistent puppet table (names, avatar sync state).
   * @param domain Homeserver domain of the ghost MXIDs.
   * @param resolveProfile Optional Zalo profile lookup; without it no name lookup or avatar sync happens.
   * @param ghostPrefix Ghost localpart prefix, `${bridgeIdFor(sender_localpart)}_`.
   */
  constructor(
    bridge: Bridge,
    store: MappingStore,
    domain: string,
    resolveProfile?: ProfileResolver,
    ghostPrefix = GHOST_PREFIX,
  ) {
    this.bridge = bridge;
    this.store = store;
    this.domain = domain;
    this.resolveProfile = resolveProfile;
    this.ghostPrefix = ghostPrefix;
  }

  /** Ghost MXID for a Zalo uid: `@<prefix><uid>:<domain>`. */
  mxidFor(zaloUid: string): string {
    return `@${this.ghostPrefix}${zaloUid}:${this.domain}`;
  }

  /** Zalo uid behind one of this bridge's ghost MXIDs, or null for any other user. */
  uidFor(mxid: string): string | null {
    const localpart = /^@([^:]+):/.exec(mxid)?.[1];
    return localpart?.startsWith(this.ghostPrefix) && localpart.length > this.ghostPrefix.length
      ? localpart.slice(this.ghostPrefix.length)
      : null;
  }

  /** Ghost Intent for a Zalo uid, without registering it or syncing its profile. */
  intentFor(zaloUid: string): Intent {
    return this.bridge.getIntent(this.mxidFor(zaloUid));
  }

  /**
   * Ensures the ghost exists and its displayname tracks the Zalo contact name.
   * Side effects: registers the ghost (once per run), upserts the puppet row, may
   * look the name up via Zalo (once per uid per run), sets the Matrix displayname
   * when it changed and syncs the avatar until one has been recorded for the puppet
   * (a profile without an avatar is looked up again on every call). Profile/avatar
   * failures are logged, not thrown.
   * @param zaloUid Zalo uid of the contact.
   * @param displayName Name known from the triggering message, if any.
   * @returns The ghost's Intent.
   * @throws When ghost registration fails.
   */
  async ensurePuppet(zaloUid: string, displayName?: string): Promise<Intent> {
    const mxid = this.mxidFor(zaloUid);
    const intent = this.bridge.getIntent(mxid);
    if (!this.registered.has(mxid)) {
      await intent.ensureRegistered();
      this.registered.add(mxid);
    }
    // A DM portal created from the owner's own message carries no peer name, so the
    // ghost would show up as a bare "sh-zalo_<uid>" in Beeper: look the name up once
    let name = displayName;
    if (
      !name &&
      this.resolveProfile &&
      this.store.getPuppetDisplayName(zaloUid) === null &&
      !this.nameLookups.has(zaloUid)
    ) {
      const profile = await this.resolveProfile(zaloUid).catch(() => null);
      // null = not logged in yet / lookup failed → try again on a later call
      if (profile) this.nameLookups.add(zaloUid);
      name = profile?.displayName || undefined;
    }
    const nameChanged = this.store.upsertPuppet(zaloUid, mxid, name ?? null);
    if (nameChanged && name) {
      await intent
        .setDisplayName(name)
        .catch((err: Error) => console.warn(`setDisplayName(${mxid}) failed:`, err.message));
    }
    // Avatar: synced once per puppet (Zalo avatars change rarely). A contact whose
    // profile has no avatar is re-checked at most once per PROFILE_RECHECK_MS instead of
    // on every message they send.
    if (
      this.resolveProfile &&
      this.store.getPuppetAvatarUrl(zaloUid) === null &&
      !this.store.isProfileFresh(zaloUid, PROFILE_RECHECK_MS)
    ) {
      await this.syncAvatar(zaloUid, intent).catch((err: Error) =>
        console.warn(`avatar sync(${mxid}) failed:`, err.message),
      );
    }
    return intent;
  }

  /**
   * Looks the contact's profile up and applies its avatar (see applyProfile). No-op
   * when the lookup is not possible yet (null). Only called when `resolveProfile` is set.
   * @throws On download, upload or profile-update failure.
   */
  private async syncAvatar(zaloUid: string, intent: Intent): Promise<void> {
    const profile = await this.resolveProfile!(zaloUid);
    if (!profile) return;
    await this.applyAvatar(zaloUid, intent, profile.avatarUrl);
  }

  /**
   * Uploads the contact's Zalo avatar (capped at 5 MiB) as the ghost's avatar and records
   * the source URL so it is not synced again. The profile counts as checked once it is
   * settled — no avatar, or the avatar applied — but not after a failed download/upload,
   * so a transient error is retried on the contact's next message instead of in 24 h.
   * @throws On download, upload or profile-update failure.
   */
  private async applyAvatar(zaloUid: string, intent: Intent, avatarUrl: string | undefined): Promise<void> {
    if (avatarUrl && this.store.getPuppetAvatarUrl(zaloUid) !== avatarUrl) {
      const { buffer, mimetype } = await fetchMediaCapped(avatarUrl, 5 * 1024 * 1024);
      const avatarMxc = await intent.uploadContent(buffer, { type: mimetype, name: 'zalo-avatar' });
      await intent.setAvatarUrl(avatarMxc);
      this.store.setPuppetAvatarUrl(zaloUid, avatarUrl);
    }
    this.store.markProfileChecked(zaloUid);
  }

  /**
   * Fills in the name and avatar of every ghost still missing one — mostly ghosts the
   * history importer created, which never had their profile looked up. DM contacts go
   * first; profiles are fetched `batchSize` at a time with a pause between batches so
   * Zalo isn't flooded. Contacts checked within PROFILE_RECHECK_MS are skipped.
   * Failures are logged per contact and never thrown.
   *
   * @param fetchProfiles batched Zalo lookup: uid → profile (uids it cannot resolve are absent)
   * @returns how many ghosts got a name / an avatar, and whether every batch was looked up
   *   (`complete: false` → a lookup failed; the caller may retry later)
   */
  async repairMissingProfiles(
    fetchProfiles: (uids: string[]) => Promise<Map<string, { displayName?: string; avatarUrl?: string }>>,
    { batchSize = 50, pauseMs = 2_000 } = {},
  ): Promise<{ named: number; withAvatar: number; checked: number; complete: boolean }> {
    const pending = this.store.getPuppetsMissingProfile(PROFILE_RECHECK_MS);
    const result = { named: 0, withAvatar: 0, checked: 0, complete: true };
    for (let start = 0; start < pending.length; start += batchSize) {
      const batch = pending.slice(start, start + batchSize);
      const profiles = await fetchProfiles(batch).catch((err: Error) => {
        console.warn('[bridge] profile repair lookup failed:', err.message);
        return null;
      });
      if (!profiles) {
        result.complete = false; // not logged in / Zalo refused — the caller retries on the next connect
        break;
      }
      for (const uid of batch) {
        const profile = profiles.get(uid);
        if (!profile) {
          this.store.markProfileChecked(uid); // unknown/deleted account: don't ask again today
          continue;
        }
        result.checked++;
        const intent = this.intentFor(uid);
        if (profile.displayName && this.store.getPuppetDisplayName(uid) === null) {
          this.store.upsertPuppet(uid, this.mxidFor(uid), profile.displayName);
          await intent
            .setDisplayName(profile.displayName)
            .then(() => result.named++)
            .catch((err: Error) => console.warn(`setDisplayName(${uid}) failed:`, err.message));
        }
        const hadAvatar = this.store.getPuppetAvatarUrl(uid) !== null;
        await this.applyAvatar(uid, intent, profile.avatarUrl).catch((err: Error) =>
          console.warn(`avatar sync(${uid}) failed:`, err.message),
        );
        if (!hadAvatar && this.store.getPuppetAvatarUrl(uid) !== null) result.withAvatar++;
      }
      if (start + batchSize < pending.length) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    return result;
  }
}

/** How long a profile lookup counts as current (contacts without avatar aren't re-asked sooner). */
const PROFILE_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * Startup guard: computed ghost MXIDs must fall inside the appservice namespace.
 * @param usersRegex The `namespaces.users` regex from registration.yaml.
 * @param sampleMxid A ghost MXID built by `mxidFor`.
 * @throws When the MXID does not match, i.e. every ghost action would be rejected.
 */
export function assertGhostNamespace(usersRegex: string, sampleMxid: string): void {
  if (!new RegExp(usersRegex).test(sampleMxid)) {
    throw new Error(
      `Ghost MXID ${sampleMxid} does not match registration namespace regex ${usersRegex} — check registration.yaml`,
    );
  }
}
