import {
  Registerer,
  RegistererState,
  SIPExtension,
  UserAgent,
  type Invitation,
  type Message,
  type Notification,
  type LogLevel as SipLogLevel,
  type UserAgentOptions,
} from 'sip.js';
import type { ResolvedConfig } from '../../config';
import type { EngineListener, EngineStartOptions, Logger } from '../../types';
import { backoffDelayMs, resolveSipDomain } from './helpers';

type ConnectionListener = Pick<EngineListener, 'onTransportState' | 'onRegistration'>;

/**
 * Owns the SIP.js UserAgent + Registerer:
 *  - WSS failover: each connection round tries every `websocketUrls` entry in order
 *  - reconnection: failed rounds back off exponentially (reconnectionDelay, capped at 60s),
 *    giving up after `reconnectionAttempts` rounds (0 = never give up)
 *  - re-REGISTER after every successful reconnect while registration is wanted
 *  - CRLF keepalive via the SIP.js transport (`keepAliveInterval`)
 */
export class SipConnection {
  ua: UserAgent | undefined;
  private registerer: Registerer | undefined;
  private urlIndex = 0;
  private round = 0;
  private stopped = true;
  private wantRegistered = false;
  private registrationFailed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<boolean> | undefined;

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly listener: ConnectionListener,
    private readonly logger: Logger,
    private readonly onInvite: (invitation: Invitation) => void,
    /** Out-of-dialog NOTIFY (e.g. unsolicited MWI). Unhandled ones are rejected 481. */
    private readonly onNotify?: (notification: Notification) => boolean,
    /** Out-of-dialog MESSAGE (chat). Without it SIP.js accepts and drops MESSAGEs. */
    private readonly onMessage?: (message: Message) => void,
    /** Reload-safe softphone (docs/resume.md): stable +sip.instance and the sipkit-resume Contact param. */
    private readonly resume?: EngineStartOptions['resume'],
  ) {}

  get domain(): string {
    return resolveSipDomain(this.cfg);
  }

  isConnected(): boolean {
    return Boolean(this.ua?.isConnected());
  }

  /** Connect (one failover round). Never rejects: failures schedule background reconnection. */
  async start(): Promise<void> {
    this.stopped = false;
    const ok = await this.connectRound();
    if (!ok) this.scheduleReconnect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wantRegistered = false;
    this.clearReconnect();
    await this.teardownUa();
  }

  async register(): Promise<void> {
    this.wantRegistered = true;
    if (!this.ua || !this.isConnected()) return; // registers once connected
    this.registerer ??= this.createRegisterer(this.ua);
    this.registrationFailed = false;
    this.listener.onRegistration({ state: 'registering' });
    await this.registerer.register({
      requestDelegate: {
        onReject: (response) => {
          this.registrationFailed = true;
          const code = response.message.statusCode;
          this.listener.onRegistration({
            state: 'failed',
            code,
            reason: `${code ?? ''} ${response.message.reasonPhrase ?? 'Registration rejected'}`.trim(),
          });
        },
      },
    });
  }

  async unregister(): Promise<void> {
    this.wantRegistered = false;
    if (this.registerer?.state === RegistererState.Registered) await this.registerer.unregister();
    else this.listener.onRegistration({ state: 'unregistered' });
  }

  // ------------------------------------------------------------------ internals

  private connectRound(): Promise<boolean> {
    this.connecting ??= this.doConnectRound().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnectRound(): Promise<boolean> {
    const urls = this.cfg.websocketUrls;
    this.listener.onTransportState('connecting');
    // Try to keep dialogs alive: reconnect the existing UA first if it has sessions.
    if (this.ua && Object.keys(this.ua._sessions).length > 0) {
      try {
        await this.ua.reconnect();
        return this.onConnected();
      } catch (error) {
        this.logger.warn('Reconnect with live sessions failed; failing over', error);
      }
    }
    for (let i = 0; i < urls.length && !this.stopped; i++) {
      const index = (this.urlIndex + i) % urls.length;
      const url = urls[index]!;
      await this.teardownUa();
      const ua = new UserAgent(this.uaOptions(url));
      this.ua = ua;
      try {
        this.logger.info(`Connecting to ${url}`);
        await ua.start();
        if (this.stopped) return false;
        this.urlIndex = index;
        return this.onConnected();
      } catch (error) {
        this.logger.warn(`Connection to ${url} failed`, error);
      }
    }
    if (urls.length > 0) this.urlIndex = (this.urlIndex + 1) % urls.length;
    this.listener.onTransportState('disconnected', 'All WebSocket servers unreachable');
    return false;
  }

  private onConnected(): true {
    this.round = 0;
    this.listener.onTransportState('connected');
    if (this.wantRegistered) {
      this.register().catch((error: unknown) => this.logger.warn('Re-register failed', error));
    }
    return true;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.round += 1;
    const max = this.cfg.reconnectionAttempts;
    if (max > 0 && this.round > max) {
      this.listener.onRegistration({ state: 'failed', reason: `Unable to connect after ${max} attempts` });
      return;
    }
    const delay = backoffDelayMs(this.round, this.cfg.reconnectionDelay);
    this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.round})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectRound()
        .then((ok) => {
          if (!ok) this.scheduleReconnect();
        })
        .catch((error: unknown) => this.logger.error('Reconnect round failed', error));
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private handleDisconnect(error?: Error): void {
    if (this.stopped) return;
    // The registration is gone with the socket; recreate it after reconnecting.
    const registerer = this.registerer;
    this.registerer = undefined;
    registerer?.dispose().catch(() => undefined);
    this.listener.onTransportState('disconnected', error?.message ?? 'WebSocket closed');
    this.scheduleReconnect();
  }

  private createRegisterer(ua: UserAgent): Registerer {
    const registerer = new Registerer(ua, { expires: this.cfg.registerExpires, extraHeaders: [...this.cfg.registerHeaders] });
    registerer.stateChange.addListener((state) => {
      if (state === RegistererState.Registered) {
        this.listener.onRegistration({ state: 'registered' });
      } else if (state === RegistererState.Unregistered && !this.registrationFailed) {
        this.listener.onRegistration({ state: 'unregistered' });
      }
    });
    return registerer;
  }

  private async teardownUa(): Promise<void> {
    const ua = this.ua;
    const registerer = this.registerer;
    this.ua = undefined;
    this.registerer = undefined;
    if (registerer) await registerer.dispose().catch(() => undefined);
    if (ua) {
      ua.delegate = undefined;
      await ua.stop().catch(() => undefined);
    }
  }

  private uaOptions(server: string): Partial<UserAgentOptions> {
    const cfg = this.cfg;
    const uri = UserAgent.makeURI(`sip:${cfg.username}@${this.domain}`);
    if (!uri) throw new Error(`Invalid SIP identity sip:${cfg.username}@${this.domain}`);
    const sipLog = this.logger.child('sip');
    return {
      uri,
      transportOptions: {
        server,
        keepAliveInterval: cfg.keepAliveInterval,
        traceSip: cfg.traceSip,
        connectionTimeout: 5,
      },
      authorizationUsername: cfg.authUsername || cfg.username,
      authorizationPassword: cfg.password,
      displayName: cfg.displayName,
      userAgentString: 'Sipkit/0.1 (SIP.js)',
      noAnswerTimeout: Math.max(cfg.ringTimeout + 5, 60),
      sipExtensionReplaces: SIPExtension.Supported,
      preloadedRouteSet: cfg.outboundProxy ? [`<sip:${cfg.outboundProxy};lr>`] : [],
      // Reload-safe softphone: the same +sip.instance after every reload (RFC 5626) so registrars
      // that honour it replace the old contact, and ;sipkit-resume=<s> so the PBX anchors our calls.
      ...(this.resume
        ? {
            instanceId: this.resume.instanceId,
            instanceIdAlwaysAdded: true,
            contactParams: { transport: 'ws', 'sipkit-resume': String(this.resume.rejoinTimeoutSec) },
          }
        : {}),
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: { iceServers: cfg.iceServers },
        iceGatheringTimeout: cfg.iceGatheringTimeoutMs,
      },
      logBuiltinEnabled: false,
      logLevel: (cfg.traceSip ? 'log' : 'warn') satisfies SipLogLevel,
      logConnector: (level, category, _label, content) => {
        const msg = `[${category}] ${content}`;
        if (level === 'error') sipLog.error(msg);
        else if (level === 'warn') sipLog.warn(msg);
        else if (level === 'log' && cfg.traceSip) sipLog.info(msg);
        else sipLog.debug(msg);
      },
      delegate: {
        onInvite: (invitation) => this.onInvite(invitation),
        onNotify: (notification) => {
          if (!this.onNotify?.(notification)) notification.reject({ statusCode: 481 }).catch(() => undefined);
        },
        onDisconnect: (error) => this.handleDisconnect(error),
        ...(this.onMessage ? { onMessage: (message: Message) => this.onMessage?.(message) } : {}),
      },
    };
  }
}
