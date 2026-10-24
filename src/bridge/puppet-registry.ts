// Zalo uid → Matrix ghost (@sh-zalo_<uid>:domain): registration + displayname sync.
import type { Bridge, Intent } from 'matrix-appservice-bridge';
import { fetchMediaCapped } from './media-handler.ts';
import type { MappingStore } from './mapping-store.ts';

/** Localpart prefix of every ghost MXID; must match the registration's user namespace. */
export const GHOST_PREFIX = 'sh-zalo_';

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
  /** ghost MXIDs already registered this run (skips the ensureRegistered round-trip) */
  private readonly registered = new Set<string>();
  /** uids whose missing name was already looked up this run (one Zalo call each) */
  private readonly nameLookups = new Set<string>();

  /**
   * @param bridge Appservice bridge that hands out ghost Intents.
   * @param store Persistent puppet table (names, avatar sync state).
   * @param domain Homeserver domain of the ghost MXIDs.
   * @param resolveProfile Optional Zalo profile lookup; without it no name lookup or avatar sync happens.
   */
  constructor(bridge: Bridge, store: MappingStore, domain: string, resolveProfile?: ProfileResolver) {
    this.bridge = bridge;
    this.store = store;
    this.domain = domain;
    this.resolveProfile = resolveProfile;
  }

  /** Ghost MXID for a Zalo uid: `@sh-zalo_<uid>:<domain>`. */
  mxidFor(zaloUid: string): string {
    return `@${GHOST_PREFIX}${zaloUid}:${this.domain}`;
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
    // Avatar: synced once per puppet (Zalo avatars change rarely; re-sync is a later concern)
    if (this.resolveProfile && this.store.getPuppetAvatarUrl(zaloUid) === null) {
      await this.syncAvatar(zaloUid, intent).catch((err: Error) =>
        console.warn(`avatar sync(${mxid}) failed:`, err.message),
      );
    }
    return intent;
  }

  /**
   * Downloads the contact's Zalo avatar (capped at 5 MiB), uploads it to Matrix,
   * sets it as the ghost's avatar and records the source URL so it is not synced
   * again. No-op when the profile has no avatar. Only called when `resolveProfile`
   * is set.
   * @throws On lookup, download, upload or profile-update failure.
   */
  private async syncAvatar(zaloUid: string, intent: Intent): Promise<void> {
    const profile = await this.resolveProfile!(zaloUid);
    if (!profile?.avatarUrl) return;
    const { buffer, mimetype } = await fetchMediaCapped(profile.avatarUrl, 5 * 1024 * 1024);
    const avatarMxc = await intent.uploadContent(buffer, { type: mimetype, name: 'zalo-avatar' });
    await intent.setAvatarUrl(avatarMxc);
    this.store.setPuppetAvatarUrl(zaloUid, profile.avatarUrl);
  }
}

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
