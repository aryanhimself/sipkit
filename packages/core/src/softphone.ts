import { hasCredentials, resolveConfig, type ResolvedConfig, type SoftphoneConfigInput } from './config';
import { TypedEmitter } from './events';
import { createLogger, type LoggerOptions } from './logger';
import type { PluginContext, PluginStorage, SoftphonePlugin } from './plugin';
import type {
  AnswerOptions,
  AudioDevice,
  AudioDeviceKind,
  Call,
  CallId,
  CallOptions,
  CallVideoStreams,
  EngineFactory,
  EngineListener,
  Logger,
  RegistrationStatus,
  SoftphoneApi,
  SoftphoneEngine,
  SoftphoneEvents,
  SoftphoneSnapshot,
  Unsubscribe,
  AppState,
  ResumeSnapshot,
} from './types';
import { SoftphoneError, toEngineError } from './errors';
import { createMemoryStorage, createPluginStorage, getDefaultStorage, type StorageLike } from './storage';
import { IDLE_RESUME, ResumeController, parseResumeSnapshot } from './internal/resume';
import { CallRegistry } from './internal/call-registry';
import { ConferenceController } from './internal/conference';
import { DeviceManager } from './internal/device-manager';
import { PluginHost } from './internal/plugin-host';
import { SnapshotStore } from './internal/store';
import { TimerRegistry } from './internal/timers';
import { getMediaDevices, type MediaDevicesLike } from './media/devices';
import type { ConferenceMixer } from './media/conference-mixer';
import { sipjsEngine } from './engines/sipjs';
import { CallControl } from './internal/call-control';
import { createEngineListener } from './internal/engine-listener';
import { QualityMonitor } from './quality/monitor';
import { VoicemailController } from './internal/voicemail';
import { VideoController } from './internal/video';
import { EMPTY_MESSAGE_SUMMARY } from './internal/message-summary';
import { DndController } from './internal/dnd';
import { ServiceCalls } from './internal/service-call';
import { PresenceController } from './internal/presence';
import { userFromUri } from './internal/presence-parse';
import { ChatController, EMPTY_CHAT_STATE } from './chat/controller';
import { createLocalChatStorage, createMemoryChatStorage } from './chat/storage';
import type { ChatHistoryStorage, ChatMessage } from './chat/types';
import { EMPTY_VOICEMAIL_LIST, type FetchLike } from './voicemail-list/client';
import { VoicemailListController } from './voicemail-list/controller';
import type { VoicemailMessage } from './voicemail-list/types';
import { PushController } from './push/controller';
import { createBrowserPushPlatform } from './push/browser-platform';
import type { PushPlatform, PushState, PushWorkerLabels } from './push/types';

/** Options for {@link createSoftphone}. */
export interface CreateSoftphoneOptions {
  config: SoftphoneConfigInput;
  /** Engine factory; defaults to the SIP.js WebRTC engine. */
  engine?: EngineFactory;
  plugins?: SoftphonePlugin<unknown>[];
  /** Backing store for plugin + device persistence; defaults to localStorage (memory fallback). */
  storage?: StorageLike;
  /** Override `navigator.mediaDevices` (tests / embedded webviews). `null` disables devices. */
  mediaDevices?: MediaDevicesLike | null;
  /** Mirror log entries to the browser console (default true). */
  console?: boolean;
  /** Override the conference mixer factory (tests). */
  createMixer?: () => ConferenceMixer | undefined;
  /**
   * Chat history store (V2-CHAT-01). Default: localStorage when `chat.persist`,
   * else in memory. See {@link createLocalChatStorage} / {@link createMemoryChatStorage}.
   */
  chatStorage?: ChatHistoryStorage;
  /** fetch used by the voicemail list (V2-VM-02), e.g. a proxy or `createMockVoicemailBackend().fetch`. */
  voicemailFetch?: FetchLike;
  /**
   * Web Push browser integration (V2-PUSH-01). Default: service worker + Push API
   * of the current browser. `null` disables it; tests pass a fake from `/testing`.
   */
  pushPlatform?: PushPlatform | null;
  /**
   * Store for the reload-safe call descriptor (V2-RESUME-01). Default:
   * sessionStorage (`resume.storage: 'session'`) or the `storage` backend
   * (`'local'`); memory when unavailable. Tests pass a memory storage they reuse
   * across instances to simulate a reload.
   */
  resumeStorage?: StorageLike;
}

