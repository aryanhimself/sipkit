/**
 * Parsing of click-to-dial URLs handed to the app by the OS (V2-DESK-03):
 * `tel:`, `sip:` / `sips:`, `callto:` and the app's own `sipkit:` scheme
 * (used by notification buttons on Windows, which can only activate a URL).
 *
 * Pure functions: no Electron imports, unit tested in dial-url.test.ts.
 */

/** Schemes the app registers with the OS for dialling. */
export const DIAL_SCHEMES = ['tel', 'sip', 'sips', 'callto'] as const;
/** The app's private scheme for actions (`sipkit://answer?call=…`). */
export const APP_SCHEME = 'sipkit';

export type DialScheme = (typeof DIAL_SCHEMES)[number];

export interface DialRequest {
  kind: 'dial';
  scheme: DialScheme | typeof APP_SCHEME;
  /** What to pass to `softphone.call()`: a number, an extension or `sip:user@host`. */
  target: string;
}

export interface AppActionRequest {
  kind: 'action';
  action: 'answer' | 'decline' | 'show';
  callId?: string;
}

export type ParsedAppUrl = DialRequest | AppActionRequest;

/** Longest target we accept (E.164 is 15 digits; SIP URIs are longer). */
export const MAX_TARGET_LENGTH = 128;

const URL_PREFIX = /^(tel|sips?|callto|sipkit):/i;
/** Visual separators allowed in phone numbers (RFC 3966 visual-separator + spaces). */
const VISUAL_SEPARATORS = /[\s().\-[\]]/g;
const PHONE_NUMBER = /^\+?[0-9*#]{1,32}$/;
/** RFC 3261 user part, conservative: unreserved + a few safe marks. */
const SIP_USER = /^[A-Za-z0-9_.!~*'()&=+$,;?/%-]{1,64}$/;
const SIP_HOST = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]{1,253})(:\d{1,5})?$/;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Strip visual separators from a phone number; null when it is not a dialable number. */
export function normalizePhoneNumber(raw: string): string | null {
  const compact = raw.replace(VISUAL_SEPARATORS, '');
  return PHONE_NUMBER.test(compact) ? compact : null;
}

export interface ParseOptions {
  /**
   * SIP domains / hosts that belong to the configured PBX. A `sip:` URI on one
   * of them dials just the user part (`sip:1002@pbx` → `1002`); others dial the
   * full URI.
   */
  localDomains?: readonly string[];
}

function hostOnly(hostPort: string): string {
  return hostPort.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

function parseSip(rest: string, scheme: 'sip' | 'sips', options: ParseOptions): DialRequest | null {
  // Drop URI parameters (;transport=…) and headers (?subject=…).
  const withoutHeaders = rest.split('?')[0] ?? '';
  const withoutParams = withoutHeaders.split(';')[0] ?? '';
  const at = withoutParams.lastIndexOf('@');
  const userRaw = at >= 0 ? withoutParams.slice(0, at) : withoutParams;
  const host = at >= 0 ? withoutParams.slice(at + 1) : '';
  // Strip a password ("user:pass@host" is deprecated; never forward it).
  const user = safeDecode(userRaw.split(':')[0] ?? '');
  if (!user) return null;
  if (!host) {
    const number = normalizePhoneNumber(user);
    if (number) return { kind: 'dial', scheme, target: number };
    return SIP_USER.test(user) ? { kind: 'dial', scheme, target: user } : null;
  }
  if (!SIP_HOST.test(host)) return null;
  const local = (options.localDomains ?? []).map(hostOnly).filter(Boolean);
  if (local.includes(hostOnly(host))) {
    const number = normalizePhoneNumber(user);
    if (number) return { kind: 'dial', scheme, target: number };
    return SIP_USER.test(user) ? { kind: 'dial', scheme, target: user } : null;
  }
  if (!SIP_USER.test(user)) return null;
  return { kind: 'dial', scheme, target: `${scheme}:${user}@${host}` };
}

function parseAppScheme(rest: string): ParsedAppUrl | null {
  // sipkit://answer?call=abc | sipkit:dial?number=1002
  const body = rest.replace(/^\/\//, '');
  const [pathRaw = '', query = ''] = body.split('?');
  const action = pathRaw.replace(/\/+$/, '').toLowerCase();
  const params = new URLSearchParams(query);
  if (action === 'dial') {
    const number = normalizePhoneNumber(params.get('number') ?? '');
    return number ? { kind: 'dial', scheme: APP_SCHEME, target: number } : null;
  }
  if (action === 'answer' || action === 'decline') {
    const callId = params.get('call') ?? undefined;
    if (callId !== undefined && !CALL_ID.test(callId)) return null;
    return callId ? { kind: 'action', action, callId } : { kind: 'action', action };
  }
  if (action === 'show' || action === '') return { kind: 'action', action: 'show' };
  return null;
}

/**
 * Parse one URL. Returns null for anything that is not a well-formed dial URL,
 * so callers can ignore random argv entries safely.
 *
 * - `tel:+1-555-123-4567;phone-context=…` → `+15551234567`
 * - `callto:1002`, `callto://+15551234567` → number
 * - `sip:1002@pbx.example.com` → `1002` when the host is local, else the full URI
 */
export function parseAppUrl(input: string, options: ParseOptions = {}): ParsedAppUrl | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value || value.length > 2048) return null;
  const match = URL_PREFIX.exec(value);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const rest = value.slice(match[0].length);

  let result: ParsedAppUrl | null = null;
  if (scheme === 'tel') {
    const decoded = safeDecode(rest.replace(/^\/\//, '').split(';')[0] ?? '');
    const number = decoded ? normalizePhoneNumber(decoded) : null;
    result = number ? { kind: 'dial', scheme: 'tel', target: number } : null;
  } else if (scheme === 'callto') {
    const body = rest.replace(/^\/\//, '').replace(/\/+$/, '');
    const decoded = safeDecode(body.split(/[?;]/)[0] ?? '');
    if (!decoded) return null;
    const number = normalizePhoneNumber(decoded);
    if (number) result = { kind: 'dial', scheme: 'callto', target: number };
    else if (decoded.includes('@')) {
      const sip = parseSip(decoded, 'sip', options);
      result = sip ? { ...sip, scheme: 'callto' } : null;
    } else result = SIP_USER.test(decoded) ? { kind: 'dial', scheme: 'callto', target: decoded } : null;
  } else if (scheme === 'sip' || scheme === 'sips') {
    result = parseSip(rest.replace(/^\/\//, ''), scheme, options);
  } else if (scheme === APP_SCHEME) {
    result = parseAppScheme(rest);
  }
  if (result?.kind === 'dial' && result.target.length > MAX_TARGET_LENGTH) return null;
  return result;
}

/**
 * Find the first app URL in a command line (Windows/Linux pass the URL as an
 * argument on launch and to `second-instance`). Flags and paths are skipped.
 */
export function findAppUrlInArgv(argv: readonly string[], options: ParseOptions = {}): ParsedAppUrl | null {
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue;
    const parsed = parseAppUrl(arg, options);
    if (parsed) return parsed;
  }
  return null;
}
