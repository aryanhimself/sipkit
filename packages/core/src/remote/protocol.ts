/**
 * Wire protocol between a softphone host (the one real instance) and its
 * remote clients (pages, other tabs, the extension popup). See
 * docs/shared-instance.md and docs/browser-extension.md.
 *
 * Every message is a plain JSON object tagged with `p` (namespace) and `v`
 * (version). Receivers validate everything: messages can come from other
 * tabs, other scripts on the page or (for the extension) a less trusted world.
 * Credentials never cross this protocol: hosts send {@link publicConfig}.
 */
import type { ResolvedConfig, SoftphoneConfigInput } from '../config';
import type { AudioDeviceKind, Cdr, SoftphoneEvents, SoftphoneSnapshot } from '../types';

export const REMOTE_PROTOCOL = 'sipkit/remote';
export const REMOTE_PROTOCOL_VERSION = 1;

/** Where the instance a client talks to lives. */
export type RemoteHostKind = 'extension' | 'web' | 'local';

export interface RemoteHostInfo {
  kind: RemoteHostKind;
  /** Engine name of the host instance (e.g. "sipjs-webrtc", "mock-engine"). */
  engine: string;
  /** Free-form host version (extension version, package version). */
  version?: string;
  /** Debug helpers (mock engine only) the host accepts through the `debug` command. */
  debug?: string[];
}

interface Envelope {
  p: typeof REMOTE_PROTOCOL;
  v: typeof REMOTE_PROTOCOL_VERSION;
}

// ---- client → host ---------------------------------------------------------
export interface HelloMessage extends Envelope {
  type: 'hello';
  clientId: string;
}
export interface CommandMessage extends Envelope {
  type: 'command';
  id: number;
  name: RemoteCommandName;
  args: unknown[];
}
export interface ClientByeMessage extends Envelope {
  type: 'bye';
  clientId?: string;
}

// ---- host → client ---------------------------------------------------------
export interface WelcomeMessage extends Envelope {
  type: 'welcome';
  sessionId: string;
  host: RemoteHostInfo;
  snapshot: SoftphoneSnapshot;
  config: SoftphoneConfigInput;
  cdrs: Cdr[];
}
export interface StateMessage extends Envelope {
  type: 'state';
  snapshot: SoftphoneSnapshot;
}
export interface ConfigMessage extends Envelope {
  type: 'config';
  config: SoftphoneConfigInput;
}
export interface EventMessage extends Envelope {
  type: 'event';
  name: RemoteEventName;
  payload: unknown;
}
export interface ResultMessage extends Envelope {
  type: 'result';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { message: string; code?: string };
}
export interface HostByeMessage extends Envelope {
  type: 'host-bye';
  reason?: string;
}

export type ClientMessage = HelloMessage | CommandMessage | ClientByeMessage;
export type HostMessage = WelcomeMessage | StateMessage | ConfigMessage | EventMessage | ResultMessage | HostByeMessage;
export type RemoteMessage = ClientMessage | HostMessage;

const CLIENT_TYPES = new Set(['hello', 'command', 'bye']);
const HOST_TYPES = new Set(['welcome', 'state', 'config', 'event', 'result', 'host-bye']);

/** Build a message with the envelope fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function remoteMessage<T extends RemoteMessage = RemoteMessage>(body: DistributiveOmit<T, 'p' | 'v'>): T {
  return { p: REMOTE_PROTOCOL, v: REMOTE_PROTOCOL_VERSION, ...body } as unknown as T;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Envelope + known type. Does not validate the body. */