/** sessionStorage when it exists and is writable, else memory. */
function getSessionStorage(): StorageLike {
  try {
    const ss = (globalThis as { sessionStorage?: StorageLike }).sessionStorage;
    if (ss) {
      ss.setItem('__sipkit_softphone_probe__', '1');
      ss.removeItem('__sipkit_softphone_probe__');
      return ss;
    }
  } catch {
    /* fall through */
  }
  return createMemoryStorage();
}

/** Config keys whose change requires restarting the engine (new transport / credentials). */
const RESTART_KEYS: readonly (keyof ResolvedConfig)[] = [
  'username', 'password', 'authUsername', 'displayName', 'domain', 'transportMode', 'websocketUrls',
  'sipServer', 'sipTransport', 'outboundProxy', 'keepAliveInterval', 'reconnectionAttempts',
  'reconnectionDelay', 'registerExpires', 'registerHeaders', 'iceServers', 'iceGatheringTimeoutMs', 'traceSip',
  // Reload-safe softphone: the Contact carries ;sipkit-resume=<s> and +sip.instance.
  'resume',
];

const STORAGE_PREFIX = 'sipkit';

/**
 * The softphone orchestrator. Owns all state, drives a {@link SoftphoneEngine}
 * and exposes an immutable snapshot + typed events. Create via {@link createSoftphone}.
 */
export class Softphone implements SoftphoneApi {
  /** Resolves once plugins are set up (never rejects; failures move app state to 'error'). */
  readonly ready: Promise<void>;

  private cfg: ResolvedConfig;
  private rawConfig: SoftphoneConfigInput;
  private readonly engine: SoftphoneEngine;
  private readonly emitter: TypedEmitter<SoftphoneEvents>;
  private readonly store: SnapshotStore;
  private readonly loggerOptions: LoggerOptions;
  private readonly logger: Logger;
  private readonly timers = new TimerRegistry();
  private readonly plugins: PluginHost;
  private readonly devices: DeviceManager;
  private readonly calls: CallRegistry;
  private readonly control: CallControl;
  private readonly backend: StorageLike;
  private readonly listener: EngineListener;
  private readonly quality: QualityMonitor;
  private readonly voicemail: VoicemailController;
  private readonly presence: PresenceController;
  private readonly chat: ChatController;
  private readonly voicemailList: VoicemailListController;
  private readonly video: VideoController;
  private readonly coreStorage: PluginStorage;
  private readonly serviceCalls: ServiceCalls;
  private readonly dnd: DndController;
  private readonly push: PushController;
  private readonly resumer: ResumeController;
  private initError: unknown;
  private started = false;
  private engineRunning = false;
  private wantRegistered = false;
  private destroyed = false;

