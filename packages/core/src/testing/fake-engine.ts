import type { ResolvedConfig } from '../config';
import { SyntheticCallStats, type NetworkConditions, type NetworkPreset } from '../quality/synthetic';
import { parseMessageSummary } from '../internal/message-summary';
import { parseDialogInfo, parsePidf } from '../internal/presence-parse';
import type {
  CallVideoStreams,
  DisconnectReason,
  EngineCallStats,
  EngineCallInfo,
  EngineIncomingMessage,
  EngineListener,
  EngineMessageResult,
  EngineStartOptions,
  MessageSummary,
  PresenceEventPackage,
  PresenceReport,
  RegistrationStatus,
  SoftphoneEngine,
  EngineVideoState,
} from '../types';

/** A command the Softphone issued to the engine. */
export interface FakeEngineCommand {
  method: string;
  args: unknown[];
}

export interface FakeEngineOptions {
  /** register() immediately reports 'registered' (default true). */
  autoRegister?: boolean;
  /** answer() immediately reports 'connected' (default true). */
  connectOnAnswer?: boolean;
  /** Local hangup/reject/cancel immediately report 'ended' like a real engine (default true). */
  endOnLocalTermination?: boolean;
  /** Expose replaceOutgoingTrack (enables conference mixing paths; default true). */
  supportsTrackReplacement?: boolean;
  /** Expose subscribeMessageSummary / unsubscribeMessageSummary (default true). */
  supportsMwi?: boolean;
  /** Expose subscribePresence / unsubscribePresence (default true). */
  supportsPresence?: boolean;
  /** Expose sendMessage (SIP MESSAGE chat; default true). */
  supportsMessaging?: boolean;
  /** Expose setVideo / getVideoStreams / setVideoDevice (default true). */
  supportsVideo?: boolean;
}

/** A MESSAGE the Softphone asked the engine to send. */
export interface FakeSentMessage {
  target: string;
  body: string;
  contentType: string;
  messageId: string;
}

interface FakeCall {
  direction: 'incoming' | 'outgoing';
  target: string;
  connected: boolean;
  /** Video negotiated / requested (V2-VID-01). */
  video?: EngineVideoState;
}

/**
 * Scriptable in-memory engine for tests and UI development. Records every
 * command and lets tests drive remote behaviour via `simulate*` methods.
 */
export class FakeEngine implements SoftphoneEngine {
  readonly name = 'fake';
  /** Reload-safe options of the last start() (V2-RESUME-01). */
  resumeOptions: EngineStartOptions['resume'];
  readonly commands: FakeEngineCommand[] = [];
  listener: EngineListener | undefined;
  config: ResolvedConfig | undefined;
  started = false;
  readonly calls = new Map<string, FakeCall>();
  /** Streams returned by getMediaStreams, keyed by engine call id. */
  readonly streams = new Map<string, { local?: MediaStream; remote?: MediaStream }>();
  replaceOutgoingTrack?: (engineCallId: string, track: MediaStreamTrack) => Promise<void>;
  /**
   * Stats returned by getCallStats, keyed by engine call id: a fixed value, or a
   * SyntheticCallStats generator (see simulateNetwork). Absent = no stats.
   */
  readonly callStats = new Map<string, EngineCallStats | SyntheticCallStats>();
  setVideo?: (engineCallId: string, on: boolean) => Promise<void>;
  getVideoStreams?: (engineCallId: string) => CallVideoStreams;
  setVideoDevice?: (deviceId: string) => Promise<void>;
  /** Streams returned by getVideoStreams, keyed by engine call id. */
  readonly videoStreams = new Map<string, CallVideoStreams>();
  subscribeMessageSummary?: (target?: string) => Promise<void>;
  unsubscribeMessageSummary?: () => Promise<void>;
  /** Current message-summary subscription target ('' = own AOR), or undefined when not subscribed. */
  mwiSubscription: string | undefined;
  subscribePresence?: (target: string, event: PresenceEventPackage, expires: number) => Promise<void>;
  unsubscribePresence?: (target: string, event: PresenceEventPackage) => Promise<void>;
  /** Active presence subscriptions as "event:target" (e.g. "dialog:1002"). */
  readonly presenceSubscriptions = new Set<string>();
  sendMessage?: (
    target: string,
    body: string,
    options: { contentType: string; messageId: string },
  ) => Promise<EngineMessageResult>;
  /** Every MESSAGE sent, oldest first. */
  readonly sentMessages: FakeSentMessage[] = [];
  /**
   * SIP status answered per target ('*' = default, 200 if absent), or 'pending'
   * to keep the send open until {@link resolveMessage}.
   */
  readonly messageResponses = new Map<string, number | 'pending'>();
  private pendingMessages = new Map<string, (result: EngineMessageResult) => void>();
  private failures = new Map<string, unknown>();
  private seq = 0;
  private readonly opts: Required<FakeEngineOptions>;