export function isRemoteMessage(v: unknown): v is RemoteMessage {
  return (
    isObject(v) &&
    v.p === REMOTE_PROTOCOL &&
    v.v === REMOTE_PROTOCOL_VERSION &&
    typeof v.type === 'string' &&
    (CLIENT_TYPES.has(v.type) || HOST_TYPES.has(v.type))
  );
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A message a host accepts from a client (shape-checked). */
export function parseClientMessage(v: unknown): ClientMessage | null {
  if (!isRemoteMessage(v) || !CLIENT_TYPES.has(v.type)) return null;
  const m = v as unknown as Record<string, unknown>;
  if (m.type === 'hello') return typeof m.clientId === 'string' && ID_RE.test(m.clientId) ? (v as HelloMessage) : null;
  if (m.type === 'bye') return v as ClientByeMessage;
  // command
  if (typeof m.id !== 'number' || !Number.isSafeInteger(m.id) || m.id < 0) return null;
  if (typeof m.name !== 'string' || !Array.isArray(m.args)) return null;
  return validateCommand(m.name, m.args) ? (v as CommandMessage) : null;
}

/** A message a client accepts from its host (shape-checked). */
export function parseHostMessage(v: unknown): HostMessage | null {
  if (!isRemoteMessage(v) || !HOST_TYPES.has(v.type)) return null;
  const m = v as unknown as Record<string, unknown>;
  switch (m.type) {
    case 'welcome':
      return typeof m.sessionId === 'string' &&
        isObject(m.host) &&
        isSnapshotLike(m.snapshot) &&
        isObject(m.config) &&
        Array.isArray(m.cdrs)
        ? (v as WelcomeMessage)
        : null;
    case 'state':
      return isSnapshotLike(m.snapshot) ? (v as StateMessage) : null;
    case 'config':
      return isObject(m.config) ? (v as ConfigMessage) : null;
    case 'event':
      return typeof m.name === 'string' && REMOTE_EVENTS.has(m.name as RemoteEventName) ? (v as EventMessage) : null;
    case 'result':
      return typeof m.id === 'number' && typeof m.ok === 'boolean' ? (v as ResultMessage) : null;
    default:
      return v as HostByeMessage;
  }
}

function isSnapshotLike(v: unknown): v is SoftphoneSnapshot {
  return (
    isObject(v) &&
    typeof v.app === 'string' &&
    isObject(v.registration) &&
    typeof v.registration.state === 'string' &&
    Array.isArray(v.calls) &&
    v.calls.every((c) => isObject(c) && typeof c.id === 'string' && typeof c.state === 'string')
  );
}

// ---------------------------------------------------------------------------
// Commands: the whitelist a host executes for a remote client.
// ---------------------------------------------------------------------------

type ArgCheck = (v: unknown) => boolean;

const str =
  (max = 256): ArgCheck =>
  (v) =>
    typeof v === 'string' && v.length > 0 && v.length <= max;
const opt =
  (check: ArgCheck): ArgCheck =>
  (v) =>
    v === undefined || v === null || check(v);
const bool: ArgCheck = (v) => typeof v === 'boolean';
const callId = str(128);
const optCallId = opt(callId);
const strOrList: ArgCheck = (v) => str(256)(v) || (Array.isArray(v) && v.length <= 200 && v.every(str(256)));
const kinds: AudioDeviceKind[] = ['microphone', 'speaker', 'ringer', 'camera'];
const deviceKind: ArgCheck = (v) => kinds.includes(v as AudioDeviceKind);
const videoOptions: ArgCheck = opt((v) => isObject(v) && Object.keys(v).every((k) => k === 'video') && (v.video === undefined || typeof v.video === 'boolean'));
const dtmf: ArgCheck = (v) => typeof v === 'string' && /^[0-9A-Da-d*#,]{1,64}$/.test(v);
const sipStatus: ArgCheck = opt((v) => typeof v === 'number' && Number.isInteger(v) && v >= 400 && v <= 699);
const volume: ArgCheck = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const configPatch: ArgCheck = (v) => isObject(v);
const anyArgs: ArgCheck = (v) => Array.isArray(v) && v.length <= 8;

/**
 * Commands remote clients may send, with argument checks. Lifecycle (`start`,
 * `stop`), plugins and MediaStream/Blob methods are deliberately missing:
 * the host owns the instance, and those values cannot cross a message channel.
 */
export const REMOTE_COMMANDS = {
  register: [],
  unregister: [],
  /** Provisioning; the host decides what (if anything) to apply. See `RemoteHostOptions.onUpdateConfig`. */
  updateConfig: [configPatch],
  call: [str(256), videoOptions],
  answer: [optCallId, videoOptions],
  reject: [optCallId, sipStatus],
  forward: [str(256), optCallId],
  hangup: [optCallId],
  hangupAll: [],
  hold: [bool, optCallId],
  mute: [bool, optCallId],
  sendDtmf: [dtmf, optCallId],
  transfer: [str(256), optCallId],
  startAttendedTransfer: [str(256), optCallId],
  completeAttendedTransfer: [callId, callId],
  conference: [opt((v) => Array.isArray(v) && v.length <= 16 && v.every(callId))],
  removeFromConference: [callId],
  splitConference: [optCallId],
  setPartyMuted: [callId, bool],
  setActiveCall: [callId],
  setDnd: [bool],
  callVoicemail: [],
  watch: [strOrList],
  unwatch: [strOrList],
  pickup: [str(64)],
  sendMessage: [str(256), str(4096)],
  markConversationRead: [str(256)],
  deleteConversation: [str(256)],
  listDevices: [],
  setDevice: [deviceKind, str(512)],
  setVolume: [deviceKind, volume],
  setVideo: [bool, optCallId],
  refreshVoicemails: [],
  markVoicemailRead: [str(256)],
  deleteVoicemail: [str(256)],
  /** Mock engine helpers (`simulateIncomingCall`...), only when the host lists them in `host.debug`. */
  debug: [str(64), anyArgs],
} as const satisfies Record<string, readonly ArgCheck[]>;

export type RemoteCommandName = keyof typeof REMOTE_COMMANDS;

export function isRemoteCommandName(name: unknown): name is RemoteCommandName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(REMOTE_COMMANDS, name);
}

/** True when `name` is whitelisted and `args` pass its checks (extra args are refused). */
export function validateCommand(name: unknown, args: unknown[]): name is RemoteCommandName {
  if (!isRemoteCommandName(name)) return false;
  const spec: readonly ArgCheck[] = REMOTE_COMMANDS[name];
  if (args.length > spec.length) return false;
  return spec.every((check, i) => check(args[i]));
}

// ---------------------------------------------------------------------------
// Events forwarded to clients (`state:changed` is rebuilt from `state`; `log` stays local).
// ---------------------------------------------------------------------------

export type RemoteEventName = Exclude<keyof SoftphoneEvents, 'state:changed' | 'log'>;

export const REMOTE_EVENTS = new Set<RemoteEventName>([
  'app:state',
  'registration:state',
  'call:created',
  'call:updated',
  'call:ended',
  'call:dtmf-received',
  'call:quality',
  'cdr',
  'notification',
  'voicemail:updated',
  'voicemail:list',
  'dnd:changed',
  'presence:changed',
  'message:received',
  'message:status',
  'conversation:read',
  'call:video',
  'push:changed',
  'push:action',
  // Reload continuity (V2-RESUME-01): clients show "Reconnecting…" too.
  'registration:resuming',
  'call:resumed',
]);

// ---------------------------------------------------------------------------
// Sanitising: what may leave the host.
// ---------------------------------------------------------------------------

const SECRET_KEY = /pass(word)?|secret|token|credential|authorization/i;
/** Keys removed wherever they appear (they can carry credentials). */
const SECRET_KEYS = new Set(['registerHeaders', 'extraHeaders', 'getToken', 'credentialsProvider', 'ha1']);

function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  if (!isObject(value)) return typeof value === 'function' ? undefined : value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k) || SECRET_KEY.test(k) || typeof v === 'function') continue;
    out[k] = stripSecrets(v, depth + 1);
  }
  return out;
}

