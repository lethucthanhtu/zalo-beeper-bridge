import { describe, expect, it } from 'vitest';
import { buildInboundMentions, parseOutboundMentions } from '../mentions.ts';

describe('buildInboundMentions (Zalo → Matrix)', () => {
  /** Test resolver: "own" → owner MXID, anything else → that uid's ghost MXID. */
  const resolve = (uid: string) => (uid === 'own' ? '@owner:beeper.com' : `@sh-zalo_${uid}:beeper.local`);

  it('wraps mentions in matrix.to pills and collects user_ids', () => {
    const text = 'hi @Tuan and @Binh';
    const mentions = [
      { uid: '111', pos: 3, len: 5 }, // "@Tuan"
      { uid: '222', pos: 13, len: 5 }, // "@Binh"
    ];
    const result = buildInboundMentions(text, mentions, resolve);
    expect(result.userIds).toEqual(['@sh-zalo_111:beeper.local', '@sh-zalo_222:beeper.local']);
    expect(result.formattedBody).toBe(
      'hi <a href="https://matrix.to/#/@sh-zalo_111:beeper.local">@Tuan</a> and <a href="https://matrix.to/#/@sh-zalo_222:beeper.local">@Binh</a>',
    );
  });

  it('escapes HTML in the surrounding text', () => {
    const result = buildInboundMentions('a <b> @X', [{ uid: '1', pos: 6, len: 2 }], resolve);
    expect(result.formattedBody).toContain('a &lt;b&gt; ');
  });

  it('ignores out-of-range mentions', () => {
    const result = buildInboundMentions('short', [{ uid: '1', pos: 10, len: 5 }], resolve);
    expect(result.userIds).toEqual([]);
    expect(result.formattedBody).toBe('short');
  });
});

describe('parseOutboundMentions (Matrix → Zalo)', () => {
  /** Test resolver: owner MXID → "own", ghost MXID → its uid, anything else → null (not bridged). */
  const resolveUid = (mxid: string) => {
    if (mxid === '@owner:beeper.com') return 'own';
    const ghostMatch = /^@sh-zalo_(.+):/.exec(mxid);
    return ghostMatch ? ghostMatch[1]! : null;
  };

  it('maps pills back to Zalo uid + pos/len in the plain body', () => {
    const body = 'hi @Tuan bye';
    const formattedBody = 'hi <a href="https://matrix.to/#/%40sh-zalo_111%3Abeeper.local">@Tuan</a> bye';
    expect(parseOutboundMentions(body, formattedBody, resolveUid)).toEqual([{ uid: '111', pos: 3, len: 5 }]);
  });

  it('skips non-bridge pills', () => {
    const body = 'hey @someone';
    const formattedBody = 'hey <a href="https://matrix.to/#/%40real%3Abeeper.com">@someone</a>';
    expect(parseOutboundMentions(body, formattedBody, resolveUid)).toEqual([]);
  });

  it('returns [] with no formatted_body', () => {
    expect(parseOutboundMentions('plain', undefined, resolveUid)).toEqual([]);
  });
});
