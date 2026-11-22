// Zalo group polls → Matrix (MSC3381): poll.start from the creator, poll.response from each
// voter, poll.end on lock / removal. Driven by InboundHandler.handlePoll, one event at a time
// per thread (so a vote never overtakes the poll it belongs to).
import type { Intent } from 'matrix-appservice-bridge';
import type { InboundHandlerDeps } from './inbound-handler.ts';
import type { PollRow, PortalRow } from './mapping-store.ts';
import { ownerIntent } from './owner-intent.ts';
import { rememberBridgedEvent, SELF_BRIDGE_MARKER } from './self-bridge.ts';
import {
  answerIdFor,
  buildPollEnd,
  buildPollResponse,
  buildPollStart,
  POLL_END,
  POLL_RESPONSE,
  POLL_START,
} from './poll-content.ts';
import type { ZaloPoll, ZaloPollEvent } from '../zalo/types.ts';
import { errorMessage } from '../error-message.ts';

/** Key under which an anonymous poll's per-option counts are kept in the stored votes. */
const TALLY_KEY = '#tally';

export type InboundPollDeps = Pick<
  InboundHandlerDeps,
  'bridge' | 'store' | 'puppets' | 'portals' | 'echo' | 'ownerUserId' | 'getOwnZaloId' | 'bridgedEventIds'
> & {
  /** reads a poll's options and voters from Zalo (null when it cannot be read) */
  getPollDetail: (pollId: number) => Promise<ZaloPoll | null>;
  /** posts a bot notice into the portal room */
  notice: (portal: PortalRow, text: string) => Promise<unknown>;
};

/** Per-option vote lists of a poll: uid → the option ids that uid picked. */
function currentVotes(poll: ZaloPoll): Record<string, number[]> {
  const votes: Record<string, number[]> = {};
  for (const option of poll.options) {
    for (const uid of option.voters) (votes[uid] ??= []).push(option.optionId);
  }
  return votes;
}

const sameIds = (a: number[] | undefined, b: number[] | undefined) =>
  [...(a ?? [])].sort().join(',') === [...(b ?? [])].sort().join(',');

/** Mirrors Zalo poll activity into a portal room as MSC3381 events. */
export class InboundPolls {
  private readonly deps: InboundPollDeps;

  constructor(deps: InboundPollDeps) {
    this.deps = deps;
  }

  /**
   * Bridges one board event. A lock (`closed` in the detail) or a removal ends the poll; any
   * other update posts the poll if it is new, then the votes that changed since last time.
   * Group portals only; a portal is never created for a poll. Failures propagate to the queue.
   */
  async process(event: ZaloPollEvent): Promise<void> {
    const { store } = this.deps;
    const portal = store.getPortalByThread(event.threadId);
    if (!portal || portal.thread_type !== 'group') return;
    const known = store.getPollById(event.pollId);

    if (event.action === 'remove') {
      if (known && !known.closed) await this.end(known, portal, 'The poll was removed on Zalo');
      return;
    }
    // the echo of a poll created from Beeper: OutboundHandler records that mapping itself
    if (!known && event.isSelf && this.deps.echo.consumePoll(event.threadId)) return;
    if (known?.closed) return;

    const poll = await this.deps.getPollDetail(event.pollId);
    if (!poll) {
      console.warn(`[bridge] poll ${event.pollId} detail unavailable (thread ${event.threadId})`);
      return;
    }
    const row = known ?? (await this.start(poll, event, portal));
    await this.syncVotes(row, poll, portal);
    if (poll.closed) await this.end(row, portal, 'The poll was closed on Zalo');
  }

