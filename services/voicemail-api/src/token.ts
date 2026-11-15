import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived, per-mailbox bearer tokens signed with a shared secret
 * (HMAC-SHA256), so a CRM backend can hand the browser a token for exactly one
 * mailbox without this service knowing about CRM users.
 *
 *   vm1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, "vm1." + payload))>
 *
 * Claims: `mbx` mailbox, `ctx` voicemail context, `exp` expiry (epoch seconds),
 * optional `iat`. Minting is ~10 lines in any language (see docs/voicemail.md).
 */
export interface TokenClaims {
  mbx: string;
  ctx: string;
  exp: number;
  iat?: number;
}

const PREFIX = 'vm1';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export interface MintOptions {
  mailbox: string;
  context?: string;
  /** Lifetime in seconds (default 1 hour). */
  ttlSeconds?: number;
  /** Clock override for tests (ms). */
  now?: number;
}

export function mintToken(secret: string, opts: MintOptions): string {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: TokenClaims = {
    mbx: opts.mailbox,
    ctx: opts.context ?? 'default',
    iat,
    exp: iat + (opts.ttlSeconds ?? 3600),
  };
  const payload = b64url(JSON.stringify(claims));
  const data = `${PREFIX}.${payload}`;
  return `${data}.${b64url(sign(secret, data))}`;
}

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'ttl' };

/**
 * Verify signature and expiry. `maxTtlSeconds` rejects tokens whose expiry is
 * further away than that, so a leaked secret-holder cannot mint "forever" tokens
 * by accident.
 */
export function verifyToken(
  secret: string,
  token: string,
  opts: { now?: number; maxTtlSeconds?: number } = {},
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: 'malformed' };
  const data = `${parts[0]}.${parts[1]}`;
  const expected = sign(secret, data);
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.mbx !== 'string' || typeof claims.ctx !== 'string' || typeof claims.exp !== 'number')
    return { ok: false, reason: 'malformed' };
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (claims.exp <= now) return { ok: false, reason: 'expired' };
  if (opts.maxTtlSeconds !== undefined && claims.exp - now > opts.maxTtlSeconds) return { ok: false, reason: 'ttl' };
  return { ok: true, claims };
}

/** Constant-time string comparison (static tokens). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still spend the time of a comparison.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