  constructor(options: FakeEngineOptions = {}) {
    this.opts = {
      autoRegister: true,
      connectOnAnswer: true,
      endOnLocalTermination: true,
      supportsTrackReplacement: true,
      supportsMwi: true,
      supportsPresence: true,
      supportsMessaging: true,
      supportsVideo: true,
      ...options,
    };
    if (this.opts.supportsPresence) {
      this.subscribePresence = async (target, event, expires) => {
        this.record('subscribePresence', target, event, expires);
        this.presenceSubscriptions.add(`${event}:${target}`);
      };
      this.unsubscribePresence = async (target, event) => {
        this.record('unsubscribePresence', target, event);
        this.presenceSubscriptions.delete(`${event}:${target}`);
      };
    }
    if (this.opts.supportsVideo) {
      this.setVideo = async (id, on) => {
        this.record('setVideo', id, on);
        const call = this.calls.get(id);
        if (!call) return;
        call.video = { hasVideo: Boolean(call.video?.hasVideo) || on, cameraOn: on, remoteVideo: Boolean(call.video?.remoteVideo) };
        this.listener?.onCallVideo?.(id, { ...call.video });
      };
      this.getVideoStreams = (id) => this.videoStreams.get(id) ?? {};
      this.setVideoDevice = async (deviceId) => {
        this.record('setVideoDevice', deviceId);
      };
    }
    if (this.opts.supportsMwi) {
      this.subscribeMessageSummary = async (target) => {
        this.record('subscribeMessageSummary', target);
        this.mwiSubscription = target ?? '';
      };
      this.unsubscribeMessageSummary = async () => {
        this.record('unsubscribeMessageSummary');
        this.mwiSubscription = undefined;
      };
    }
    if (this.opts.supportsMessaging) {
      this.sendMessage = async (target, body, options) => {
        this.record('sendMessage', target, body, options);
        this.sentMessages.push({ target, body, ...options });
        const response = this.messageResponses.get(target) ?? this.messageResponses.get('*') ?? 200;
        if (response === 'pending') {
          return new Promise((resolve) => this.pendingMessages.set(options.messageId, resolve));
        }
        return { code: response, reason: response < 300 ? 'OK' : 'Failed' };
      };
    }
    if (this.opts.supportsTrackReplacement) {
      this.replaceOutgoingTrack = async (id, track) => {
        this.record('replaceOutgoingTrack', id, track);
      };
    }
  }

  // ------------------------------------------------------------------ helpers for tests

  /** Make the next call to `method` reject with `error`. */
  failNext(method: keyof SoftphoneEngine, error: unknown = new Error(`${String(method)} failed`)): void {
    this.failures.set(method, error);
  }

  commandsFor(method: string): unknown[][] {
    return this.commands.filter((c) => c.method === method).map((c) => c.args);
  }

  lastCommand(method?: string): FakeEngineCommand | undefined {
    const list = method ? this.commands.filter((c) => c.method === method) : this.commands;
    return list[list.length - 1];
  }

  clearCommands(): void {
    this.commands.length = 0;
  }

  // ------------------------------------------------------------------ simulations

  simulateIncomingCall(info: Partial<EngineCallInfo> & { remoteNumber?: string } = {}): string {
    const id = `fake-in-${++this.seq}`;
    this.calls.set(id, {
      direction: 'incoming',
      target: info.remoteNumber ?? '1002',
      connected: false,
      ...(info.video ? { video: { hasVideo: true, cameraOn: false, remoteVideo: true } } : {}),
    });
    this.requireListener().onIncomingCall(id, { remoteNumber: '1002', sipCallId: `sip-${id}`, ...info });
    return id;
  }

  simulateRinging(engineCallId: string): void {
    this.requireListener().onCallProgress(engineCallId, { type: 'ringing' });
  }

  simulateEarlyMedia(engineCallId: string): void {
    this.requireListener().onCallProgress(engineCallId, { type: 'early-media' });
  }

  simulateRemoteAnswer(engineCallId: string, sipCallId = `sip-${engineCallId}`): void {
    const call = this.calls.get(engineCallId);
    if (call) call.connected = true;
    this.requireListener().onCallProgress(engineCallId, { type: 'connected', sipCallId });
    if (call?.video) this.requireListener().onCallVideo?.(engineCallId, { ...call.video });
  }