  constructor(options: CreateSoftphoneOptions) {
    this.rawConfig = { ...options.config };
    this.cfg = resolveConfig(this.rawConfig);
    this.engine = (options.engine ?? sipjsEngine())();
    this.backend = options.storage ?? getDefaultStorage();
    this.emitter = new TypedEmitter<SoftphoneEvents>((event, error) => {
      if (event !== 'log') this.logger.warn(`Handler for "${String(event)}" threw`, error);
    });
    this.loggerOptions = {
      level: this.cfg.logLevel,
      console: options.console ?? true,
      sink: (entry) => this.emitter.emit('log', entry),
    };
    this.logger = createLogger('softphone', this.loggerOptions);
    this.plugins = new PluginHost(this.logger.child('plugins'));
    const md = options.mediaDevices === null ? undefined : (options.mediaDevices ?? getMediaDevices());
    this.devices = new DeviceManager(md, createPluginStorage(`${STORAGE_PREFIX}:core:devices`, this.backend), (devices) =>
      this.store.update({ devices }),
    );
    this.coreStorage = createPluginStorage(`${STORAGE_PREFIX}:core`, this.backend);
    const pushPlatform = options.pushPlatform === undefined ? createBrowserPushPlatform() : options.pushPlatform;
    this.store = new SnapshotStore(
      {
        app: 'loading',
        registration: { state: 'idle' },
        calls: [],
        activeCallId: null,
        devices: this.devices.state,
        engine: this.engine.name,
        voicemail: { ...EMPTY_MESSAGE_SUMMARY },
        dnd: DndController.initial(this.cfg, this.coreStorage),
        presence: {},
        chat: EMPTY_CHAT_STATE,
        voicemailList: EMPTY_VOICEMAIL_LIST,
        push: PushController.initial(this.cfg, pushPlatform),
        resume: { ...IDLE_RESUME },
      },
      (snapshot) => this.emitter.emit('state:changed', { snapshot }),
    );
    this.calls = new CallRegistry(
      {
        created: (call) => {
          this.quality.onCall(call);
          this.emitter.emit('call:created', { call });
        },
        updated: (call, previous) => {
          this.quality.onCall(call);
          this.emitter.emit('call:updated', { call, previous });
        },
        ended: (call) => this.emitter.emit('call:ended', { call }),
        cdr: (cdr) => this.emitter.emit('cdr', this.quality.withSummary(cdr)),
        listChanged: (calls) => {
          this.store.update({ calls });
          this.resumer?.persist();
        },
      },
      () => this.cfg.username,
    );
    this.quality = new QualityMonitor({
      engine: this.engine,
      calls: this.calls,
      timers: this.timers,
      logger: this.logger.child('quality'),
      config: () => this.cfg,
      emit: (payload) => {
        this.video.handleQuality(payload.callId, payload.quality);
        this.emitter.emit('call:quality', payload);
      },
    });
    this.video = new VideoController({
      engine: this.engine,
      calls: this.calls,
      config: () => this.cfg,
      logger: this.logger.child('video'),
      getActive: () => this.store.get().activeCallId,
      emit: (payload) => this.emitter.emit('call:video', payload),
    });
    this.serviceCalls = new ServiceCalls(this.engine, this.logger.child('service'));
    const sessionStore = options.resumeStorage ?? getSessionStorage();
    this.resumer = new ResumeController({
      config: () => this.cfg,
      logger: this.logger.child('resume'),
      storage: () => (options.resumeStorage ? sessionStore : this.cfg.resume.storage === 'local' ? this.backend : sessionStore),
      coreStorage: this.coreStorage,
      calls: this.calls,
      engine: this.engine,
      service: this.serviceCalls,
      timers: this.timers,
      getActive: () => this.store.get().activeCallId,
      setActive: (id) => this.store.update({ activeCallId: id }),
      registrationState: () => this.store.get().registration.state,
      get: () => this.store.get().resume ?? IDLE_RESUME,
      set: (resume) => this.store.update({ resume }),
      emit: (event, payload) => this.emitter.emit(event, payload),
      notify: (n) => this.emitter.emit('notification', n),
      end: (id, reason, code) => this.control.finish(id, reason, code),
    });
    const conference = new ConferenceController(() => this.engine, this.logger.child('conference'), options.createMixer);
    this.control = new CallControl({
      engine: this.engine,
      calls: this.calls,
      conference,
      timers: this.timers,
      plugins: this.plugins,
      logger: this.logger.child('calls'),
      config: () => this.cfg,
      getActive: () => this.store.get().activeCallId,
      setActive: (id) => this.store.update({ activeCallId: id }),
      notify: (n) => this.emitter.emit('notification', n),
      isDnd: () => this.dnd.rejectsLocally(),
      video: this.video,
      pushDecision: (call) => this.push.decide(call),
      resume: this.resumer,
    });
    this.dnd = new DndController({
      config: () => this.cfg,
      logger: this.logger.child('dnd'),
      storage: this.coreStorage,
      service: this.serviceCalls,
      get: () => this.store.get().dnd,
      set: (dnd) => {
        this.store.update({ dnd });
        this.emitter.emit('dnd:changed', { dnd });
      },
      setPending: (dndPending) => this.store.update({ dndPending }),
      notify: (n) => this.emitter.emit('notification', n),
      isRegistered: () => this.store.get().registration.state === 'registered',
    });
    this.voicemail = new VoicemailController({
      engine: this.engine,
      config: () => this.cfg,
      logger: this.logger.child('voicemail'),
      get: () => this.store.get().voicemail,
      set: (voicemail) => {
        const previous = this.store.get().voicemail;
        this.store.update({ voicemail });
        this.emitter.emit('voicemail:updated', { voicemail, previous });
        this.voicemailList.onSummary(voicemail, previous);
      },
    });
    this.voicemailList = new VoicemailListController({
      config: () => this.cfg,
      logger: this.logger.child('voicemail-list'),
      fetch: options.voicemailFetch,
      get: () => this.store.get().voicemailList ?? EMPTY_VOICEMAIL_LIST,
      set: (list) => {
        this.store.update({ voicemailList: list });
        this.emitter.emit('voicemail:list', { list });
      },
    });
    this.voicemailList.reconcile();
    this.presence = new PresenceController({
      engine: this.engine,
      config: () => this.cfg,
      logger: this.logger.child('presence'),
      get: () => this.store.get().presence,
      publish: (presence, changes) => {
        this.store.update({ presence });
        for (const change of changes) this.emitter.emit('presence:changed', change);
      },
    });
    const engine = this.engine;
    this.chat = new ChatController({
      config: () => this.cfg,
      logger: this.logger.child('chat'),
      storage:
        options.chatStorage ??
        (this.cfg.chat.persist ? createLocalChatStorage(this.backend, `${STORAGE_PREFIX}:chat`) : createMemoryChatStorage()),
      send: engine.sendMessage
        ? (target, body, opts) => {
            if (!this.engineRunning) return Promise.resolve({ code: 503, reason: 'Not connected' });
            return engine.sendMessage!(target, body, opts);
          }
        : undefined,
      get: () => this.store.get().chat,
      set: (chat) => this.store.update({ chat }),
      emit: (event, payload) => this.emitter.emit(event, payload),
    });
    this.chat.reconcile();
    this.push = new PushController({
      config: () => this.cfg,
      logger: this.logger.child('push'),
      platform: pushPlatform,
      storage: this.coreStorage,
      get: () => this.store.get().push ?? PushController.initial(this.cfg, pushPlatform),
      set: (push) => {
        this.store.update({ push });
        this.emitter.emit('push:changed', { push });
      },
      emitAction: (payload) => this.emitter.emit('push:action', payload),
    });
    this.push.init();
    this.listener = createEngineListener({
      isActive: () => !this.destroyed,
      isStarted: () => this.started,
      registrationState: () => this.store.get().registration.state,
      setRegistration: (status) => this.setRegistration(status),
      emit: (event, payload) => this.emitter.emit(event, payload),
      control: this.control,
      calls: this.calls,
      onMessageSummary: (summary) => this.voicemail.handleSummary(summary),
      serviceCalls: this.serviceCalls,
      onPresence: (update) => this.presence.handleUpdate(update),
      onMessage: (message) => this.chat.receive(message),
      onCallVideo: (engineCallId, state) => this.video.handleEngine(engineCallId, state),
    });
    this.ready = this.init(options.plugins ?? []);
  }

