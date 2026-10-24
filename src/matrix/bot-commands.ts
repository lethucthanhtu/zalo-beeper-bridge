// Management commands handled by the bridge bot (@sh-zalobot).
// Commands accepted ONLY from the configured owner (single-user bridge).
import type { Bridge, WeakEvent } from 'matrix-appservice-bridge';
import type { ZaloClient } from '../zalo/zalo-client.ts';

/** Process start time (module load), the reference point for the reported uptime. */
const startedAt = Date.now();

/** Bridge uptime since module load, formatted as "<h>h <m>m <s>s". */
function formatUptime(): string {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
  return `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`;
}

/** Everything the bot command handlers need; built once in index.ts. */
export type BotCommandContext = {
  bridge: Bridge;
  zalo: ZaloClient;
  ownerUserId: string;
  /** Conversation sync (pinned + top groups); returns a summary message. */
  runSync?: () => Promise<string>;
};

/**
 * `login` command: starts a Zalo QR login and posts the QR code into the management room as
 * an image; on success starts the Zalo listener. Refuses when already logged in.
 * Login errors are reported to the room instead of thrown; Matrix send failures still throw.
 *
 * @param context - Bot command context.
 * @param roomId - Management room to answer in.
 */
async function handleLogin(context: BotCommandContext, roomId: string): Promise<void> {
  const intent = context.bridge.getIntent();
  if (context.zalo.isLoggedIn) {
    await intent.sendText(
      roomId,
      `Already logged in to Zalo (uid ${context.zalo.ownId}). Use 'logout' first to switch.`,
    );
    return;
  }
  await intent.sendText(roomId, 'Generating Zalo QR — scan it with the Zalo app, then confirm on your phone.');
  try {
    await context.zalo.loginWithQR(async (qrPng) => {
      const qrMxcUrl = await intent.uploadContent(qrPng, { type: 'image/png', name: 'zalo-login-qr.png' });
      await intent.sendMessage(roomId, {
        msgtype: 'm.image',
        url: qrMxcUrl,
        body: 'zalo-login-qr.png',
        info: { mimetype: 'image/png' },
      });
    });
    context.zalo.startListening();
    await intent.sendText(roomId, `✓ Logged in to Zalo (uid ${context.zalo.ownId}), listener started.`);
  } catch (err) {
    await intent.sendText(roomId, `Zalo login failed: ${(err as Error).message}`);
  }
}

/**
 * `status` command: posts bridge uptime, Zalo login state and listener state.
 *
 * @param context - Bot command context.
 * @param roomId - Management room to answer in.
 */
async function handleStatus(context: BotCommandContext, roomId: string): Promise<void> {
  const zaloStatus = context.zalo.status;
  const lines = [
    `bridge uptime: ${formatUptime()}`,
    `zalo: ${zaloStatus.loggedIn ? `logged in (uid ${zaloStatus.ownId})` : "NOT logged in — send 'login'"}`,
    `listener: ${zaloStatus.listener}`,
  ];
  await context.bridge.getIntent().sendText(roomId, lines.join('\n'));
}

/**
 * Handles bot-directed events (any event outside a portal room). Auto-joins the owner's
 * invite to the bot and dispatches the owner's text commands
 * (`ping | login | logout | status | sync`); everyone else is ignored.
 *
 * Side effects: Matrix joins/sends as the bot; `login`/`logout`/`sync` change Zalo state.
 *
 * @param context - Bot command context.
 * @param event - The incoming Matrix event.
 * @returns `true` when the event was consumed (including the bot's own echoes and any
 *   membership event addressed to the bot), `false` when it is not a known command.
 * @throws Matrix send/join errors and errors from `runSync` propagate to the caller.
 */
export async function handleBotEvent(context: BotCommandContext, event: WeakEvent): Promise<boolean> {
  const botUserId = context.bridge.getBot().getUserId();
  if (event.sender === botUserId) return true; // ignore own echoes

  // Auto-accept invites addressed to the bot (owner starting the management DM)
  if (event.type === 'm.room.member' && event.state_key === botUserId) {
    const content = event.content as { membership?: string };
    if (content.membership === 'invite' && event.sender === context.ownerUserId) {
      await context.bridge.getIntent().join(event.room_id);
      await context.bridge
        .getIntent()
        .sendText(event.room_id, 'sh-zalo bridge bot ready. Commands: ping | login | logout | status | sync');
    }
    return true;
  }

  if (event.type !== 'm.room.message') return false;
  if (event.sender !== context.ownerUserId) return false; // commands are owner-only
  const command = (event.content as { body?: string }).body?.trim().toLowerCase();

  switch (command) {
    case 'ping':
      await context.bridge.getIntent().sendText(event.room_id, `pong! uptime ${formatUptime()}`);
      return true;
    case 'login':
      await handleLogin(context, event.room_id);
      return true;
    case 'logout':
      context.zalo.logout();
      await context.bridge.getIntent().sendText(event.room_id, 'Logged out of Zalo; saved credentials cleared.');
      return true;
    case 'status':
      await handleStatus(context, event.room_id);
      return true;
    case 'sync': {
      if (!context.runSync || !context.zalo.isLoggedIn) {
        await context.bridge.getIntent().sendText(event.room_id, 'Sync unavailable — log in to Zalo first.');
        return true;
      }
      await context.bridge
        .getIntent()
        .sendText(event.room_id, 'Syncing pinned conversations + top groups (paced to protect the account)...');
      try {
        const summary = await context.runSync();
        await context.bridge.getIntent().sendText(event.room_id, summary);
      } catch (err) {
        // the owner asked for it — tell them, don't just log
        await context.bridge.getIntent().sendText(event.room_id, `Sync failed: ${(err as Error).message}`);
      }
      return true;
    }
    default:
      return false;
  }
}