  /** Report video facts for a call (e.g. the remote turned its camera on/off). */
  simulateCallVideo(engineCallId: string, state: Partial<EngineVideoState>): void {
    const call = this.calls.get(engineCallId);
    const next: EngineVideoState = {
      hasVideo: true,
      cameraOn: Boolean(call?.video?.cameraOn),
      remoteVideo: Boolean(call?.video?.remoteVideo),
      ...state,
    };
    if (call) call.video = next;
    this.requireListener().onCallVideo?.(engineCallId, next);
  }

  simulateRemoteHangup(engineCallId: string): void {
    this.end(engineCallId, 'remote-hangup');
  }

  /** End a call with an arbitrary reason / SIP code (e.g. 'busy', 486). */
  simulateCallEnded(engineCallId: string, reason: DisconnectReason, code?: number): void {
    this.end(engineCallId, reason, code);
  }

  simulateRemoteHold(engineCallId: string, held: boolean): void {
    this.requireListener().onCallProgress(engineCallId, { type: 'remote-hold', held });
  }

  simulateDtmf(engineCallId: string, digit: string): void {
    this.requireListener().onDtmf(engineCallId, digit);
  }

  /**
   * Drive getCallStats for a call with synthetic RTP counters under the given
   * network conditions (or preset). Call again to change conditions mid-call.
   */
  simulateNetwork(engineCallId: string, conditions: NetworkConditions | NetworkPreset): SyntheticCallStats {
    const existing = this.callStats.get(engineCallId);
    if (existing instanceof SyntheticCallStats) {
      existing.set(conditions);
      return existing;
    }
    const synthetic = new SyntheticCallStats(conditions);
    this.callStats.set(engineCallId, synthetic);
    return synthetic;
  }

  /**
   * Deliver a message-summary NOTIFY: a parsed summary, or a raw RFC 3842
   * body ("Messages-Waiting: yes\r\nVoice-Message: 2/1"). Works whether or
   * not a subscription exists (= unsolicited MWI).
   */
  simulateMessageSummary(summary: Partial<MessageSummary> | string): void {
    const parsed =
      typeof summary === 'string'
        ? parseMessageSummary(summary)
        : { waiting: (summary.new ?? 0) > 0, new: 0, old: 0, urgentNew: 0, urgentOld: 0, ...summary };
    if (!parsed) throw new Error('Invalid message-summary body');
    this.requireListener().onMessageSummary?.(parsed);
  }

  /**
   * Deliver a presence NOTIFY for `target`: a report, or a raw dialog-info /
   * PIDF XML body (parsed like the SIP.js engine does).
   */
  simulatePresence(target: string, report: PresenceReport | string, event: PresenceEventPackage = 'dialog'): void {
    const parsed =
      typeof report === 'string' ? (event === 'dialog' ? parseDialogInfo(report) : parsePidf(report)) : report;
    if (!parsed) throw new Error(`Invalid ${event} body`);
    this.requireListener().onPresence?.({ target, event, report: parsed });
  }

  /** End a presence subscription as the server would (e.g. 403, 404, 489, or no code for a timeout). */
  simulatePresenceTerminated(target: string, code?: number, event: PresenceEventPackage = 'dialog'): void {
    this.presenceSubscriptions.delete(`${event}:${target}`);
    this.requireListener().onPresence?.({ target, event, terminated: true, code });
  }

  /** Deliver an incoming MESSAGE. Returns the SIP status the Softphone answered with. */
  simulateIncomingMessage(
    from: string,
    body: string,
    options: Partial<Omit<EngineIncomingMessage, 'from' | 'body'>> = {},
  ): number {
    const code = this.requireListener().onMessage?.({ from, body, contentType: 'text/plain', ...options });
    return code ?? 200;
  }

  /** Deliver a PBX delivery report (X-Sipkit-Delivery: failed) for a sent message. */
  simulateDeliveryReport(messageId: string | undefined, to?: string): number {
    return this.simulateIncomingMessage(to ?? 'pbx', 'Message could not be delivered', {
      deliveryReport: { status: 'failed', messageId, to },
    });
  }

  /** Finish a send that was held open with messageResponses 'pending'. */
  resolveMessage(messageId: string, code: number, reason?: string): void {
    const resolve = this.pendingMessages.get(messageId);
    this.pendingMessages.delete(messageId);
    resolve?.({ code, reason });
  }

  simulateRegistered(): void {
    this.requireListener().onRegistration({ state: 'registered' });
  }

  simulateRegistrationFailure(code = 403, reason = 'Forbidden'): void {
    this.requireListener().onRegistration({ state: 'failed', code, reason });
  }

  simulateTransportState(state: 'connecting' | 'connected' | 'disconnected', reason?: string): void {
    this.requireListener().onTransportState(state, reason);
  }

  // ------------------------------------------------------------------ SoftphoneEngine

