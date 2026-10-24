// Matrix appservice wiring: Bridge instance + event routing.
// bbctl proxy holds the websocket to Beeper and forwards to our local HTTP port.
import { AppService } from 'matrix-appservice';
import { Bridge, type EphemeralEvent, type Request, type WeakEvent } from 'matrix-appservice-bridge';
import type { BridgeConfig } from '../config.ts';

// matrix-appservice only parses ephemeral EDUs from the UNSTABLE MSC2409 key
// (`de.sorunome.msc2409.ephemeral`), but Beeper/hungryserv sends them under the
// STABLE `ephemeral` key — so read receipts and typing were silently dropped.
// Patch the transaction handler (before any AppService is constructed) to mirror
// the stable key onto the unstable one the library reads.
type TransactionBody = Record<string, unknown> & { ephemeral?: unknown; 'de.sorunome.msc2409.ephemeral'?: unknown };
const appServicePrototype = AppService.prototype as unknown as {
  onTransaction: (request: { body?: TransactionBody }, response: unknown) => void;
};
const originalOnTransaction = appServicePrototype.onTransaction;
/**
 * Replacement for `AppService.prototype.onTransaction`, installed at module load.
 * Copies the stable `ephemeral` array onto the unstable MSC2409 key when only the stable
 * one is present, then delegates to the original handler unchanged.
 *
 * @param request - Express request of the incoming `PUT /transactions/:txnId`; its body is mutated in place.
 * @param response - Express response, passed through untouched.
 */
appServicePrototype.onTransaction = function patchedOnTransaction(request, response) {
  const body = request.body;
  if (body && body['de.sorunome.msc2409.ephemeral'] === undefined && body.ephemeral !== undefined) {
    body['de.sorunome.msc2409.ephemeral'] = body.ephemeral;
  }
  return originalOnTransaction.call(this, request, response);
};

/** Handler for regular (timeline/state) Matrix events routed from the appservice. */
export type MatrixEventHandler = (event: WeakEvent) => Promise<void> | void;
/** Handler for ephemeral EDUs. Read receipts and typing arrive via a SEPARATE controller callback, not onEvent */
export type MatrixEphemeralHandler = (event: EphemeralEvent) => Promise<void> | void;

/**
 * Builds the matrix-appservice-bridge `Bridge` and routes incoming events to the given handlers.
 * Each handler call is fire-and-forget: a thrown error is logged and never propagates back into
 * the library (which would otherwise fail the whole transaction).
 *
 * @param config - Bridge config; uses the `matrix` section (homeserver, domain, registration path).
 * @param onEvent - Called for every timeline/state event of a transaction.
 * @param onEphemeral - Called for every ephemeral EDU (m.receipt, m.typing, m.presence).
 * @returns The configured but not yet listening bridge — call {@link startBridge} to serve it.
 */
export function createBridge(
  config: BridgeConfig,
  onEvent: MatrixEventHandler,
  onEphemeral: MatrixEphemeralHandler,
): Bridge {
  /**
   * Runs `handler` without awaiting it, logging any error as "<label> failed for <context>".
   *
   * @param label - Name of the callback, used in the error log.
   * @param handler - The (possibly async) work to run.
   * @param context - Short description of the event (type/room) for the error log.
   */
  const runGuarded = (label: string, handler: () => Promise<void> | void, context: string) => {
    void (async () => {
      try {
        await handler();
      } catch (err) {
        console.error(`${label} failed for ${context}:`, err);
      }
    })();
  };

  const bridge = new Bridge({
    homeserverUrl: config.matrix.homeserverUrl,
    domain: config.matrix.domain,
    registration: config.matrix.registrationPath,
    // Own mapping store comes in Phase 4 (SQLite) — skip nedb stores entirely
    disableStores: true,
    controller: {
      /** Timeline/state event from the homeserver → `onEvent` (guarded, not awaited). */
      onEvent: (request: Request<WeakEvent>) => {
        const event = request.getData();
        runGuarded('onEvent', () => onEvent(event), `${event.type} in ${event.room_id}`);
      },
      /** Ephemeral EDU from the homeserver → `onEphemeral` (guarded, not awaited). */
      onEphemeralEvent: (request: Request<EphemeralEvent>) => {
        const event = request.getData();
        runGuarded('onEphemeralEvent', () => onEphemeral(event), event.type);
      },
    },
  });
  return bridge;
}

/**
 * Starts the appservice HTTP listener on `config.matrix.port`.
 *
 * @param bridge - The bridge returned by {@link createBridge}.
 * @param config - Bridge config (port, plus the registration path for the log line).
 * @throws If the port cannot be bound or the registration file is unreadable/invalid.
 */
export async function startBridge(bridge: Bridge, config: BridgeConfig): Promise<void> {
  // Loopback only — bbctl proxy is the sole legitimate caller; keep 29350 off the LAN
  await bridge.run(config.matrix.port, undefined, '127.0.0.1');
  console.log(
    `Appservice listening on localhost:${config.matrix.port} (run 'bbctl proxy -r ${config.matrix.registrationPath}' alongside)`,
  );
}
