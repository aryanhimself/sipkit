import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Bearer tokens for the softphone-facing endpoints (subscribe / unsubscribe).
 *
 * A CRM backend that already knows which agent owns which extension mints a
 * short-lived token with the shared `PUSH_TOKEN_SECRET`:
 *
 *   skp1.<base64url(JSON {sub: "1001", exp: 1730000000, iat: ...})>.<base64url(HMAC-SHA256)>
 *
 * `sub` is the SIP extension the bearer may manage. Any language can mint one
 * (HMAC-SHA256 over "skp1.<payload>"), see docs/push.md.
 */

const PREFIX = 'skp1';

export interface TokenClaims {
  /** Extension the token is bound to. */
  sub: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Issued at, seconds since the epoch. */
  iat?: number;
}

const b64 = (data: string | Buffer) => Buffer.from(data).toString('base64url');

function sign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Mint a token for `extension`, valid for `ttlSeconds` (default 12 h). */
export function mintToken(secret: string, extension: string, ttlSeconds = 12 * 3600, now = Date.now()): string {
  if (!secret) throw new Error('PUSH_TOKEN_SECRET is empty');
  const iat = Math.floor(now / 1000);
  const payload = b64(JSON.stringify({ sub: extension, iat, exp: iat + ttlSeconds } satisfies TokenClaims));
  const body = `${PREFIX}.${payload}`;
  return `${body}.${sign(secret, body)}`;
}

/** Verify a minted token. Returns the claims, or null when invalid / expired. */
export function verifyToken(secret: string, token: string, now = Date.now()): TokenClaims | null {
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const body = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(sign(secret, body), parts[2]!)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Partial<TokenClaims>;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 <= now) return null;
    return { sub: claims.sub, exp: claims.exp, iat: claims.iat };
  } catch {
    return null;
  }
}

/** Per-call signature that lets the service worker decline one call without the agent's token. */
export function signCallAction(secret: string, action: string, callId: string, extension: string, exp: number): string {
  return sign(secret, `call-action|${action}|${callId}|${extension}|${exp}`);
}

export function verifyCallAction(
  secret: string,
  action: string,
  callId: string,
  extension: string,
  exp: number,
  sig: string,
  now = Date.now(),
): boolean {
  if (!secret || !Number.isFinite(exp) || exp * 1000 <= now) return false;
  return safeEqual(signCallAction(secret, action, callId, extension, exp), sig);
}
