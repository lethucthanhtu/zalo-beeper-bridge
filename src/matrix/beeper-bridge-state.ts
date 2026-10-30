// Beeper renders a bridge as a chat network only when its *remote account* state is
// published (visible as `bridges.<id>.remoteState` in `bbctl whoami --raw`). `bbctl proxy`
// publishes the bridge-level state (STARTING/RUNNING/BRIDGE_UNREACHABLE) on our behalf,
// but the per-account state is the bridge's own job. With it missing, newer Beeper clients
// hide the network chip and every chat filed under it, while older clients still render
// them from the local index — which is why the same account looks different per device.
//
// Two distinct endpoints, easy to confuse:
//   POST .../bridge/<id>/bridge_state         camelCase `stateEvent`, bridge-level states only
//   POST .../bridge/<id>/bridge_remote_state  snake_case `state_event`, per-account states  ← this one

import type { ZaloProfile } from '../zalo/types.ts';
import { errorMessage } from '../error-message.ts';

const BEEPER_API_BASE = 'https://api.beeper.com';

/** Beeper hungryserv URLs embed the account name: https://matrix.beeper.com/_hungryserv/<username> */
const HUNGRYSERV_USERNAME = /\/_hungryserv\/([^/?#]+)/;

/** Per-account state values understood by Beeper's `bridge_remote_state` endpoint. */
export type RemoteStateEvent =
  'CONNECTED' | 'TRANSIENT_DISCONNECT' | 'BAD_CREDENTIALS' | 'LOGGED_OUT' | 'UNKNOWN_ERROR';

/** JSON body posted to `bridge_remote_state` (snake_case keys are Beeper's wire format). */
export type RemoteState = {
  state_event: RemoteStateEvent;
  /** Zalo uid — the key Beeper files the account under */
  remote_id: string;
  remote_name?: string;
  remote_profile?: { name?: string; avatar?: string };
};

/** Publishes one remote-account state. Never throws: status reporting must not break the bridge. */
export type RemoteStateReporter = (state: RemoteState) => Promise<void>;

/** Profile lookups go through zca-js and can hang; past this we publish with a plain label. */
const PROFILE_LOOKUP_TIMEOUT_MS = 5_000;
/** Size cap for downloading the own Zalo avatar before re-hosting it on Matrix. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
// Beeper expires a remote state that goes unrefreshed for a few hours even while the Zalo
// listener stays connected the whole time (confirmed empirically: one state_event transition
// at startup, no further transitions for 3h+, remoteState came back empty on next check).
// Re-post the last known state periodically so a long-idle connection doesn't go stale.
// The startup publish is also lost (wiped when bbctl proxy comes up: remoteState stayed
// empty until the first heartbeat on 2026-10-30), and with no remote state Beeper Desktop
// hides every chat — so repost every minute to cap that gap at ~1 min.
const HEARTBEAT_MS = 60 * 1000;

/** Dependencies of {@link createZaloStatePublisher}; injected so this module stays free of Zalo/Matrix clients. */
export type ZaloStatePublisherDeps = {
  homeserverUrl: string;
  /** appservice id, e.g. "sh-zalo" */
  bridgeId: string;
  asToken: string;
  /** account label when the Zalo profile is unavailable */
  fallbackName: string;
  getOwnId: () => string | null;
  getOwnProfile: (uid: string) => Promise<ZaloProfile | null>;
  /** Zalo CDN links are signed and expire — Beeper needs the avatar re-hosted as mxc:// */
  uploadAvatar: (zaloAvatarUrl: string) => Promise<string | undefined>;
};

/**
 * Publishes the Zalo account's state to Beeper, then keeps re-posting it on an interval so a
 * long-idle connection (no further transitions) doesn't silently expire server-side. Beeper's
 * display fields (name/avatar) only take effect on an actual `state_event` change, but the
 * repost still resets the server's staleness clock — that's the point of the heartbeat.
 *
 * Side effects: starts an unref'd heartbeat interval immediately (never cleared). Each call of
 * the returned function may look up the own Zalo profile (CONNECTED only, bounded by
 * PROFILE_LOOKUP_TIMEOUT_MS), upload the avatar to Matrix, and POST to Beeper's API.
 *
 * @param deps - Homeserver/bridge identity plus Zalo profile and avatar-upload callbacks.
 * @returns `publish(stateEvent)`: resolves once the state is posted; a no-op while logged out
 *   (no own uid), and a publish overtaken by a later one while it was still looking up the
 *   profile is dropped (so a slow CONNECTED cannot overwrite a newer disconnect state).
 *   Never rejects: profile lookup, avatar upload and POST failures are logged or ignored.
 */
export function createZaloStatePublisher(
  deps: ZaloStatePublisherDeps,
): (stateEvent: RemoteStateEvent) => Promise<void> {
  const reportRemoteState = createRemoteStateReporter(deps.homeserverUrl, deps.bridgeId, deps.asToken);
  let lastState: RemoteState | null = null;
  /** Bumped by every publish; a publish only takes effect while it is still the latest. */
  let latestPublish = 0;

  setInterval(() => {
    if (lastState) void reportRemoteState(lastState);
  }, HEARTBEAT_MS).unref();

  return async (stateEvent) => {
    // After logout / listener death the session (and own id) is gone: file the state
    // under the last known account, or Beeper would keep showing CONNECTED
    const remoteId = deps.getOwnId() ?? lastState?.remote_id;
    if (!remoteId) return; // never logged in — nothing to file the state under
    const publishNumber = ++latestPublish;

    const profile =
      stateEvent === 'CONNECTED' ? await withTimeout(deps.getOwnProfile(remoteId)).catch(() => null) : null;
    const avatarMxc = profile?.avatarUrl ? await deps.uploadAvatar(profile.avatarUrl).catch(warnAvatar) : undefined;
    if (publishNumber !== latestPublish) return; // a newer state was published meanwhile

    lastState = {
      state_event: stateEvent,
      remote_id: remoteId,
      remote_name: profile?.displayName ?? deps.fallbackName,
      ...(profile?.displayName ? { remote_profile: { name: profile.displayName, avatar: avatarMxc } } : {}),
    };
    await reportRemoteState(lastState);
  };
}

/**
 * `.catch` handler for a failed avatar upload: logs a warning and yields `undefined` so the
 * state is still published, just without an avatar.
 */
function warnAvatar(err: unknown): undefined {
  console.warn('[beeper] own avatar upload failed:', errorMessage(err));
  return undefined;
}

/**
 * Races `promise` against PROFILE_LOOKUP_TIMEOUT_MS. The timer is unref'd so it never keeps
 * the process alive; the original promise is not cancelled, only ignored.
 *
 * @returns The promise's value, or `null` when the timeout wins.
 */
async function withTimeout<T>(promise: Promise<T | null>): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PROFILE_LOOKUP_TIMEOUT_MS).unref()),
  ]);
}