  // ---------------------------------------------------------------- state / events

  get config(): ResolvedConfig {
    return this.cfg;
  }

  getSnapshot = (): SoftphoneSnapshot => this.store.get();

  subscribe = (listener: (snapshot: SoftphoneSnapshot) => void): Unsubscribe => this.store.subscribe(listener);

  on<K extends keyof SoftphoneEvents>(event: K, handler: (payload: SoftphoneEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  /** Look up a live call by id. */
  getCall(callId: CallId): Call | undefined {
    return this.calls.get(callId)?.call;
  }

  plugin<T = unknown>(id: string): T | undefined {
    return this.plugins.api<T>(id);
  }

  // ---------------------------------------------------------------- lifecycle

  private async init(plugins: SoftphonePlugin<unknown>[]): Promise<void> {
    try {
      await this.plugins.setup(plugins, (id) => this.pluginContext(id));
      if (!this.destroyed) this.setApp('ready');
    } catch (error) {
      this.initError = error;
      this.logger.error('Plugin initialisation failed', error);
      this.setApp('error');
    }
  }

  private pluginContext(id: string): PluginContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      api: this,
      get config() {
        return self.cfg;
      },
      logger: this.logger.child(`plugin:${id}`),
      storage: createPluginStorage(`${STORAGE_PREFIX}:${id}`, this.backend),
    };
  }

