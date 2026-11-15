/**
 * A SoftphoneApi that mirrors an instance running elsewhere (the browser
 * extension, the leader tab, or this tab's own instance through a loopback).
 * `sipkit-react` hooks and `sipkit-ui` work on it unchanged.
 */
import { resolveConfig, type ResolvedConfig, type SoftphoneConfigInput } from '../config';
import { TypedEmitter } from '../events';
import type { ChatMessage } from '../chat/types';
import type {
  AnswerOptions,
  AudioDevice,
  AudioDeviceKind,
  Call,
  CallId,
  CallOptions,
  CallVideoStreams,
  Cdr,
  SoftphoneApi,
  SoftphoneEvents,
  SoftphoneSnapshot,
  Unsubscribe,
} from '../types';
import type { PushState } from '../push/types';
import type { VoicemailMessage } from '../voicemail-list/types';
import { EMPTY_CHAT_STATE } from '../chat';
import { EMPTY_MESSAGE_SUMMARY } from '../internal/message-summary';
import {
  parseHostMessage,
  remoteMessage,
  type ClientByeMessage,
  type CommandMessage,
  type HelloMessage,
  type HostMessage,
  type RemoteCommandName,
  type RemoteHostInfo,
} from './protocol';
import type { RemoteTransport } from './transport';

export type RemoteStatus = 'connecting' | 'connected' | 'detached';

export interface RemoteSoftphoneOptions {
  /** Config used until the host's welcome arrives (only UI fields matter). */
  initialConfig?: SoftphoneConfigInput;
  /** Command timeout in ms (default 30 s). */
  commandTimeoutMs?: number;
  /** Stable id of this client (default random). */
  clientId?: string;
}

export interface RemoteConnectOptions {
  /** Reject when no welcome arrives in time (default 5 s). */
  timeoutMs?: number;
  /**
   * The same-tab instance behind a loopback transport (web leader tab).
   * Methods that cannot cross a channel (`plugin`, `getVideoStreams`,
   * `getVoicemailAudio`, Web Push) are then delegated to it.
   */
  local?: SoftphoneApi;
}

/** Error code of commands that failed because the host went away. */
export const HOST_UNAVAILABLE = 'HOST_UNAVAILABLE';

export class RemoteSoftphoneError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'RemoteSoftphoneError';
  }
}

function emptySnapshot(): SoftphoneSnapshot {
  return {
    app: 'loading',
    registration: { state: 'idle' },
    calls: [],
    activeCallId: null,
    devices: { available: [], selected: {} },
    engine: 'remote',
    voicemail: { ...EMPTY_MESSAGE_SUMMARY },
    dnd: false,
    presence: {},
    chat: EMPTY_CHAT_STATE,
  };
}

