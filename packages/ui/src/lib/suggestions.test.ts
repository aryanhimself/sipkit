import { describe, expect, it } from 'vitest';
import type { Cdr } from 'sipkit-core';
import { buildDialSuggestions } from './suggestions';

let seq = 0;
function cdr(peer: string, direction: 'outgoing' | 'incoming' = 'outgoing', startedAt = ++seq): Cdr {
  return {
    callId: `c${seq}`,
    line: 1,
    direction,
    caller: direction === 'outgoing' ? '1000' : peer,
    called: direction === 'outgoing' ? peer : '1000',
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    reason: 'local-hangup',
  };
}

describe('buildDialSuggestions', () => {
  it('returns nothing for an empty query', () => {
    expect(buildDialSuggestions('', [cdr('1002')], [])).toEqual([]);
  });

  it('completes from history by leading digits, newest and most-called first', () => {
    const history = [cdr('9842477272'), cdr('9841429506'), cdr('9841429506'), cdr('1002')];
    const out = buildDialSuggestions('984', history, []);
    expect(out.map((s) => s.number)).toEqual(['9841429506', '9842477272']);
    expect(out[0]).toMatchObject({ source: 'recent', calls: 2 });
  });

  it('ignores formatting and matches digits in the middle once 3+ are typed', () => {
    const out = buildDialSuggestions('247 7', [cdr('+977 984-247-7272')], []);
    expect(out.map((s) => s.number)).toEqual(['+977 984-247-7272']);
    expect(buildDialSuggestions('24', [cdr('9842477272')], [])).toEqual([]);
  });

  it('merges contacts with history and shows the contact name', () => {
    const out = buildDialSuggestions(
      '98',
      [cdr('9842477272', 'incoming')],
      [{ id: 'a', name: 'Anish', number: '984-247-7272', description: 'Support' }],
    );
    expect(out).toEqual([
      expect.objectContaining({ number: '984-247-7272', name: 'Anish', source: 'contact', calls: 1 }),
    ]);
  });

  it('leaves out an exact match, your own extension, and respects the limit', () => {
    const history = ['1001', '1002', '1003', '1004', '1005', '1006', '1007'].map((n) => cdr(n));
    expect(buildDialSuggestions('1002', history, []).map((s) => s.number)).toEqual([]);
    const out = buildDialSuggestions('10', history, [], { self: '1001', limit: 3 });
    expect(out).toHaveLength(3);
    expect(out.some((s) => s.number === '1001')).toBe(false);
  });

  it('matches contact names when letters are typed', () => {
    const out = buildDialSuggestions('ani', [], [{ id: 'a', name: 'Anish', number: '1002' }]);
    expect(out.map((s) => s.name)).toEqual(['Anish']);
  });
});