  /** Start the engine (and auto-register). Without credentials, the engine starts on a later updateConfig. */
  async start(): Promise<void> {
    this.assertAlive();
    await this.ready;
    if (this.initError) {
      throw new SoftphoneError('NOT_READY', 'Softphone failed to initialise', { cause: this.initError });
    }
    if (this.started) return;
    this.started = true;
    this.devices.watch((e) => this.logger.warn('Device refresh failed', e));
    this.devices.list().catch((e: unknown) => this.logger.debug('Device listing failed', e));
    this.resumer.resumeWriting();
    if (this.cfg.resume.enabled) {
      this.resumer.attach();
      const stored = this.resumer.load();
      if (stored) this.resumer.restore(stored);
    }
    try {
      if (hasCredentials(this.cfg)) await this.startEngine(this.cfg.autoRegister);
      else this.logger.info('No credentials configured; waiting for updateConfig()');
    } catch (error) {
      this.started = false;
      this.devices.unwatchChanges();
      this.setApp('error');
      throw error;
    }
    this.setApp('started');
  }

  /** Hang up everything, unregister and stop the engine. The instance can be started again. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    // An explicit stop is not a reload: end anchored calls for real and forget them.
    await this.control.hangupAll().catch((e: unknown) => this.logger.warn('hangupAll failed', e));
    await this.resumer.flush();
    await this.stopEngine();
    this.resumer.suspend();
    this.resumer.detach();
    this.resumer.clear();
    this.devices.unwatchChanges();
    this.timers.clearAll();
    if (!this.destroyed) this.setApp('stopped');
  }

  /** Stop, dispose plugins (reverse order) and release every listener/timer. Irreversible. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.ready;
    await this.stop();
    this.destroyed = true;
    this.voicemail.dispose();
    this.voicemailList.dispose();
    this.push.dispose();
    this.serviceCalls.dispose();
    this.presence.dispose();
    await this.plugins.dispose();
    await this.control.dispose();
    this.quality.dispose();
    this.timers.clearAll();
    this.emitter.clear();
    this.store.clear();
  }

  async register(): Promise<void> {
    this.assertStarted();
    if (!hasCredentials(this.cfg)) {
      throw new SoftphoneError('MISSING_CREDENTIALS', 'username, websocketUrls and domain are required');
    }
    this.wantRegistered = true;
    if (!this.engineRunning) return this.startEngine(true);
    this.setRegistration({ state: 'registering' });
    try {
      await this.engine.register();
    } catch (error) {
      const err = toEngineError(error, 'Register');
      this.setRegistration({ state: 'failed', reason: err.message });
      throw err;
    }
  }

  async unregister(): Promise<void> {
    this.assertStarted();
    this.wantRegistered = false;
    this.resumer.clear();
    if (!this.engineRunning) return;
    try {
      await this.engine.unregister();
    } catch (error) {
      throw toEngineError(error, 'Unregister');
    }
  }

  /** Validate + apply a config patch; restarts the engine when transport/credentials changed. */
  async updateConfig(patch: SoftphoneConfigInput): Promise<void> {
    this.assertAlive();
    const nextRaw = { ...this.rawConfig, ...patch };
    const next = resolveConfig(nextRaw);
    const prev = this.cfg;
    const transportChanged = RESTART_KEYS.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
    if (transportChanged && this.engineRunning && this.calls.size > 0) {
      throw new SoftphoneError('INVALID_STATE', 'Cannot change transport or credentials during a call');
    }
    this.rawConfig = nextRaw;
    this.cfg = next;
    this.loggerOptions.level = next.logLevel;
    this.voicemail.reconcile();
    this.voicemailList.reconcile();
    this.dnd.reconcile(prev);
    this.presence.reconcile();
    this.chat.reconcile();
    this.push.reconcile(prev);
    if (!this.started) return;
    if (transportChanged && this.engineRunning) {
      const reRegister = this.wantRegistered || this.cfg.autoRegister;
      await this.stopEngine();
      if (hasCredentials(next)) await this.startEngine(reRegister);
    } else if (!this.engineRunning && hasCredentials(next)) {
      await this.startEngine(this.cfg.autoRegister || this.wantRegistered);
    }
  }