/**
 * The config a host shares with clients: everything the UI needs (brand,
 * username, feature switches, voicemail/chat/presence flags...) and no
 * secrets. Removes passwords, tokens, TURN credentials, register/extra
 * headers and callbacks, at any depth.
 */
export function publicConfig(cfg: ResolvedConfig | SoftphoneConfigInput): SoftphoneConfigInput {
  const plain = stripSecrets(JSON.parse(JSON.stringify(cfg, (_k, v: unknown) => (typeof v === 'function' ? undefined : v))));
  return plain as SoftphoneConfigInput;
}

function jsonSafe(v: unknown, maxLength: number): Record<string, unknown> {
  try {
    const s = JSON.stringify(v ?? {});
    return s.length <= maxLength ? (JSON.parse(s) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The snapshot a host shares: JSON-safe (`call.meta` kept only when it
 * serialises within 8 KB, so attended transfer and CRM slots still work) and
 * without the Web Push subscription (that belongs to the host browser).
 */
export function sanitizeSnapshot(s: SoftphoneSnapshot): SoftphoneSnapshot {
  const { push: _push, ...rest } = s;
  return {
    ...rest,
    calls: s.calls.map((c) => ({ ...c, meta: jsonSafe(c.meta, 8192) })),
  };
}

/** Config keys a client may provision with `updateConfig` (credentials and transport only). */
export const PROVISION_KEYS = [
  'websocketUrls',
  'username',
  'password',
  'authUsername',
  'displayName',
  'domain',
  'registerHeaders',
  'transportMode',
  'sipServer',
  'sipTransport',
  'autoRegister',
] as const;

/** Keep only {@link PROVISION_KEYS} with plausible value types. */
export function pickProvisioning(patch: unknown): SoftphoneConfigInput {
  if (!isObject(patch)) return {};
  const out: Record<string, unknown> = {};
  for (const key of PROVISION_KEYS) {
    const v = patch[key];
    if (v === undefined) continue;
    if (key === 'websocketUrls' || key === 'registerHeaders') {
      if (Array.isArray(v) && v.length <= 16 && v.every((x) => typeof x === 'string' && x.length <= 2048)) out[key] = v;
    } else if (key === 'autoRegister') {
      if (typeof v === 'boolean') out[key] = v;
    } else if (typeof v === 'string' && v.length <= 1024) out[key] = v;
  }
  return out as SoftphoneConfigInput;
}