function randomId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RemoteSoftphone implements SoftphoneApi {
  readonly clientId: string;
  private snapshot: SoftphoneSnapshot = emptySnapshot();
  private cfg: ResolvedConfig;
  private cdrs: Cdr[] = [];
  private readonly emitter = new TypedEmitter<SoftphoneEvents>();
  private readonly listeners = new Set<(s: SoftphoneSnapshot) => void>();
  private readonly statusListeners = new Set<(s: RemoteStatus) => void>();
  private readonly historyListeners = new Set<() => void>();
  private transport: RemoteTransport | null = null;
  private transportOffs: Unsubscribe[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private local: SoftphoneApi | undefined;
  private hostInfo: RemoteHostInfo | null = null;
  private currentStatus: RemoteStatus = 'detached';
  private readonly timeoutMs: number;
  private readonly historyApi = {
    list: () => this.cdrs,
    subscribe: (l: () => void) => {
      this.historyListeners.add(l);
      return () => this.historyListeners.delete(l);
    },
  };

  constructor(options: RemoteSoftphoneOptions = {}) {
    this.clientId = options.clientId ?? randomId();
    this.timeoutMs = options.commandTimeoutMs ?? 30_000;
    this.cfg = safeResolve(options.initialConfig ?? {});
  }

  // ---- connection ----------------------------------------------------------

  get status(): RemoteStatus {
    return this.currentStatus;
  }

  /** The host this client is attached to (after the welcome). */
  get host(): RemoteHostInfo | null {
    return this.hostInfo;
  }

  onStatus(listener: (status: RemoteStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: RemoteStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    for (const l of [...this.statusListeners]) l(status);
  }

  /**
   * Attach to a host over `transport` (replacing any previous one) and wait
   * for its welcome. The last snapshot stays visible while (re)connecting, so
   * the UI does not flicker during a handover.
   */
  connect(transport: RemoteTransport, options: RemoteConnectOptions = {}): Promise<void> {
    this.detachTransport(new RemoteSoftphoneError('Reconnecting to another host', HOST_UNAVAILABLE));
    this.transport = transport;
    this.local = options.local;
    this.setStatus('connecting');
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        if (this.transport === transport) this.detachTransport(new RemoteSoftphoneError('Host did not answer', HOST_UNAVAILABLE));
        reject(new RemoteSoftphoneError('Host did not answer', HOST_UNAVAILABLE));
      }, options.timeoutMs ?? 5_000);
      const offWelcome = transport.onMessage((raw) => {
        const m = parseHostMessage(raw);
        if (m?.type === 'welcome') {
          cleanup();
          resolve();
        }
      });
      const offClose = transport.onClose(() => {
        cleanup();
        reject(new RemoteSoftphoneError('Host closed the connection', HOST_UNAVAILABLE));
      });
      const cleanup = () => {
        clearTimeout(timer);
        offWelcome();
        offClose();
      };
      this.transportOffs.push(
        transport.onMessage((raw) => this.handle(raw)),
        transport.onClose(() => {
          if (this.transport !== transport) return;
          this.detachTransport(new RemoteSoftphoneError('Host went away', HOST_UNAVAILABLE));
        }),
      );
      transport.send(remoteMessage<HelloMessage>({ type: 'hello', clientId: this.clientId }));
    });
  }

  /** Close the connection (the host instance keeps running). */
  disconnect(): void {
    const t = this.transport;
    if (t && !t.closed) t.send(remoteMessage<ClientByeMessage>({ type: 'bye', clientId: this.clientId }));
    this.detachTransport(new RemoteSoftphoneError('Disconnected', HOST_UNAVAILABLE));
    t?.close();
  }

  private detachTransport(reason: Error): void {
    this.transportOffs.forEach((off) => off());
    this.transportOffs = [];
    this.transport = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
    this.setStatus('detached');
  }

  private handle(raw: unknown): void {
    const m: HostMessage | null = parseHostMessage(raw);
    if (!m) return;
    switch (m.type) {
      case 'welcome':
        this.hostInfo = m.host;
        this.cfg = safeResolve(m.config);
        this.setCdrs(m.cdrs);
        this.setStatus('connected');
        this.setSnapshot(m.snapshot);
        return;
      case 'config':
        this.cfg = safeResolve(m.config);
        // Config identity changed: let hooks that read api.config re-render.
        this.setSnapshot({ ...this.snapshot });
        return;
      case 'state':
        this.setSnapshot(m.snapshot);
        return;
      case 'event': {
        if (m.name === 'cdr') {
          const cdr = m.payload as Cdr;
          if (!this.cdrs.some((c) => c.callId === cdr.callId)) this.setCdrs([cdr, ...this.cdrs].slice(0, 200));
        }
        this.emitter.emit(m.name, m.payload as never);
        return;
      }
      case 'result': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value);
        else p.reject(new RemoteSoftphoneError(m.error?.message ?? 'Command failed', m.error?.code));
        return;
      }
      case 'host-bye':
        return;
    }
  }

  private setCdrs(cdrs: Cdr[]): void {
    this.cdrs = cdrs;
    for (const l of [...this.historyListeners]) l();
  }

  private setSnapshot(next: SoftphoneSnapshot): void {
    const filled: SoftphoneSnapshot = { ...emptySnapshot(), ...next };
    this.snapshot = filled;
    for (const l of [...this.listeners]) l(filled);
    this.emitter.emit('state:changed', { snapshot: filled });
  }

  private command<T = unknown>(name: RemoteCommandName, ...args: unknown[]): Promise<T> {
    const transport = this.transport;
    if (!transport || transport.closed || this.currentStatus !== 'connected') {
      return Promise.reject(new RemoteSoftphoneError('Not connected to the softphone host', HOST_UNAVAILABLE));
    }
    while (args.length && args[args.length - 1] === undefined) args.pop();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RemoteSoftphoneError(`${name} timed out`, 'TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      transport.send(remoteMessage<CommandMessage>({ type: 'command', id, name, args }));
    });
  }

  /** Mock engine helpers (`simulateIncomingCall`...) on the host, when it allows them. */
  debug(method: string, ...args: unknown[]): Promise<unknown> {
    const local = this.local as unknown as Record<string, unknown> | undefined;
    const fn = local?.[method];
    if (typeof fn === 'function') return Promise.resolve((fn as (...a: unknown[]) => unknown).apply(local, args));
    return this.command('debug', method, args);
  }

  // ---- SoftphoneApi ----------------------------------------------------------

  get config(): ResolvedConfig {
    return this.cfg;
  }
  getSnapshot(): SoftphoneSnapshot {
    return this.snapshot;
  }
  subscribe(listener: (snapshot: SoftphoneSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  on<K extends keyof SoftphoneEvents>(event: K, handler: (payload: SoftphoneEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  /** The host owns the lifecycle: nothing to start. */
  async start(): Promise<void> {}
  /** Detach from the host. The host instance keeps running (and registered). */
  async stop(): Promise<void> {
    this.disconnect();
  }
  register(): Promise<void> {
    return this.command('register');
  }
  unregister(): Promise<void> {
    return this.command('unregister');
  }
  /** Sends the credentials / transport keys to the host, which may ask the user first (extension). */
  updateConfig(patch: SoftphoneConfigInput): Promise<void> {
    return this.command('updateConfig', JSON.parse(JSON.stringify(patch ?? {})) as unknown);
  }
  call(number: string, options?: CallOptions): Promise<Call> {
    return this.command('call', number, options);
  }
  answer(callId?: CallId, options?: AnswerOptions): Promise<void> {
    return this.command('answer', callId, options);
  }
  reject(callId?: CallId, statusCode?: number): Promise<void> {
    return this.command('reject', callId, statusCode);
  }
  forward(target: string, callId?: CallId): Promise<void> {
    return this.command('forward', target, callId);
  }
  hangup(callId?: CallId): Promise<void> {
    return this.command('hangup', callId);
  }
  hangupAll(): Promise<void> {
    return this.command('hangupAll');
  }
  hold(hold: boolean, callId?: CallId): Promise<void> {
    return this.command('hold', hold, callId);
  }
  mute(muted: boolean, callId?: CallId): void {
    void this.command('mute', muted, callId).catch(() => undefined);
  }
  sendDtmf(tones: string, callId?: CallId): Promise<void> {
    return this.command('sendDtmf', tones, callId);
  }
  transfer(target: string, callId?: CallId): Promise<void> {
    return this.command('transfer', target, callId);
  }
  startAttendedTransfer(target: string, callId?: CallId): Promise<Call> {
    return this.command('startAttendedTransfer', target, callId);
  }
  completeAttendedTransfer(originalCallId: CallId, consultCallId: CallId): Promise<void> {
    return this.command('completeAttendedTransfer', originalCallId, consultCallId);
  }
  conference(callIds?: CallId[]): Promise<void> {
    return this.command('conference', callIds);
  }
  removeFromConference(callId: CallId): Promise<void> {
    return this.command('removeFromConference', callId);
  }
  splitConference(keepCallId?: CallId): Promise<void> {
    return this.command('splitConference', keepCallId);
  }
  setPartyMuted(callId: CallId, muted: boolean): void {
    void this.command('setPartyMuted', callId, muted).catch(() => undefined);
  }
  setActiveCall(callId: CallId): void {
    void this.command('setActiveCall', callId).catch(() => undefined);
  }
  setDnd(on: boolean): Promise<void> {
    return this.command('setDnd', on);
  }
  callVoicemail(): Promise<Call> {
    return this.command('callVoicemail');
  }
  watch(targets: string | string[]): void {
    void this.command('watch', targets).catch(() => undefined);
  }
  unwatch(targets: string | string[]): void {
    void this.command('unwatch', targets).catch(() => undefined);
  }
  pickup(extension: string): Promise<Call> {
    return this.command('pickup', extension);
  }
  sendMessage(to: string, body: string): Promise<ChatMessage> {
    return this.command('sendMessage', to, body);
  }
  markConversationRead(peer: string): void {
    void this.command('markConversationRead', peer).catch(() => undefined);
  }
  deleteConversation(peer: string): void {
    void this.command('deleteConversation', peer).catch(() => undefined);
  }
  listDevices(): Promise<AudioDevice[]> {
    return this.command('listDevices');
  }
  setDevice(kind: AudioDeviceKind, deviceId: string): Promise<void> {
    return this.command('setDevice', kind, deviceId);
  }
  setVolume(kind: AudioDeviceKind, volume: number): void {
    void this.command('setVolume', kind, volume).catch(() => undefined);
  }
  /**
   * `call-history` is served from the host's recent CDRs; other plugins exist
   * only on the leader tab itself (they run where the instance runs).
   */
  plugin<T = unknown>(id: string): T | undefined {
    if (this.local) return this.local.plugin<T>(id);
    if (id === 'call-history') return this.historyApi as T;
    return undefined;
  }
  setVideo(on: boolean, callId?: CallId): Promise<void> {
    return this.command('setVideo', on, callId);
  }
  /** MediaStreams cannot cross a channel: only available on the tab that runs the instance. */
  getVideoStreams(callId?: CallId): CallVideoStreams {
    return this.local?.getVideoStreams?.(callId) ?? {};
  }
  refreshVoicemails(): Promise<VoicemailMessage[]> {
    return this.command('refreshVoicemails');
  }
  markVoicemailRead(id: string): Promise<void> {
    return this.command('markVoicemailRead', id);
  }
  deleteVoicemail(id: string): Promise<void> {
    return this.command('deleteVoicemail', id);
  }
  getVoicemailAudio(id: string): Promise<Blob> {
    if (this.local?.getVoicemailAudio) return this.local.getVoicemailAudio(id);
    return Promise.reject(new RemoteSoftphoneError('Voicemail audio is only available where the softphone runs', 'UNSUPPORTED'));
  }
  subscribePush(): Promise<PushState> {
    if (this.local?.subscribePush) return this.local.subscribePush();
    return Promise.reject(new RemoteSoftphoneError('Web Push is managed by the softphone host', 'UNSUPPORTED'));
  }
  unsubscribePush(): Promise<PushState> {
    if (this.local?.unsubscribePush) return this.local.unsubscribePush();
    return Promise.reject(new RemoteSoftphoneError('Web Push is managed by the softphone host', 'UNSUPPORTED'));
  }
}

function safeResolve(input: SoftphoneConfigInput): ResolvedConfig {
  try {
    return resolveConfig(input);
  } catch {
    return resolveConfig({});
  }
}