  private async startEngine(register: boolean): Promise<void> {
    this.setRegistration({ state: 'connecting' });
    try {
      const resume = this.resumer.engineOptions();
      await this.engine.start({
        config: this.cfg,
        listener: this.listener,
        logger: this.logger.child('engine'),
        ...(resume ? { resume } : {}),
      });
    } catch (error) {
      const err = toEngineError(error, 'Engine start');
      this.setRegistration({ state: 'failed', reason: err.message });
      throw err;
    }
    this.engineRunning = true;
    await this.devices.applyAll(this.engine, (e) => this.logger.warn('Applying device failed', e));
    if (register) {
      this.wantRegistered = true;
      this.setRegistration({ state: 'registering' });
      await this.engine.register().catch((error: unknown) => {
        this.setRegistration({ state: 'failed', reason: toEngineError(error, 'Register').message });
      });
    }
  }

  private async stopEngine(): Promise<void> {
    if (!this.engineRunning) return;
    this.engineRunning = false;
    const registered = this.store.get().registration.state === 'registered';
    if (registered) await this.engine.unregister().catch((e: unknown) => this.logger.warn('Unregister failed', e));
    await this.engine.stop().catch((e: unknown) => this.logger.warn('Engine stop failed', e));
    this.setRegistration({ state: 'idle' });
  }

  // ---------------------------------------------------------------- engine listener

  // ---------------------------------------------------------------- calls

  /** Dial a number; `{ video: true }` places a video call (config `video.enabled`). */
  async call(number: string, options?: CallOptions): Promise<Call> {
    this.assertStarted();
    this.assertRegistered();
    return this.control.call(number, options);
  }

  /** Answer an incoming call; `{ video: false }` answers a video call audio-only. */
  async answer(callId?: CallId, options?: AnswerOptions): Promise<void> {
    this.assertStarted();
    return this.control.answer(callId, options);
  }

  // ---------------------------------------------------------------- video (V2-VID-01)

  /** Turn our camera on/off (adds video to an audio-only call when needed). */
  async setVideo(on: boolean, callId?: CallId): Promise<void> {
    this.assertStarted();
    return this.video.setVideo(on, callId);
  }

  /** Video-only local/remote MediaStreams of the given (or active) call. Not part of the snapshot. */
  getVideoStreams(callId?: CallId): CallVideoStreams {
    this.assertAlive();
    return this.video.getStreams(callId);
  }

  async reject(callId?: CallId, statusCode?: number): Promise<void> {
    this.assertStarted();
    if (statusCode !== undefined && (!Number.isInteger(statusCode) || statusCode < 300 || statusCode > 699)) {
      throw new SoftphoneError('INVALID_ARGUMENT', `Invalid SIP status code ${statusCode}`);
    }
    return this.control.reject(callId, statusCode);
  }

  /** Redirect an unanswered incoming call (SIP 302). */
  async forward(target: string, callId?: CallId): Promise<void> {
    this.assertStarted();
    return this.control.forward(target, callId);
  }

  async hangup(callId?: CallId): Promise<void> {
    this.assertStarted();
    return this.control.hangup(callId);
  }

  async hangupAll(): Promise<void> {
    this.assertStarted();
    return this.control.hangupAll();
  }

  async hold(hold: boolean, callId?: CallId): Promise<void> {
    this.assertStarted();
    return this.control.hold(hold, callId);
  }

  mute(muted: boolean, callId?: CallId): void {
    this.assertStarted();
    this.control.mute(muted, callId);
  }

  async sendDtmf(tones: string, callId?: CallId): Promise<void> {
    this.assertStarted();
    return this.control.sendDtmf(tones, callId);
  }

  async transfer(target: string, callId?: CallId): Promise<void> {
    this.assertStarted();
    return this.control.transfer(target, callId);
  }

  async startAttendedTransfer(target: string, callId?: CallId): Promise<Call> {
    this.assertStarted();
    this.assertRegistered();
    return this.control.startAttendedTransfer(target, callId);
  }

  async completeAttendedTransfer(originalCallId: CallId, consultCallId: CallId): Promise<void> {
    this.assertStarted();
    return this.control.completeAttendedTransfer(originalCallId, consultCallId);
  }