  async start(options: EngineStartOptions): Promise<void> {
    this.record('start', options.config);
    this.config = options.config;
    this.resumeOptions = options.resume;
    this.listener = options.listener;
    this.started = true;
    options.listener.onTransportState('connected');
  }

  async stop(): Promise<void> {
    this.record('stop');
    this.started = false;
    this.mwiSubscription = undefined;
    this.presenceSubscriptions.clear();
    this.calls.clear();
  }

  async register(): Promise<void> {
    this.record('register');
    if (this.opts.autoRegister) this.emitRegistration({ state: 'registered' });
  }

  async unregister(): Promise<void> {
    this.record('unregister');
    this.emitRegistration({ state: 'unregistered' });
  }

  async call(engineCallId: string, target: string, options?: { extraHeaders?: string[]; video?: boolean }): Promise<void> {
    this.record('call', engineCallId, target, options);
    this.calls.set(engineCallId, {
      direction: 'outgoing',
      target,
      connected: false,
      ...(options?.video ? { video: { hasVideo: true, cameraOn: true, remoteVideo: true } } : {}),
    });
  }

  async answer(engineCallId: string, options?: { video?: boolean }): Promise<void> {
    if (options) this.record('answer', engineCallId, options);
    else this.record('answer', engineCallId);
    const call = this.calls.get(engineCallId);
    if (call?.video) call.video = options?.video ? { ...call.video, cameraOn: true } : undefined;
    if (this.opts.connectOnAnswer) this.simulateRemoteAnswer(engineCallId);
  }

  async reject(engineCallId: string, statusCode?: number): Promise<void> {
    this.record('reject', engineCallId, statusCode);
    if (this.opts.endOnLocalTermination) this.end(engineCallId, 'rejected', statusCode ?? 486);
  }

  async hangup(engineCallId: string): Promise<void> {
    this.record('hangup', engineCallId);
    const call = this.calls.get(engineCallId);
    if (this.opts.endOnLocalTermination && call) this.end(engineCallId, call.connected ? 'local-hangup' : 'cancelled');
  }

  async setHold(engineCallId: string, hold: boolean): Promise<void> {
    this.record('setHold', engineCallId, hold);
  }

  setMuted(engineCallId: string, muted: boolean): void {
    this.commands.push({ method: 'setMuted', args: [engineCallId, muted] });
  }

  async sendDtmf(engineCallId: string, tones: string): Promise<void> {
    this.record('sendDtmf', engineCallId, tones);
  }

  async blindTransfer(engineCallId: string, target: string): Promise<void> {
    this.record('blindTransfer', engineCallId, target);
  }

  async attendedTransfer(engineCallId: string, toEngineCallId: string): Promise<void> {
    this.record('attendedTransfer', engineCallId, toEngineCallId);
  }

  async forward(engineCallId: string, target: string): Promise<void> {
    this.record('forward', engineCallId, target);
    if (this.opts.endOnLocalTermination) this.end(engineCallId, 'transferred', 302);
  }

  getMediaStreams(engineCallId: string): { local?: MediaStream; remote?: MediaStream } {
    return this.streams.get(engineCallId) ?? {};
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.record('setOutputDevice', deviceId);
  }

  setOutputVolume(volume: number): void {
    this.commands.push({ method: 'setOutputVolume', args: [volume] });
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.record('setInputDevice', deviceId);
  }

  /** Not recorded in `commands` (it is polled); failNext('getCallStats') still works. */
  async getCallStats(engineCallId: string): Promise<EngineCallStats | undefined> {
    if (this.failures.has('getCallStats')) {
      const error = this.failures.get('getCallStats');
      this.failures.delete('getCallStats');
      throw error;
    }
    const source = this.callStats.get(engineCallId);
    return source instanceof SyntheticCallStats ? source.next() : source;
  }

  // ------------------------------------------------------------------ internals

  /** Record a command and throw if a failure was scheduled for it. */
  private record(method: string, ...args: unknown[]): void {
    this.commands.push({ method, args });
    if (this.failures.has(method)) {
      const error = this.failures.get(method);
      this.failures.delete(method);
      throw error;
    }
  }

  private end(engineCallId: string, reason: DisconnectReason, code?: number): void {
    this.calls.delete(engineCallId);
    this.callStats.delete(engineCallId);
    this.videoStreams.delete(engineCallId);
    this.listener?.onCallProgress(engineCallId, { type: 'ended', reason, code });
  }

  private emitRegistration(status: RegistrationStatus): void {
    this.listener?.onRegistration(status);
  }

  private requireListener(): EngineListener {
    if (!this.listener) throw new Error('FakeEngine has not been started');
    return this.listener;
  }
}
