/**
 * IPC protocol between `NativeSipEngine` (JS, any host) and a native SIP
 * sidecar (baresip adapter today; a pjsua or other adapter could implement
 * the same protocol).
 *
 * Messages are plain JSON objects, so they survive structured clone (Electron
 * IPC, postMessage) and JSON-lines framing (stdio, TCP) alike. Three shapes:
 *
 *   engine  -> sidecar  { type: 'request',  id, cmd, ...args }
 *   sidecar -> engine   { type: 'response', id, ok: true, result? } | { type: 'response', id, ok: false, error }
 *   sidecar -> engine   { type: 'event', event, ...fields }
 *
 * Requests are answered exactly once. Events are facts (registration changed,
 * call ringing, DTMF received...) and are never answered.
 */
import type { DisconnectReason } from 'sipkit-core';

/** Bumped on breaking changes. The engine refuses a sidecar with another major version. */
export const NATIVE_PROTOCOL_VERSION = 1;

export type NativeSipTransportProtocol = 'udp' | 'tcp' | 'tls';

/** The SIP account a sidecar registers. */
export interface NativeAccount {
  username: string;
  /** Auth user if different from `username`. */
  authUsername?: string;
  password: string;
  displayName?: string;
  /** SIP domain (AOR host), e.g. "pbx.example.com". */
  domain: string;
  /** Registrar / proxy the stack sends everything to (host[:port]). */
  server: string;
  transport: NativeSipTransportProtocol;
  /** Optional outbound proxy (host[:port]); wins over `server` for routing. */
  outboundProxy?: string;
  /** REGISTER Expires, seconds. */
  registerExpires: number;
  dtmfMode: 'auto' | 'rfc2833' | 'info';
}

/** Commands and their arguments (engine -> sidecar). */
export type NativeCommand =
  | { cmd: 'hello'; protocol: number }
  | { cmd: 'start'; account: NativeAccount }
  | { cmd: 'stop' }
  | { cmd: 'register' }
  | { cmd: 'unregister' }
  | { cmd: 'call'; callId: string; target: string; headers?: string[] }
  | { cmd: 'answer'; callId: string }
  | { cmd: 'reject'; callId: string; code: number }
  | { cmd: 'hangup'; callId: string }
  | { cmd: 'hold'; callId: string; hold: boolean }
  | { cmd: 'mute'; callId: string; muted: boolean }
  | { cmd: 'dtmf'; callId: string; tones: string }
  | { cmd: 'transfer'; callId: string; target: string }
  | { cmd: 'attendedTransfer'; callId: string; toCallId: string };

export type NativeCommandName = NativeCommand['cmd'];

/** Optional features a sidecar implements, announced in the `hello` result. */
export interface NativeSidecarCapabilities {
  attendedTransfer: boolean;
  extraHeaders: boolean;
  tls: boolean;
}

/** Result of `hello`. */
export interface NativeHello {
  protocol: number;
  /** Human readable sidecar/stack name and version, e.g. "baresip 4.12.0". */
  sidecar: string;
  capabilities: NativeSidecarCapabilities;
}

export type NativeErrorCode =
  | 'unsupported' // the sidecar does not implement this command
  | 'unknown-call' // no call with that callId
  | 'not-started' // start() has not run (or stop() did)
  | 'invalid' // bad arguments
  | 'timeout' // the native stack did not answer in time
  | 'transport' // the link to the native stack is down
  | 'failed'; // the native stack refused / failed

export interface NativeError {
  code: NativeErrorCode;
  message: string;
}

/** Facts reported by the sidecar (sidecar -> engine). */
export type NativeEvent =
  /** Link between the sidecar and its SIP stack (and the stack's readiness). */
  | { event: 'transport'; state: 'connecting' | 'connected' | 'disconnected'; reason?: string }
  | {
      event: 'registration';
      state: 'registering' | 'registered' | 'unregistered' | 'failed';
      code?: number;
      reason?: string;
    }
  | {
      event: 'incoming';
      callId: string;
      remoteNumber: string;
      remoteDisplayName?: string;
      sipCallId?: string;
      autoAnswerDelay?: number;
    }
  | { event: 'ringing'; callId: string }
  | { event: 'early-media'; callId: string }
  | { event: 'connected'; callId: string; sipCallId?: string }
  | { event: 'remote-hold'; callId: string; held: boolean }
  | { event: 'ended'; callId: string; reason: DisconnectReason; code?: number }
  | { event: 'dtmf'; callId: string; digit: string }
  | { event: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export type NativeEventName = NativeEvent['event'];

export type NativeRequest = { type: 'request'; id: number } & NativeCommand;
export type NativeResponse =
  | { type: 'response'; id: number; ok: true; result?: unknown }
  | { type: 'response'; id: number; ok: false; error: NativeError };
export type NativeEventMessage = { type: 'event' } & NativeEvent;
export type NativeMessage = NativeRequest | NativeResponse | NativeEventMessage;

const COMMANDS: ReadonlySet<string> = new Set<NativeCommandName>([
  'hello',
  'start',
  'stop',
  'register',
  'unregister',
  'call',
  'answer',
  'reject',
  'hangup',
  'hold',
  'mute',
  'dtmf',
  'transfer',
  'attendedTransfer',
]);

const EVENTS: ReadonlySet<string> = new Set<NativeEventName>([
  'transport',
  'registration',
  'incoming',
  'ringing',
  'early-media',
  'connected',
  'remote-hold',
  'ended',
  'dtmf',
  'log',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted value as a protocol message (shape of the envelope and
 * the fields the receiver relies on). Returns undefined for anything else.
 */
export function asNativeMessage(value: unknown): NativeMessage | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case 'request':
      if (typeof value.id !== 'number' || typeof value.cmd !== 'string' || !COMMANDS.has(value.cmd))
        return undefined;
      if ('callId' in value && typeof value.callId !== 'string') return undefined;
      return value as unknown as NativeRequest;
    case 'response':
      if (typeof value.id !== 'number' || typeof value.ok !== 'boolean') return undefined;
      if (!value.ok && (!isRecord(value.error) || typeof value.error.message !== 'string'))
        return undefined;
      return value as unknown as NativeResponse;
    case 'event':
      if (typeof value.event !== 'string' || !EVENTS.has(value.event)) return undefined;
      if ('callId' in value && typeof value.callId !== 'string') return undefined;
      return value as unknown as NativeEventMessage;
    default:
      return undefined;
  }
}

/** Parse one JSON line (no trailing newline required). Undefined for invalid JSON or shape. */
export function parseNativeMessage(line: string): NativeMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return asNativeMessage(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

/** Serialize a message as one JSON line (with trailing "\n"). */
export function encodeNativeMessage(message: NativeMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Error thrown by the engine when the sidecar answers a request with ok: false. */
export class NativeSipError extends Error {
  constructor(
    readonly code: NativeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NativeSipError';
  }
}
