import { describe, expect, it } from 'vitest';
import { auditCompleteness, type AuditInput } from '../completeness-audit.ts';

const NEW = '!new:beeper.local';
const OLD = '!old:beeper.local';

/** A minimal input: one carried message, overridable per test. */
function input(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    newRoom: NEW,
    oldRooms: [OLD],
    newTimeline: new Set(['$n1']),
    baseline: [{ msgId: '1', eventId: '$o1', direction: 'outbound', ts: 1 }],
    current: new Map([['1', { roomId: NEW, eventId: '$n1' }]]),
    sources: new Map(),
    accepted: new Set(),
    ...overrides,
  };
}

describe('auditCompleteness', () => {
  it('counts a message whose new event is in the new room timeline as carried', () => {
    const report = auditCompleteness(input());
    expect(report.counts).toEqual({ carried: 1, redacted: 0, marker: 0, accepted: 0, missing: 0 });
    expect(report.missing).toEqual([]);
  });

  it('reports a mapped message whose event is not in the new timeline as missing', () => {
    const report = auditCompleteness(input({ newTimeline: new Set() }));
    expect(report.missing).toEqual(['1']);
    expect(report.entries[0]).toMatchObject({ verdict: 'missing', detail: 'event not in the new room timeline' });
  });

  it('accepts a message left in an old room only when its source event is verified redacted', () => {
    const current = new Map([
      ['1', { roomId: OLD, eventId: '$o1' }],
      ['2', { roomId: OLD, eventId: '$o2' }],
      ['3', { roomId: OLD, eventId: '$o3' }],
    ]);
    const baseline = ['1', '2', '3'].map((msgId) => ({ msgId, eventId: `$o${msgId}`, direction: 'inbound', ts: 2 }));
    const sources = new Map([
      ['1', { state: 'redacted' as const, redactedBy: '@ghost:beeper.local', reason: 'Recalled on Zalo', ts: 9 }],
      ['2', { state: 'present' as const }],
      ['3', { state: 'unreadable' as const, error: 'M_FORBIDDEN' }],
    ]);
    const report = auditCompleteness(input({ current, baseline, sources }));
    expect(report.counts).toMatchObject({ redacted: 1, missing: 2 });
    expect(report.entries.find((entry) => entry.msgId === '1')).toMatchObject({
      verdict: 'redacted',
      detail: 'redacted by @ghost:beeper.local (Recalled on Zalo)',
    });
    expect(report.missing).toEqual(['2', '3']);
  });

  it('treats rows that never had an event (delete/recall markers) as markers', () => {
    const report = auditCompleteness(
      input({ baseline: [{ msgId: '7', eventId: null, direction: 'inbound', ts: 3 }], current: new Map() }),
    );
    expect(report.counts.marker).toBe(1);
    expect(report.missing).toEqual([]);
  });

  it('reports a baseline message gone from the store as missing unless the owner accepted it', () => {
    const baseline = [
      { msgId: '8', eventId: '$o8', direction: 'outbound', ts: 4 },
      { msgId: '9', eventId: '$o9', direction: 'outbound', ts: 5 },
    ];
    const report = auditCompleteness(input({ baseline, current: new Map(), accepted: new Set(['9']) }));
    expect(report.missing).toEqual(['8']);
    expect(report.entries.find((entry) => entry.msgId === '8')?.detail).toBe('not in the store any more');
    expect(report.entries.find((entry) => entry.msgId === '9')?.verdict).toBe('accepted');
  });

  it('reports a message mapped to a room outside the audit as missing', () => {
    const report = auditCompleteness(
      input({ current: new Map([['1', { roomId: '!other:beeper.local', eventId: '$x' }]]) }),
    );
    expect(report.entries[0]).toMatchObject({ verdict: 'missing', detail: 'mapped to !other:beeper.local' });
  });

  it('reports a media message that arrived in the new room as text as missing', () => {
    const report = auditCompleteness(input({ kinds: new Map([['1', { old: 'm.image', new: 'm.text' }]]) }));
    expect(report.missing).toEqual(['1']);
    expect(report.entries[0]).toMatchObject({ verdict: 'missing', detail: 'm.image became m.text in the new room' });
  });

  it('reports media that became text while its old-room event could not be decrypted as missing', () => {
    const report = auditCompleteness(input({ unverifiedMedia: new Set(['1']) }));
    expect(report.missing).toEqual(['1']);
    expect(report.entries[0]).toMatchObject({
      verdict: 'missing',
      detail: 'media became text; the old-room event could not be decrypted',
    });
    expect(auditCompleteness(input({ unverifiedMedia: new Set(['1']), accepted: new Set(['1']) })).missing).toEqual([]);
    expect(auditCompleteness(input({ unverifiedMedia: new Set(['1']), recalled: new Set(['1']) })).missing).toEqual([]);
  });

  it('audits rows a rebuild moved out of the old rooms (no baseline) and blocks on their media', () => {
    const report = auditCompleteness(
      input({
        baseline: [],
        oldRows: [{ msgId: '1', eventId: '$o1', direction: 'inbound', ts: 1 }],
        kinds: new Map([['1', { old: 'm.image', new: 'm.text' }]]),
      }),
    );
    expect(report.entries).toHaveLength(1);
    expect(report.missing).toEqual(['1']);
  });

  it('counts a media message the export records as recalled on Zalo as redacted, not missing', () => {
    const kinds = new Map([['1', { old: 'm.image', new: 'm.notice' }]]);
    const report = auditCompleteness(input({ kinds, recalled: new Set(['1']) }));
    expect(report.missing).toEqual([]);
    expect(report.entries[0]).toMatchObject({ verdict: 'redacted', detail: 'recalled on Zalo (export)' });
  });

  it('counts media carried as media, text carried as text, and accepted downgrades', () => {
    const kinds = new Map([['1', { old: 'm.video', new: 'm.video' }]]);
    expect(auditCompleteness(input({ kinds })).counts.carried).toBe(1);
    const text = new Map([['1', { old: 'm.text', new: 'm.text' }]]);
    expect(auditCompleteness(input({ kinds: text })).counts.carried).toBe(1);
    const downgraded = new Map([['1', { old: 'm.file', new: 'm.text' }]]);
    expect(auditCompleteness(input({ kinds: downgraded, accepted: new Set(['1']) })).counts.accepted).toBe(1);
  });

  it('audits old-room rows that the baseline lacks and sorts the entries by time', () => {
    const report = auditCompleteness(
      input({
        baseline: [{ msgId: '1', eventId: '$o1', direction: 'outbound', ts: 20 }],
        oldRows: [{ msgId: '5', eventId: '$o5', direction: 'inbound', ts: 10 }],
        current: new Map([
          ['1', { roomId: NEW, eventId: '$n1' }],
          ['5', { roomId: OLD, eventId: '$o5' }],
        ]),
      }),
    );
    expect(report.entries.map((entry) => entry.msgId)).toEqual(['5', '1']);
    expect(report.missing).toEqual(['5']);
  });
});
