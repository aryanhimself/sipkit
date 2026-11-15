import type {
  EngineFactory,
  EngineListener,
  EngineStartOptions,
  Logger,
  ResolvedConfig,
  SoftphoneEngine,
} from 'sipkit-core';
import { NativeSipClient } from './client';
import {
  NATIVE_PROTOCOL_VERSION,
  NativeSipError,
  type NativeAccount,
  type NativeCommand,
  type NativeEvent,
  type NativeHello,
} from './protocol';
import type { NativeSipTransport, Unsubscribe } from './transport';

export interface NativeSipEngineOptions {
  /**
   * The link to the sidecar. A factory is called on every `start()` (the
   * orchestrator restarts engines on config changes); a plain transport is
   * used for the first start only.
   */
  transport: NativeSipTransport | (() => NativeSipTransport | Promise<NativeSipTransport>);
  /** Per-request timeout, ms (default 15000). Transfers and registration outcomes arrive as events. */
  requestTimeoutMs?: number;
}

/** Build the account the sidecar registers from the softphone config. */
export function accountFromConfig(config: ResolvedConfig): NativeAccount {
  const server = config.sipServer || config.domain;
  if (!server)
    throw new NativeSipError(
      'invalid',
      'Native SIP engine needs `sipServer` (or `domain`) in the config',
    );
  const domain = config.domain || hostOf(server);
  return {
    username: config.username,
    authUsername: config.authUsername || undefined,
    password: config.password,
    displayName: config.displayName || undefined,
    domain,
    server,
    transport: config.sipTransport,
    outboundProxy: config.outboundProxy || undefined,
    registerExpires: config.registerExpires,
    dtmfMode: config.dtmfMode,
  };
}

/** "2002" -> sip:2002@domain, "2002@x" -> sip:2002@x, SIP URIs untouched. */
export function targetUri(target: string, domain: string): string {
  const t = target.trim();
  if (/^sips?:/i.test(t)) return t;
  if (t.includes('@')) return `sip:${t}`;
  return `sip:${t}@${domain}`;
}

function hostOf(server: string): string {
  const bare = server.replace(/^sips?:/i, '').split(';')[0] ?? '';
  if (bare.startsWith('[')) return bare.slice(0, bare.indexOf(']') + 1);
  return bare.split(':')[0] ?? '';
}

/**
 * `SoftphoneEngine` over a native SIP stack in a sidecar (baresip), reached
 * through a `NativeSipTransport` (Electron IPC bridge, stdio, TCP, memory).
 * Plain SIP over UDP/TCP/TLS: no WebRTC, no gateway.
 *
 * Media stays in the native stack, so the browser-media parts of the engine
 * contract are not available (see "Unsupported" below). The orchestrator
 * feature-detects the optional ones.
 *
 * Unsupported:
 * - `getMediaStreams()` always returns `{}` (no browser MediaStreams; no local conference mixing).
 * - `attendedTransfer()` rejects with `NativeSipError('unsupported')` unless the sidecar announces it.
 * - optional `forward`, `replaceOutgoingTrack`, `setOutputDevice`, `setInputDevice`,
 *   `setOutputVolume`, `getCallStats`, MWI, presence, MESSAGE and video are left undefined.
 */
export class NativeSipEngine implements SoftphoneEngine {
  readonly name = 'native-sip';
  private client: NativeSipClient | undefined;
  private listener: EngineListener | undefined;
  private logger: Logger | undefined;
  private config: ResolvedConfig | undefined;
  private hello: NativeHello | undefined;
  private offs: Unsubscribe[] = [];
  private firstTransportUsed = false;
  /** Calls the sidecar knows about (engine call ids). */
  private readonly calls = new Set<string>();
  private readonly muted = new Map<string, boolean>();

  constructor(private readonly options: NativeSipEngineOptions) {}

  /** What the connected sidecar announced (after start()). */
  get sidecar(): NativeHello | undefined {
    return this.hello;
  }