/**
 * Build a reporter for a Beeper-hosted bridge. Returns a no-op on any other homeserver,
 * so a self-hosted (non-Beeper) deployment keeps working untouched.
 *
 * @param homeserverUrl - Must be a hungryserv URL (`.../_hungryserv/<username>`) to enable reporting.
 * @param bridgeId - Appservice id, e.g. "sh-zalo".
 * @param asToken - Appservice token, sent as the Bearer token to Beeper's API.
 * @returns A reporter that POSTs the state (plus a unix `timestamp`) and logs — never throws —
 *   on a non-2xx answer or network error.
 */
export function createRemoteStateReporter(
  homeserverUrl: string,
  bridgeId: string,
  asToken: string,
): RemoteStateReporter {
  const username = HUNGRYSERV_USERNAME.exec(homeserverUrl)?.[1];
  if (!username) return async () => undefined;

  const endpoint = `${BEEPER_API_BASE}/bridgebox/${encodeURIComponent(username)}/bridge/${encodeURIComponent(bridgeId)}/bridge_remote_state`;

  return async (state) => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        // A hung request must not pile up behind every heartbeat
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${asToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state, timestamp: Math.floor(Date.now() / 1000) }),
      });
      if (!response.ok) {
        console.warn(
          `[beeper] remote state ${state.state_event} rejected: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.warn(`[beeper] remote state ${state.state_event} failed:`, errorMessage(err));
    }
  };
}