  /** Posts the poll.start as the creator and records the mapping; returns the stored row. */
  private async start(poll: ZaloPoll, event: ZaloPollEvent, portal: PortalRow): Promise<PollRow> {
    const creatorId = poll.creatorId ?? event.creatorId;
    const eventId = await this.send(creatorId, event.isSelf, portal, POLL_START, buildPollStart(poll));
    this.deps.store.recordPoll({
      pollId: poll.pollId,
      roomId: portal.room_id,
      eventId,
      creatorId: creatorId ?? null,
      options: poll.options.map((o) => ({
        optionId: o.optionId,
        answerId: answerIdFor(o.optionId),
        content: o.content,
      })),
      multi: poll.multiChoice,
    });
    return this.deps.store.getPollById(poll.pollId)!;
  }

  /** Sends a poll.response for every voter whose selection changed (or tallies for an anonymous poll). */
  private async syncVotes(row: PollRow, poll: ZaloPoll, portal: PortalRow): Promise<void> {
    if (poll.anonymous) return this.syncTallies(row, poll, portal);
    const before = row.votes;
    const after = currentVotes(poll);
    const saved: Record<string, number[]> = { ...before };
    const voters = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const uid of voters) {
      if (sameIds(before[uid], after[uid])) continue;
      const optionIds = after[uid] ?? [];
      await this.send(uid, false, portal, POLL_RESPONSE, buildPollResponse(row.eventId, optionIds.map(answerIdFor)));
      if (optionIds.length) saved[uid] = optionIds;
      else delete saved[uid];
      this.deps.store.setPollVotes(row.pollId, saved); // per voter, so a failure does not resend the others
    }
  }

  /** An anonymous poll hides who voted: post the new per-option counts as a bot notice. */
  private async syncTallies(row: PollRow, poll: ZaloPoll, portal: PortalRow): Promise<void> {
    const counts = poll.options.map((option) => option.votes);
    const previous = row.votes[TALLY_KEY] ?? poll.options.map(() => 0);
    if (previous.join(',') === counts.join(',')) return;
    const lines = poll.options.map((option) => `${option.content}: ${option.votes}`);
    await this.deps.notice(portal, [`\u{1F5F3} ${poll.question}`, ...lines].join('\n'));
    this.deps.store.setPollVotes(row.pollId, { [TALLY_KEY]: counts });
  }

  /** Ends the poll in Matrix as its creator (the bot when the creator may not), then marks it closed. */
  private async end(row: PollRow, portal: PortalRow, text: string): Promise<void> {
    const content = buildPollEnd(row.eventId, text);
    try {
      await this.send(row.creatorId ?? undefined, false, portal, POLL_END, content);
    } catch (err) {
      console.warn(`[bridge] poll.end as the creator failed in ${portal.room_id}, using the bot:`, errorMessage(err));
      await this.deps.bridge.getIntent().sendEvent(portal.room_id, POLL_END, content);
    }
    this.deps.store.closePoll(row.pollId);
  }

  /**
   * Sends one poll event as `uid`: the owner for the account's own uid (tagged with
   * SELF_BRIDGE_MARKER and remembered, so OutboundHandler never sends it back to Zalo),
   * that user's ghost for anybody else, the bot when the sender is unknown.
   * @returns the event_id
   */
  private async send(
    uid: string | undefined,
    isSelf: boolean,
    portal: PortalRow,
    type: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const own = this.deps.getOwnZaloId();
    const asOwner = (isSelf && uid === undefined) || (uid !== undefined && uid === own);
    const intent: Intent = asOwner
      ? ownerIntent(this.deps.bridge, this.deps.ownerUserId)
      : uid
        ? await this.ghostIntent(uid, portal)
        : this.deps.bridge.getIntent();
    const body = asOwner ? { ...content, [SELF_BRIDGE_MARKER]: true } : content;
    const eventId = (await intent.sendEvent(portal.room_id, type, body)).event_id;
    if (asOwner) rememberBridgedEvent(this.deps.bridgedEventIds, eventId);
    return eventId;
  }

  private async ghostIntent(uid: string, portal: PortalRow): Promise<Intent> {
    const ghost = await this.deps.puppets.ensurePuppet(uid, undefined);
    await this.deps.portals.ensureGhostInRoom(uid, portal.room_id, undefined);
    return ghost;
  }
}