  async conference(callIds?: CallId[]): Promise<void> {
    this.assertStarted();
    return this.control.conference(callIds);
  }

  async removeFromConference(callId: CallId): Promise<void> {
    this.assertStarted();
    return this.control.removeFromConference(callId);
  }

  async splitConference(keepCallId?: CallId): Promise<void> {
    this.assertStarted();
    return this.control.splitConference(keepCallId);
  }

  setPartyMuted(callId: CallId, muted: boolean): void {
    this.assertStarted();
    this.control.setPartyMuted(callId, muted);
  }

  // ---------------------------------------------------------------- DND / voicemail

  /**
   * Turn Do Not Disturb on/off. Persisted when `dnd.persist` is set (always in
   * server modes). Server modes dial the feature code and revert on failure.
   */
  setDnd(on: boolean): Promise<void> {
    this.assertAlive();
    return this.dnd.set(on);
  }

  /** Dial the voicemail access number (`voicemail.number`, else the server's Message-Account). */
  async callVoicemail(): Promise<Call> {
    this.assertStarted();
    this.assertRegistered();
    const number = this.voicemail.number();
    if (!number) throw new SoftphoneError('NOT_SUPPORTED', 'No voicemail number configured (voicemail.number)');
    return this.control.call(number);
  }

  // ---------------------------------------------------------------- voicemail list (V2-VM-02)

  /** Reload the voicemail list (`voicemail.api`). */
  refreshVoicemails(): Promise<VoicemailMessage[]> {
    this.assertAlive();
    return this.voicemailList.refresh();
  }

  /** Move a voicemail to Old (heard); Asterisk then publishes the new MWI counts. */
  markVoicemailRead(id: string): Promise<void> {
    this.assertAlive();
    return this.voicemailList.markRead(id);
  }

  deleteVoicemail(id: string): Promise<void> {
    this.assertAlive();
    return this.voicemailList.delete(id);
  }

  /** Download a recording (bearer auth). Play it with `URL.createObjectURL(blob)`. */
  getVoicemailAudio(id: string): Promise<Blob> {
    this.assertAlive();
    return this.voicemailList.fetchAudio(id);
  }

  // ---------------------------------------------------------------- push (V2-PUSH-01)

  /** Subscribe this browser to call notifications (asks for permission when needed: call from a click). */
  subscribePush(): Promise<PushState> {
    this.assertAlive();
    return this.push.subscribe();
  }

  /** Remove this browser's push subscription (service + browser). */
  unsubscribePush(): Promise<PushState> {
    this.assertAlive();
    return this.push.unsubscribe();
  }

  /** Localised notification texts for the service worker (`{caller}` placeholder). */
  setPushLabels(labels: Partial<PushWorkerLabels>): void {
    this.assertAlive();
    this.push.setLabels(labels);
  }

  // ---------------------------------------------------------------- presence / BLF

  /** Watch extensions (presence / BLF lamps). Requires `presence.enabled`. */
  watch(targets: string | string[]): void {
    this.assertAlive();
    this.assertPresence();
    this.presence.watch(targets);
  }

  /** Stop watching extensions. */
  unwatch(targets: string | string[]): void {
    this.assertAlive();
    this.presence.unwatch(targets);
  }

  /** Directed call pickup: dial `presence.pickupPrefix` + extension (Asterisk `**1002` → PickupChan). */
  async pickup(extension: string): Promise<Call> {
    this.assertStarted();
    this.assertRegistered();
    const ext = userFromUri(String(extension ?? ''));
    if (!ext || /[\s,;]/.test(ext)) throw new SoftphoneError('INVALID_NUMBER', `Invalid pickup extension "${extension}"`);
    return this.control.call(`${this.cfg.presence.pickupPrefix}${ext}`);
  }

  // ---------------------------------------------------------------- chat

  /** Send a chat message (SIP MESSAGE). Resolves with the final message (`sent` / `failed`). */
  async sendMessage(to: string, body: string): Promise<ChatMessage> {
    this.assertStarted();
    if (!this.cfg.chat.enabled) throw new SoftphoneError('NOT_SUPPORTED', 'Chat is disabled (config chat.enabled)');
    this.assertRegistered();
    return this.chat.send(to, body);
  }