  async start({ config, listener, logger }: EngineStartOptions): Promise<void> {
    if (this.client) await this.stop();
    this.config = config;
    this.listener = listener;
    this.logger = logger;
    listener.onTransportState('connecting');
    const account = accountFromConfig(config);
    const transport = await this.openTransport();
    const client = new NativeSipClient(transport, this.options.requestTimeoutMs);
    this.client = client;
    this.offs = [
      client.onEvent((event) => this.onEvent(event)),
      client.onClose((reason) => this.onClose(reason)),
    ];
    try {
      const hello = (await client.request({
        cmd: 'hello',
        protocol: NATIVE_PROTOCOL_VERSION,
      })) as NativeHello;
      if (!hello || hello.protocol !== NATIVE_PROTOCOL_VERSION) {
        throw new NativeSipError(
          'invalid',
          `Native SIP sidecar speaks protocol ${hello?.protocol ?? '?'}, engine needs ${NATIVE_PROTOCOL_VERSION}`,
        );
      }
      this.hello = hello;
      logger.info('native SIP sidecar connected', { sidecar: hello.sidecar });
      await client.request({ cmd: 'start', account });
    } catch (error) {
      this.detach();
      client.close();
      listener.onTransportState(
        'disconnected',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    if (!client) return;
    await client
      .request({ cmd: 'stop' })
      .catch((error: unknown) => this.logger?.warn('native stop failed', error));
    this.detach();
    client.close();
    this.calls.clear();
    this.muted.clear();
  }

  async register(): Promise<void> {
    await this.send({ cmd: 'register' });
  }

  async unregister(): Promise<void> {
    if (!this.client) return;
    await this.send({ cmd: 'unregister' });
  }

  async call(
    engineCallId: string,
    target: string,
    options?: { extraHeaders?: string[]; video?: boolean },
  ): Promise<void> {
    if (options?.video) this.logger?.warn('native SIP engine is audio only; placing an audio call');
    this.calls.add(engineCallId);
    const headers = options?.extraHeaders?.length ? options.extraHeaders : undefined;
    try {
      await this.send({
        cmd: 'call',
        callId: engineCallId,
        target: targetUri(target, this.domain()),
        headers,
      });
    } catch (error) {
      this.calls.delete(engineCallId);
      throw error;
    }
  }

  async answer(engineCallId: string): Promise<void> {
    await this.send({ cmd: 'answer', callId: engineCallId });
  }

  async reject(engineCallId: string, statusCode = 486): Promise<void> {
    await this.send({ cmd: 'reject', callId: engineCallId, code: statusCode });
  }

  async hangup(engineCallId: string): Promise<void> {
    if (!this.calls.has(engineCallId) || !this.client) return;
    await this.send({ cmd: 'hangup', callId: engineCallId });
  }

  async setHold(engineCallId: string, hold: boolean): Promise<void> {
    await this.send({ cmd: 'hold', callId: engineCallId, hold });
  }

  setMuted(engineCallId: string, muted: boolean): void {
    if (!this.calls.has(engineCallId) || !this.client) return;
    if (this.muted.get(engineCallId) === muted) return;
    this.muted.set(engineCallId, muted);
    this.send({ cmd: 'mute', callId: engineCallId, muted }).catch((error: unknown) =>
      this.logger?.warn('native mute failed', error),
    );
  }

  async sendDtmf(engineCallId: string, tones: string): Promise<void> {
    if (!tones) return;
    // Digits are paced by the sidecar; allow ~250 ms per digit on top of the request timeout.
    await this.send(
      { cmd: 'dtmf', callId: engineCallId, tones },
      (this.options.requestTimeoutMs ?? 15_000) + tones.length * 250,
    );
  }

  async blindTransfer(engineCallId: string, target: string): Promise<void> {
    await this.send({
      cmd: 'transfer',
      callId: engineCallId,
      target: targetUri(target, this.domain()),
    });
  }

  async attendedTransfer(engineCallId: string, toEngineCallId: string): Promise<void> {
    if (this.hello && !this.hello.capabilities.attendedTransfer) {
      throw new NativeSipError(
        'unsupported',
        `Attended transfer is not supported by ${this.hello.sidecar}`,
      );
    }
    await this.send({ cmd: 'attendedTransfer', callId: engineCallId, toCallId: toEngineCallId });
  }

  /** Media lives in the native stack: there are no browser MediaStreams. */
  getMediaStreams(): { local?: MediaStream; remote?: MediaStream } {
    return {};
  }

  // ------------------------------------------------------------------ internals

  private async openTransport(): Promise<NativeSipTransport> {
    const { transport } = this.options;
    if (typeof transport === 'function') return transport();
    if (this.firstTransportUsed) {
      throw new NativeSipError(
        'transport',
        'Native SIP transport was closed; pass a transport factory to allow restarts',
      );
    }
    this.firstTransportUsed = true;
    return transport;
  }

  private send(command: NativeCommand, timeoutMs?: number): Promise<unknown> {
    if (!this.client)
      return Promise.reject(new NativeSipError('not-started', 'Native SIP engine not started'));
    return this.client.request(command, timeoutMs);
  }

  private domain(): string {
    if (!this.config) throw new NativeSipError('not-started', 'Native SIP engine not started');
    return accountFromConfig(this.config).domain;
  }

  private onEvent(event: NativeEvent): void {
    const listener = this.listener;
    if (!listener) return;
    switch (event.event) {
      case 'transport':
        return listener.onTransportState(event.state, event.reason);
      case 'registration':
        return listener.onRegistration({
          state: event.state,
          ...(event.code !== undefined ? { code: event.code } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        });
      case 'incoming':
        this.calls.add(event.callId);
        return listener.onIncomingCall(event.callId, {
          remoteNumber: event.remoteNumber,
          ...(event.remoteDisplayName ? { remoteDisplayName: event.remoteDisplayName } : {}),
          ...(event.sipCallId ? { sipCallId: event.sipCallId } : {}),
          ...(event.autoAnswerDelay !== undefined
            ? { autoAnswerDelay: event.autoAnswerDelay }
            : {}),
        });
      case 'ringing':
      case 'early-media':
        return listener.onCallProgress(event.callId, { type: event.event });
      case 'connected':
        return listener.onCallProgress(event.callId, {
          type: 'connected',
          sipCallId: event.sipCallId,
        });
      case 'remote-hold':
        return listener.onCallProgress(event.callId, { type: 'remote-hold', held: event.held });
      case 'ended':
        this.calls.delete(event.callId);
        this.muted.delete(event.callId);
        return listener.onCallProgress(event.callId, {
          type: 'ended',
          reason: event.reason,
          code: event.code,
        });
      case 'dtmf':
        return listener.onDtmf(event.callId, event.digit);
      case 'log':
        return this.logger?.[event.level](`sidecar: ${event.message}`);
    }
  }

  /** The sidecar went away: report it and end every call we knew about. */
  private onClose(reason?: string): void {
    const listener = this.listener;
    this.detach();
    if (!listener) return;
    listener.onTransportState('disconnected', reason ?? 'Native SIP sidecar disconnected');
    listener.onRegistration({ state: 'failed', reason: 'Native SIP sidecar disconnected' });
    for (const id of [...this.calls])
      listener.onCallProgress(id, { type: 'ended', reason: 'failed' });
    this.calls.clear();
    this.muted.clear();
  }

  private detach(): void {
    for (const off of this.offs.splice(0)) off();
    this.client = undefined;
  }
}

/** `createSoftphone({ engine: nativeSipEngine({ transport: () => createBridgeTransport(window.sipkitNativeSip) }) })`. */
export function nativeSipEngine(options: NativeSipEngineOptions): EngineFactory {
  return () => new NativeSipEngine(options);
}
