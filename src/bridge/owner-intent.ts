// Intent that acts AS the owner (double-puppeting via the as_token on hungryserv).
// The owner is a real account OUTSIDE the @sh-zalo_* namespace: matrix-appservice-bridge
// would call ensureRegistered first, which fails with M_EXCLUSIVE and aborts the
// action (verified: register → 400 M_EXCLUSIVE, while join/send with
// ?user_id=owner → 200). Marking the intent pre-registered skips that step.
import type { Bridge, Intent } from "matrix-appservice-bridge";

export function ownerIntent(bridge: Bridge, ownerUserId: string): Intent {
  const intent = bridge.getIntent(ownerUserId);
  (intent as unknown as { opts: { registered: boolean } }).opts.registered = true;
  return intent;
}
