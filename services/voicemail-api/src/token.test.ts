import { describe, expect, it } from 'vitest';
import { mintToken, safeEqual, verifyToken } from './token.js';

const SECRET = 'x'.repeat(40);
const NOW = 1_800_000_000_000;

describe('tokens', () => {
  it('round-trips claims', () => {
    const token = mintToken(SECRET, { mailbox: '1001', ttlSeconds: 60, now: NOW });
    expect(token.startsWith('vm1.')).toBe(true);
    const r = verifyToken(SECRET, token, { now: NOW + 1000 });
    expect(r).toEqual({ ok: true, claims: { mbx: '1001', ctx: 'default', iat: NOW / 1000, exp: NOW / 1000 + 60 } });
  });

  it('rejects a wrong secret, tampered payload, expiry and too-long lifetimes', () => {
    const token = mintToken(SECRET, { mailbox: '1001', ttlSeconds: 60, now: NOW });
    expect(verifyToken('y'.repeat(40), token, { now: NOW })).toEqual({ ok: false, reason: 'signature' });
    const [p, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ mbx: '1002', ctx: 'default', exp: NOW / 1000 + 60 })).toString('base64url');
    expect(verifyToken(SECRET, `${p}.${forged}.${s}`, { now: NOW })).toEqual({ ok: false, reason: 'signature' });
    expect(verifyToken(SECRET, token, { now: NOW + 61_000 })).toEqual({ ok: false, reason: 'expired' });
    const long = mintToken(SECRET, { mailbox: '1001', ttlSeconds: 7 * 86400, now: NOW });
    expect(verifyToken(SECRET, long, { now: NOW, maxTtlSeconds: 86400 })).toEqual({ ok: false, reason: 'ttl' });
    expect(verifyToken(SECRET, 'garbage', { now: NOW })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyToken(SECRET, 'vm1..', { now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('compares static tokens safely', () => {
    expect(safeEqual('abcdefgh', 'abcdefgh')).toBe(true);
    expect(safeEqual('abcdefgh', 'abcdefgX')).toBe(false);
    expect(safeEqual('abc', 'abcdefgh')).toBe(false);
  });
});
