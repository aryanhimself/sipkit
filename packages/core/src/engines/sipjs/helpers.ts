/**
 * Pure helpers for the SIP.js engine (no SIP.js imports, unit-testable).
 */
import type { ResolvedConfig } from '../../config';
import type { DisconnectReason } from '../../types';

/** Extract the host from "host", "host:port", "sip:host:port;transport=udp" or "[v6]:port". */
export function hostOf(server: string): string {
  let s = server.trim().replace(/^sips?:/i, '');
  s = s.split(';')[0] ?? s;
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  if (s.startsWith('[')) return s.slice(0, s.indexOf(']') + 1);
  return s.split(':')[0] ?? s;
}

/**
 * The SIP domain used in our AOR and in request URIs.
 *
 * ASSUMPTION (transportMode 'sip-gateway'): the browser still speaks SIP over
 * WebSocket — to the gateway's WSS URL — but the gateway is a transparent
 * WebRTC<->SIP bridge that routes on the Request-URI. So the AOR
 * (sip:user@domain) and every call target use the host of `sipServer`, the
 * plain-SIP server behind the gateway, when it is configured. Gateways that
 * instead expect their own domain should be configured with transportMode
 * 'webrtc' and an explicit `domain`.
 */
export function resolveSipDomain(cfg: ResolvedConfig): string {
  if (cfg.transportMode === 'sip-gateway' && cfg.sipServer) return hostOf(cfg.sipServer);
  return cfg.domain;
}

/** Build a SIP URI string for a dial target ("1002", "1002@host", "sip:..." ). */
export function buildTargetUri(target: string, domain: string): string {
  const t = target.trim();
  if (/^sips?:/i.test(t)) return t;
  const escapeUser = (user: string) => user.replace(/#/g, '%23').replace(/\s/g, '');
  if (t.includes('@')) {
    const at = t.lastIndexOf('@');
    return `sip:${escapeUser(t.slice(0, at))}@${t.slice(at + 1)}`;
  }
  return `sip:${escapeUser(t)}@${domain}`;
}

/** Map a final SIP failure response code to a DisconnectReason. */
export function reasonFromCode(code: number | undefined): DisconnectReason {
  switch (code) {
    case 486:
    case 600:
      return 'busy';
    case 603:
      return 'rejected';
    case 408:
    case 480:
      return 'no-answer';
    case 487:
      return 'cancelled';
    default:
      return 'failed';
  }
}

/**
 * Detect server/peer requested auto-answer from INVITE headers.
 * Returns the delay in seconds, or undefined if no auto-answer was requested.
 * Supported: Call-Info answer-after=N, Alert-Info (auto-answer / info=alert-autoanswer
 * [;delay=N]), Answer-Mode / Priv-Answer-Mode: Auto (RFC 5373),
 * X-P-Auto-Answer, X-Answer-Mode: auto, Auto-Answer.
 */
export function parseAutoAnswer(getHeader: (name: string) => string | undefined): number | undefined {
  const callInfo = getHeader('Call-Info');
  const answerAfter = callInfo?.match(/answer-after\s*=\s*(\d+)/i);
  if (answerAfter?.[1] !== undefined) return Number(answerAfter[1]);

  const alertInfo = getHeader('Alert-Info');
  if (alertInfo && /auto[-_ ]?answer|answer-after/i.test(alertInfo)) {
    const delay = alertInfo.match(/(?:delay|answer-after)\s*=\s*(\d+)/i);
    return delay?.[1] !== undefined ? Number(delay[1]) : 0;
  }

  for (const name of ['Answer-Mode', 'Priv-Answer-Mode', 'X-Answer-Mode']) {
    if (/\bauto\b/i.test(getHeader(name) ?? '')) return 0;
  }
  for (const name of ['X-P-Auto-Answer', 'Auto-Answer']) {
    const value = getHeader(name)?.trim();
    if (value && !/^(no|false|0|off)$/i.test(value)) return 0;
  }
  return undefined;
}

/**
 * Whether an SDP offer puts us on hold (sendonly / inactive / 0.0.0.0).
 * Returns undefined for an empty body (re-INVITE without SDP).
 */
export function sdpIndicatesHold(sdp: string | undefined): boolean | undefined {
  if (!sdp || !sdp.trim()) return undefined;
  const audio = sdp.split(/\r?\nm=/).find((section) => section.startsWith('audio')) ?? sdp;
  const session = sdp.split(/\r?\nm=/)[0] ?? '';
  const direction = (text: string) => text.match(/^a=(sendrecv|sendonly|recvonly|inactive)\s*$/m)?.[1];
  const dir = direction(audio) ?? direction(session) ?? 'sendrecv';
  if (dir === 'sendonly' || dir === 'inactive') return true;
  return /^c=IN IP4 0\.0\.0\.0\s*$/m.test(audio) || /^c=IN IP4 0\.0\.0\.0\s*$/m.test(session);
}

/** Parse a DTMF digit from an INFO body (application/dtmf-relay or application/dtmf). */
export function parseInfoDtmf(body: string | undefined, contentType: string | undefined): string | undefined {
  if (!body) return undefined;
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('application/dtmf-relay') || /signal\s*=/i.test(body)) {
    const digit = body.match(/signal\s*=\s*([0-9A-D*#])/i)?.[1];
    return digit?.toUpperCase();
  }
  if (type.includes('application/dtmf')) {
    const digit = body.trim();
    if (/^[0-9A-D*#]$/i.test(digit)) return digit.toUpperCase();
    // RFC 4733 event codes 10/11 = * / #
    if (digit === '10') return '*';
    if (digit === '11') return '#';
  }
  return undefined;
}

/** application/dtmf-relay body for a single tone. */
export function dtmfRelayBody(tone: string, durationMs = 160): string {
  return `Signal=${tone}\r\nDuration=${durationMs}\r\n`;
}

/** Exponential reconnection backoff: base * 2^(attempt-1), capped. */
export function backoffDelayMs(attempt: number, baseSeconds: number, maxSeconds = 60): number {
  const exp = Math.min(baseSeconds * 2 ** Math.max(0, attempt - 1), maxSeconds);
  return Math.round(exp * 1000);
}

/** Race a promise-producing executor against a timeout; the timer is always cleared. */
export function withTimeout<T>(
  run: (resolve: (value: T) => void, reject: (error: unknown) => void) => void,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    run(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Sleep that rejects when the signal aborts (used for INFO DTMF pacing). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The INVITE headers a host asked for (config `inviteHeaders`), by lower-cased name, values trimmed and
 * capped at 256 characters. Undefined when none is present.
 */
export function pickHeaders(
  names: readonly string[],
  getHeader: (name: string) => string | undefined,
): Record<string, string> | undefined {
  let out: Record<string, string> | undefined;
  for (const name of names) {
    const value = getHeader(name)?.trim();
    if (!value) continue;
    (out ??= {})[name.toLowerCase()] = value.slice(0, 256);
  }
  return out;
}