  markConversationRead(peer: string): void {
    this.assertAlive();
    this.chat.markRead(peer);
  }

  deleteConversation(peer: string): void {
    this.assertAlive();
    this.chat.deleteConversation(peer);
  }

  setActiveCall(callId: CallId): void {
    this.assertAlive();
    if (!this.calls.get(callId)) throw new SoftphoneError('CALL_NOT_FOUND', `No call with id "${callId}"`);
    this.store.update({ activeCallId: callId });
  }

  // ---------------------------------------------------------------- devices

  async listDevices(): Promise<AudioDevice[]> {
    this.assertAlive();
    return this.devices.list();
  }

  async setDevice(kind: AudioDeviceKind, deviceId: string): Promise<void> {
    this.assertAlive();
    await this.devices.select(kind, deviceId, this.engineRunning ? this.engine : undefined);
  }

  setVolume(kind: AudioDeviceKind, volume: number): void {
    this.assertAlive();
    this.devices.setVolume(kind, volume, this.engineRunning ? this.engine : undefined);
  }

  // ---------------------------------------------------------------- reload-safe softphone (V2-RESUME-01)

  /**
   * Rejoin anchored calls after a reload or a leader-tab takeover (docs/resume.md).
   * Starts the softphone when needed (so it can replace `start()`); `start()` itself
   * restores the descriptor this page persisted. With `state` (e.g. the old leader's
   * `exportResumeState()`), those calls appear at once with `resuming: true`, the same
   * id and their original start time, and each rejoins once registered. A no-op
   * beyond `start()` while `resume.enabled` is off.
   */
  async resume(state?: ResumeSnapshot): Promise<void> {
    this.assertAlive();
    const snapshot = state === undefined ? null : parseResumeSnapshot(state);
    if (state !== undefined && !snapshot) throw new SoftphoneError('INVALID_ARGUMENT', 'Invalid resume state');
    // Safe to call instead of start() (leader-tab takeover): starts first, which already
    // restores this page's own descriptor. Without resume.enabled it is just start().
    if (!this.started) await this.start();
    if (!this.cfg.resume.enabled) {
      if (state !== undefined) this.logger.warn('resume(state) ignored: config resume.enabled is off');
      return;
    }
    if (snapshot) this.resumer.restore(snapshot);
  }

  /** What a reload would restore (anchored calls), or null. Hand it to another tab's `resume()`. */
  exportResumeState(): ResumeSnapshot | null {
    this.assertAlive();
    return this.resumer.export();
  }

  // ---------------------------------------------------------------- helpers

  private setApp(state: AppState): void {
    if (this.store.get().app === state) return;
    this.store.update({ app: state });
    this.emitter.emit('app:state', { state });
  }

  private setRegistration(status: RegistrationStatus): void {
    const current = this.store.get().registration;
    if (current.state === status.state && current.reason === status.reason && current.code === status.code) return;
    this.logger.info(`Registration: ${status.state}${status.reason ? ` (${status.reason})` : ''}`);
    this.store.update({ registration: { ...status } });
    this.emitter.emit('registration:state', { ...status });
    this.voicemail.onRegistration(status.state);
    this.voicemailList.onRegistration(status.state);
    this.dnd.onRegistration(status.state);
    this.presence.onRegistration(status.state);
    this.push.onRegistration(status.state);
    this.resumer.onRegistration(status.state);
  }

  private assertAlive(): void {
    if (this.destroyed) throw new SoftphoneError('DESTROYED', 'Softphone has been destroyed');
  }

  private assertPresence(): void {
    if (!this.cfg.presence.enabled) {
      throw new SoftphoneError('NOT_SUPPORTED', 'Presence is disabled (config presence.enabled)');
    }
  }

  private assertStarted(): void {
    this.assertAlive();
    if (!this.started) throw new SoftphoneError('NOT_STARTED', 'Call start() first');
  }

  private assertRegistered(): void {
    if (this.store.get().registration.state !== 'registered') {
      throw new SoftphoneError('NOT_REGISTERED', 'Not registered to the SIP server');
    }
  }
}

/** Create a Softphone. Plugins set up asynchronously; await `softphone.ready` or just call `start()`. */
export function createSoftphone(options: CreateSoftphoneOptions): Softphone {
  return new Softphone(options);
}
