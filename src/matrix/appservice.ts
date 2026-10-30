// Matrix appservice wiring: Bridge instance + event routing.
// bbctl proxy holds the websocket to Beeper and forwards to our local HTTP port.
import fs from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import {
  AppServiceRegistration,
  Bridge,
  type EphemeralEvent,
  type Request,
  type WeakEvent,
} from 'matrix-appservice-bridge';
import type { BridgeConfig } from '../config.ts';

/**
 * Reads registration.yaml (as_token, ghost namespace, appservice id, sender_localpart).
 *
 * @throws when the file is unreadable or has no as_token
 */
export function loadRegistration(registrationPath: string): AppServiceRegistration {
  const registration = AppServiceRegistration.fromObject(
    loadYaml(fs.readFileSync(registrationPath, 'utf8')) as Parameters<typeof AppServiceRegistration.fromObject>[0],
  );
  if (!registration.getAppServiceToken()) throw new Error(`No as_token in ${registrationPath}`);
  return registration;
}

/** Handler for regular (timeline/state) Matrix events routed from the appservice. */
export type MatrixEventHandler = (event: WeakEvent) => Promise<void> | void;
/** Handler for ephemeral EDUs. Read receipts and typing arrive via a SEPARATE controller callback, not onEvent */
export type MatrixEphemeralHandler = (event: EphemeralEvent) => Promise<void> | void;

/**
 * Builds the matrix-appservice-bridge `Bridge` and routes incoming events to the given handlers.
 * Each handler call is fire-and-forget: a thrown error is logged and never propagates back into
 * the library (which would otherwise fail the whole transaction).
 *
 * @param config - Bridge config; uses the `matrix` section (homeserver, domain).
 * @param registration - The appservice registration ({@link loadRegistration}).
 * @param onEvent - Called for every timeline/state event of a transaction.
 * @param onEphemeral - Called for every ephemeral EDU (m.receipt, m.typing, m.presence).
 * @returns The configured but not yet listening bridge — call {@link startBridge} to serve it.
 */
export function createBridge(
  config: BridgeConfig,
  registration: AppServiceRegistration,
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
    registration,
    // The bridge keeps its own SQLite mapping store — skip the library's nedb stores
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
  // Hungryserv asks for bridgev2 provisioning capabilities on every proxy connect (bbctl
  // proxy always forwards as PUT). No start-chat/group features: answer "none" instead of 404.
  // Unauthenticated: loopback-only port, static answer.
  bridge.addAppServicePath({
    method: 'PUT',
    path: '/_matrix/provision/v3/capabilities',
    authenticate: false,
    handler: (_req, res) => {
      res.json({
        resolve_identifier: {
          create_dm: false,
          lookup_phone: false,
          lookup_email: false,
          lookup_username: false,
          any_phone: false,
          contact_list: false,
          search: false,
        },
        group_creation: {},
      });
    },
  });
  // Log anything else hungryserv proxies to us, so new probes are visible
  bridge.appService.expressApp.use((req: { method: string; path: string }, _res: unknown, next: () => void) => {
    console.warn(`[appservice] unhandled ${req.method} ${req.path}`);
    next();
  });
  console.log(
    `Appservice listening on localhost:${config.matrix.port} (run 'bbctl proxy -r ${config.matrix.registrationPath}' alongside)`,
  );
}
