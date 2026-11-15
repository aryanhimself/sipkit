import {
  ChatController,
  EMPTY_CHAT_STATE,
  EMPTY_MESSAGE_SUMMARY,
  EMPTY_VOICEMAIL_LIST,
  VoicemailListController,
  createMemoryChatStorage,
  createMockVoicemailBackend,
  createMemoryStorage,
  createPluginStorage,
  PushController,
  IDLE_RESUME,
  newAnchorId,
  parseResumeSnapshot,
  QualitySummaryBuilder,
  QualityTracker,
  SyntheticCallStats,
  resolveConfig,
  serverConferenceCapabilities,
  voicemailNumberFromAccount,
} from 'sipkit-core';
import { createSyntheticVideo, type SyntheticVideo } from 'sipkit-core/testing';
import type {
  AnswerOptions,
  AppState,
  AudioDevice,
  AudioDeviceKind,
  Call,
  CallId,
  CallOptions,
  CallVideoStreams,
  Cdr,
  ChatHistoryStorage,
  ChatMessage,
  DisconnectReason,
  Logger,
  NetworkConditions,
  NetworkPreset,
  PluginInstance,
  PresenceInfo,
  PresenceReport,
  PresenceState,
  PushLaunch,
  PushPlatform,
  PushState,
  PushWorkerLabels,
  RegistrationStatus,
  ResolvedConfig,
  ResumeSnapshot,
  SoftphoneApi,
  SoftphoneConfigInput,
  SoftphoneEvents,
  SoftphonePlugin,
  SoftphoneSnapshot,
  Unsubscribe,
  VoicemailMessage,
  VoicemailState,
  FetchLike,
  MockVoicemailBackend,
  MockVoicemailInput,
} from 'sipkit-core';

/**
 * In-memory implementation of {@link SoftphoneApi}.
 *
 * Used by tests, the playground ("Mock engine" mode) and the embed demo. It
 * simulates registration, outgoing calls (ringing -> connected), incoming
 * calls, hold/mute, blind + attended transfer, conference and DTMF without
 * any network or media.
 */

export interface MockSoftphoneOptions {
  /** Delay before the transport "connects" and registration completes. Default 300ms. */
  registerDelayMs?: number;
  /** Delay from dialing until the remote party "answers". Default 1500ms. */
  connectDelayMs?: number;
  /** Delay from dialing until the remote party starts ringing. Default 200ms. */
  ringDelayMs?: number;
  /** Password that is rejected with a 403 (to demo failed logins). Default "wrong". */
  rejectPassword?: string;
  /** Numbers that respond busy (486). */
  busyNumbers?: string[];
  /** Numbers that never answer (outgoing call stays ringing). */
  noAnswerNumbers?: string[];
  /** Plugins set up against the mock (same contract as the real core). */
  plugins?: SoftphonePlugin[];
  /** Fake audio devices. */
  devices?: AudioDevice[];
  engineName?: string;
  /**
   * Simulated network for call quality (`call:quality`, `call.quality`, CDR
   * summary). Default 'good'. Change at runtime with `simulateNetwork()`.
   * Sampling follows `callQualityInterval` (0 disables it).
   */
  network?: NetworkConditions | NetworkPreset;
  /** Delay before an outgoing chat message is answered. Default 150ms. */
  chatSendDelayMs?: number;
  /** Chat targets answered 404 Not Found (message `failed`). */
  unreachableChatNumbers?: string[];
  /** Reply "Auto-reply: <text>" to every chat message after 1s (demo). Default false. */
  chatAutoReply?: boolean;
  /** Chat history store (default in memory). */
  chatStorage?: ChatHistoryStorage;
  /**
   * Voicemail list (V2-VM-02): messages already in the in-memory mailbox that
   * stands in for services/voicemail-api (used whenever `voicemail.api.baseUrl`
   * is set). Mark read / delete update the MWI counts like Asterisk would.
   */
  voicemailMessages?: MockVoicemailInput[];
  /** Talk to a real voicemail-api (or any fetch) instead of the in-memory mailbox. */
  voicemailFetch?: FetchLike;
  /**
   * Web Push integration (V2-PUSH-01). Default none (push unsupported). The
   * playground passes `createBrowserPushPlatform()` to exercise the real
   * service worker and push service; tests pass a `FakePushPlatform`.
   */
  pushPlatform?: PushPlatform | null;
  /**
   * Reload-safe softphone (config `resume.enabled`, V2-RESUME-01): where the mock
   * keeps its session (account + anchored calls) across a page reload. Default:
   * sessionStorage when available, else memory. Tests reuse one store across instances.
   */
  resumeStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Delay before a restored call is "back" (the *85 rejoin answering). Default 600ms. */
  resumeDelayMs?: number;
}

const MOCK_RESUME_KEY = 'sipkit-mock:resume';

type ResumeStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultSessionStorage(): ResumeStore | null {
  try {
    return (globalThis as { sessionStorage?: ResumeStore }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

function defaultLocalStorage(): ResumeStore | null {
  try {
    return (globalThis as { localStorage?: ResumeStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** What the mock persists for `resume`: the snapshot plus the (fake) credentials to sign in again. */
interface MockResumeSession extends ResumeSnapshot {
  password?: string;
  dnd?: boolean;
}

const DEFAULT_DEVICES: AudioDevice[] = [
  { id: 'default-mic', label: 'Default microphone', kind: 'microphone' },
  { id: 'headset-mic', label: 'USB headset microphone', kind: 'microphone' },
  { id: 'default-speaker', label: 'Default speakers', kind: 'speaker' },
  { id: 'headset-speaker', label: 'USB headset', kind: 'speaker' },
  { id: 'default-speaker', label: 'Default speakers', kind: 'ringer' },
  { id: 'headset-speaker', label: 'USB headset', kind: 'ringer' },
  { id: 'default-camera', label: 'Integrated camera', kind: 'camera' },
  { id: 'usb-camera', label: 'USB webcam', kind: 'camera' },
];

const LIVE_STATES = new Set<Call['state']>(['setup', 'ringing', 'early', 'connected', 'held']);

type Handler = (payload: never) => void;

const noop = () => undefined;
const SILENT_LOGGER: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => SILENT_LOGGER };

export class MockSoftphone implements SoftphoneApi {
  private cfg: ResolvedConfig;
  private snapshot: SoftphoneSnapshot;
  private readonly listeners = new Set<(snapshot: SoftphoneSnapshot) => void>();
  private readonly handlers = new Map<keyof SoftphoneEvents, Set<Handler>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly callTimers = new Map<CallId, ReturnType<typeof setTimeout>[]>();
  private readonly pendingDtmf = new Map<CallId, string>();
  private readonly pluginApis = new Map<string, PluginInstance>();
  private pluginsReady: Promise<void> | null = null;
  private seq = 0;
  private network: NetworkConditions | NetworkPreset;
  private readonly quality = new Map<
    CallId,
    { stats: SyntheticCallStats; tracker: QualityTracker; summary: QualitySummaryBuilder }
  >();
  private readonly opts: Required<
    Omit<
      MockSoftphoneOptions,
      'plugins' | 'devices' | 'network' | 'chatStorage' | 'voicemailMessages' | 'voicemailFetch' | 'pushPlatform' | 'resumeStorage'
    >
  > & {
    plugins: SoftphonePlugin[];
    devices: AudioDevice[];
  };

  private readonly chat: ChatController;
  private readonly voicemailList: VoicemailListController;
  /** In-memory voicemail-api (V2-VM-02). Use `failNext()` / `requests` in tests. */
  readonly voicemailBackend: MockVoicemailBackend;
  private readonly push: PushController;
  /** Synthetic camera (canvas) per call while video is on (V2-VID-01). */
  private readonly video = new Map<
    CallId,
    { local?: SyntheticVideo; remote?: SyntheticVideo; streams?: { local: MediaStream; remote: MediaStream } }
  >();

  private readonly resumeStore: ResumeStore | null;
  private pendingResume: MockResumeSession | null = null;
  private resumingIds = new Set<CallId>();

  /** Every DTMF digit sent, in order, per call. Handy for assertions. */
  readonly dtmfLog: { callId: CallId; tones: string }[] = [];
  /** Every finished call record. */
  readonly cdrs: Cdr[] = [];

  constructor(config: SoftphoneConfigInput = {}, options: MockSoftphoneOptions = {}) {
    this.cfg = resolveConfig(config);
    this.network = options.network ?? 'good';
    this.opts = {
      registerDelayMs: options.registerDelayMs ?? 300,
      connectDelayMs: options.connectDelayMs ?? 1500,
      ringDelayMs: options.ringDelayMs ?? 200,
      rejectPassword: options.rejectPassword ?? 'wrong',
      busyNumbers: options.busyNumbers ?? [],
      noAnswerNumbers: options.noAnswerNumbers ?? [],
      plugins: options.plugins ?? [],
      devices: options.devices ?? DEFAULT_DEVICES,
      engineName: options.engineName ?? 'mock',
      chatSendDelayMs: options.chatSendDelayMs ?? 150,
      unreachableChatNumbers: options.unreachableChatNumbers ?? [],
      chatAutoReply: options.chatAutoReply ?? false,
      resumeDelayMs: options.resumeDelayMs ?? 600,
    };
    this.resumeStore =
      options.resumeStorage !== undefined
        ? options.resumeStorage
        : this.cfg.resume.storage === 'local'
          ? defaultLocalStorage()
          : defaultSessionStorage();
    this.pendingResume = this.loadResume();
    if (this.pendingResume) {
      // Sign in again with the account of the reloaded page.
      this.cfg = resolveConfig({ ...config, username: this.pendingResume.username, password: this.pendingResume.password ?? '' });
      const maxSeq = Math.max(0, ...this.pendingResume.calls.map((c) => Number(/^mock-(\d+)$/.exec(c.id)?.[1] ?? 0)));
      this.seq = maxSeq;
    }
    this.snapshot = {
      app: 'ready',
      registration: { state: 'idle' },
      calls: [],
      activeCallId: null,
      devices: {
        available: this.opts.devices,
        selected: {
          microphone: this.opts.devices.find((d) => d.kind === 'microphone')?.id,
          speaker: this.opts.devices.find((d) => d.kind === 'speaker')?.id,
          ringer: this.opts.devices.find((d) => d.kind === 'ringer')?.id,
          camera: this.opts.devices.find((d) => d.kind === 'camera')?.id,
        },
      },
      engine: this.opts.engineName,
      voicemail: { ...EMPTY_MESSAGE_SUMMARY },
      dnd: this.cfg.dnd.enabled,
      presence: {},
      chat: EMPTY_CHAT_STATE,
      voicemailList: EMPTY_VOICEMAIL_LIST,
      push: PushController.initial(this.cfg, options.pushPlatform ?? null),
      resume: { ...IDLE_RESUME },
    };
    if (this.pendingResume?.dnd !== undefined) this.snapshot.dnd = this.pendingResume.dnd;
    this.chat = new ChatController({
      config: () => this.cfg,
      logger: SILENT_LOGGER,
      storage: options.chatStorage ?? createMemoryChatStorage(),
      send: (target, body) =>
        new Promise((resolve) => {
          this.later(this.opts.chatSendDelayMs, () => {
            if (this.opts.unreachableChatNumbers.includes(target)) {
              resolve({ code: 404, reason: 'Not Found' });
              return;
            }
            resolve({ code: 200, reason: 'OK' });
            if (this.opts.chatAutoReply) this.later(1000, () => this.simulateIncomingMessage(target, `Auto-reply: ${body}`));
          });
        }),
      get: () => this.snapshot.chat,
      set: (chat) => this.setSnapshot({ chat }),
      emit: (event, payload) => this.emit(event, payload),
    });
    this.chat.reconcile();
    this.voicemailBackend = createMockVoicemailBackend(options.voicemailMessages ?? [], {
      mailbox: this.cfg.voicemail.api.mailbox || this.cfg.username || '1001',
    });
    // The mock PBX publishes MWI for its own mailbox, like Asterisk after a change.
    this.voicemailBackend.onChange = (counts) => this.simulateVoicemail({ new: counts.new, old: counts.old });
    this.voicemailList = new VoicemailListController({
      config: () => this.cfg,
      logger: SILENT_LOGGER,
      fetch: options.voicemailFetch ?? this.voicemailBackend.fetch,
      get: () => this.snapshot.voicemailList ?? EMPTY_VOICEMAIL_LIST,
      set: (list) => {
        this.setSnapshot({ voicemailList: list });
        this.emit('voicemail:list', { list });
      },
      refreshDelayMs: 50,
    });
    this.voicemailList.reconcile();
    const pushPlatform = options.pushPlatform ?? null;
    this.push = new PushController({
      config: () => this.cfg,
      logger: SILENT_LOGGER,
      platform: pushPlatform,
      storage: createPluginStorage('sipkit-mock:core', createMemoryStorage()),
      get: () => this.snapshot.push ?? PushController.initial(this.cfg, pushPlatform),
      set: (push) => {
        this.setSnapshot({ push });
        this.emit('push:changed', { push });
      },
      emitAction: (payload) => this.emit('push:action', payload),
    });
    this.push.init();
    if (this.cfg.presence.enabled) this.watch(this.cfg.presence.watch);
  }

  // -------------------------------------------------------------------------
  // Store / events
  // -------------------------------------------------------------------------

  get config(): ResolvedConfig {
    return this.cfg;
  }

  getSnapshot = (): SoftphoneSnapshot => this.snapshot;

  subscribe = (listener: (snapshot: SoftphoneSnapshot) => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  on<K extends keyof SoftphoneEvents>(
    event: K,
    handler: (payload: SoftphoneEvents[K]) => void,
  ): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler);
    return () => {
      set.delete(handler as Handler);
    };
  }

  private emit<K extends keyof SoftphoneEvents>(event: K, payload: SoftphoneEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) {
      try {
        (h as (p: SoftphoneEvents[K]) => void)(payload);
      } catch (error) {
        console.error(`[mock-softphone] handler for "${String(event)}" threw`, error);
      }
    }
  }

  private setSnapshot(patch: Partial<SoftphoneSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.persistResume();
    for (const l of [...this.listeners]) l(this.snapshot);
    this.emit('state:changed', { snapshot: this.snapshot });
  }

  private later(ms: number, fn: () => void, callId?: CallId): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    if (callId) {
      const list = this.callTimers.get(callId) ?? [];
      list.push(t);
      this.callTimers.set(callId, list);
    }
  }

  private clearCallTimers(callId: CallId): void {
    for (const t of this.callTimers.get(callId) ?? []) {
      clearTimeout(t);
      this.timers.delete(t);
    }
    this.callTimers.delete(callId);
  }

  private setApp(state: AppState): void {
    if (this.snapshot.app === state) return;
    this.setSnapshot({ app: state });
    this.emit('app:state', { state });
  }

  private setRegistration(status: RegistrationStatus): void {
    const was = this.snapshot.registration.state === 'registered';
    this.setSnapshot({ registration: status });
    this.emit('registration:state', status);
    this.voicemailList.onRegistration(status.state);
    const now = status.state === 'registered';
    // The mailbox already holds messages: the "PBX" reports them once registered.
    if (now && !was && this.cfg.voicemail.enabled && this.cfg.voicemail.api.baseUrl) {
      const counts = this.voicemailBackend.counts();
      if (counts.new + counts.old > 0) this.simulateVoicemail(counts);
    }
    // The mock "server" reports every watched extension idle once registered; unknown when offline.
    if (now && !was) this.setPresenceStates(Object.keys(this.snapshot.presence), 'idle', 'unknown');
    else if (!now && was) this.setPresenceStates(Object.keys(this.snapshot.presence), 'unknown');
    this.push.onRegistration(status.state);
    if (now) this.finishResume();
  }

  private setPresenceStates(targets: string[], state: PresenceState, onlyFrom?: PresenceState): void {
    const next = { ...this.snapshot.presence };
    const changes: { target: string; presence: PresenceInfo; previous?: PresenceInfo }[] = [];
    for (const target of targets) {
      const previous = next[target];
      if (!previous || previous.state === state || (onlyFrom && previous.state !== onlyFrom)) continue;
      const presence: PresenceInfo = { target, state, updatedAt: Date.now() };
      next[target] = presence;
      changes.push({ target, presence, previous });
    }
    if (!changes.length) return;
    this.setSnapshot({ presence: next });
    for (const c of changes) this.emit('presence:changed', c);
  }

  private notify(
    level: 'info' | 'warning' | 'error',
    title: string,
    message?: string,
    extra?: { code: string; params?: Record<string, string | number> },
  ): void {
    if (!this.cfg.showToasts) return;
    this.emit('notification', { level, title, message, ...extra });
  }

  // -------------------------------------------------------------------------
  // Lifecycle / registration
  // -------------------------------------------------------------------------

  private async setupPlugins(): Promise<void> {
    if (this.pluginsReady) return this.pluginsReady;
    this.pluginsReady = (async () => {
      for (const plugin of this.opts.plugins) {
        const noop = () => undefined;
        const store = new Map<string, unknown>();
        const logger = {
          debug: noop,
          info: noop,
          warn: noop,
          error: noop,
          child: () => logger,
        };
        const instance = await plugin.setup({
          api: this,
          config: this.cfg,
          logger,
          storage: {
            get: <T>(k: string) => store.get(k) as T | undefined,
            set: (k, v) => void store.set(k, v),
            remove: (k) => void store.delete(k),
          },
        });
        this.pluginApis.set(plugin.id, instance);
      }
    })();
    return this.pluginsReady;
  }

  async start(): Promise<void> {
    await this.setupPlugins();
    this.setApp('started');
    if (this.pendingResume) this.restoreResume(this.pendingResume);
    if (this.cfg.autoRegister && this.cfg.username) await this.register();
  }

  async stop(): Promise<void> {
    await this.hangupAll();
    this.clearResume();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.snapshot.registration.state !== 'idle') this.setRegistration({ state: 'unregistered' });
    this.setApp('stopped');
  }

  /** Stop and release plugins. */
  async destroy(): Promise<void> {
    await this.stop();
    this.voicemailList.dispose();
    for (const p of this.pluginApis.values()) await p.dispose?.();
    this.pluginApis.clear();
    this.push.dispose();
    this.handlers.clear();
    this.listeners.clear();
  }

  register(): Promise<void> {
    if (!this.cfg.username) {
      this.setRegistration({ state: 'failed', reason: 'Username is required' });
      this.notify('error', 'Registration failed', 'Username is required');
      return Promise.resolve();
    }
    if (this.snapshot.app !== 'started') this.setApp('started');
    this.setRegistration({ state: 'connecting' });
    return new Promise((resolve) => {
      const half = Math.max(0, Math.floor(this.opts.registerDelayMs / 2));
      this.later(half, () => {
        this.setRegistration({ state: 'registering' });
        this.later(this.opts.registerDelayMs - half, () => {
          if (this.cfg.password === this.opts.rejectPassword) {
            this.setRegistration({ state: 'failed', reason: 'Forbidden', code: 403 });
            this.notify('error', 'Registration failed', '403 Forbidden — check your credentials');
          } else {
            this.setRegistration({ state: 'registered' });
            this.notify('info', 'Registered', `Signed in as ${this.cfg.username}`);
          }
          resolve();
        });
      });
    });
  }

  async unregister(): Promise<void> {
    await this.hangupAll();
    this.setRegistration({ state: 'unregistered' });
    this.clearResume();
  }

  // -------------------------------------------------------------------------
  // Reload-safe softphone (V2-RESUME-01)
  // -------------------------------------------------------------------------

  private loadResume(): MockResumeSession | null {
    if (!this.cfg.resume.enabled || !this.resumeStore) return null;
    try {
      const raw = this.resumeStore.getItem(MOCK_RESUME_KEY);
      const parsed = raw ? (JSON.parse(raw) as MockResumeSession) : null;
      const snapshot = parseResumeSnapshot(parsed);
      if (!parsed || !snapshot || !snapshot.username) return null;
      const stale = Date.now() - snapshot.savedAt > this.cfg.resume.rejoinTimeoutMs;
      return { ...snapshot, calls: stale ? [] : snapshot.calls, password: parsed.password, dnd: parsed.dnd };
    } catch {
      return null;
    }
  }

  exportResumeState(): ResumeSnapshot | null {
    if (!this.cfg.resume.enabled) return null;
    const calls = this.snapshot.calls
      .filter((c) => c.anchorId && (c.state === 'connected' || c.state === 'held'))
      .map((c) => ({
        id: c.id,
        anchorId: c.anchorId!,
        line: c.line,
        direction: c.direction,
        remoteNumber: c.remoteNumber,
        ...(c.remoteDisplayName ? { remoteDisplayName: c.remoteDisplayName } : {}),
        createdAt: c.createdAt,
        ...(c.connectedAt !== undefined ? { connectedAt: c.connectedAt } : {}),
        muted: c.muted,
        held: c.state === 'held',
      }));
    const active = this.snapshot.activeCallId;
    return {
      version: 1,
      savedAt: Date.now(),
      username: this.cfg.username,
      activeCallId: calls.some((c) => c.id === active) ? active : (calls[0]?.id ?? null),
      calls,
    };
  }

  private persistResume(): void {
    if (!this.cfg.resume.enabled || !this.resumeStore || this.pendingResume) return;
    const state = this.exportResumeState();
    const signedIn = this.snapshot.registration.state === 'registered' || this.snapshot.resume?.state === 'resuming';
    try {
      if (state && (signedIn || state.calls.length > 0)) {
        const session: MockResumeSession = { ...state, password: this.cfg.password, dnd: this.snapshot.dnd };
        this.resumeStore.setItem(MOCK_RESUME_KEY, JSON.stringify(session));
      }
    } catch {
      /* storage blocked */
    }
  }

  private clearResume(): void {
    try {
      this.resumeStore?.removeItem(MOCK_RESUME_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Put restored calls back (same id + start time, `resuming`) and "rejoin" them once registered. */
  private restoreResume(state: ResumeSnapshot): void {
    this.pendingResume = null;
    const calls: Call[] = state.calls
      .filter((c) => !this.snapshot.calls.some((x) => x.id === c.id))
      .map((c) => ({
        id: c.id,
        line: c.line,
        direction: c.direction,
        state: c.held ? 'held' : 'connected',
        remoteNumber: c.remoteNumber,
        ...(c.remoteDisplayName ? { remoteDisplayName: c.remoteDisplayName } : {}),
        muted: c.muted,
        hold: c.held ? 'local' : 'none',
        createdAt: c.createdAt,
        connectedAt: c.connectedAt ?? c.createdAt,
        sipCallId: `${c.id}@mock`,
        inConference: false,
        meta: {},
        anchorId: c.anchorId,
        resuming: true,
      }));
    for (const call of calls) {
      this.resumingIds.add(call.id);
      this.addCall(call, false);
    }
    const active = state.activeCallId && calls.some((c) => c.id === state.activeCallId) ? state.activeCallId : (calls[0]?.id ?? null);
    this.setSnapshot({ resume: { state: 'resuming', pendingCalls: calls.length }, ...(active ? { activeCallId: active } : {}) });
    this.emit('registration:resuming', { calls: calls.map((c) => c.id) });
  }

  /** Called once registered: the restored calls come back one after the other. */
  private finishResume(): void {
    if (this.snapshot.resume?.state !== 'resuming') return;
    const ids = [...this.resumingIds];
    if (ids.length === 0) {
      this.setSnapshot({ resume: { ...IDLE_RESUME } });
      return;
    }
    this.later(this.opts.resumeDelayMs, () => {
      for (const id of ids) {
        this.resumingIds.delete(id);
        const call = this.updateCall(id, { resuming: false });
        if (call) this.emit('call:resumed', { call });
      }
      this.setSnapshot({ resume: { ...IDLE_RESUME } });
    });
  }

  async resume(state?: ResumeSnapshot): Promise<void> {
    // Same contract as core Softphone.resume(): safe to call instead of start()
    // (leader-tab takeover); without resume.enabled it is just start().
    if (this.snapshot.app !== 'started') await this.start();
    if (!this.cfg.resume.enabled) return;
    const snapshot = state === undefined ? this.loadResume() : parseResumeSnapshot(state);
    if (!snapshot) return;
    this.restoreResume(snapshot);
    if (this.snapshot.registration.state === 'registered') this.finishResume();
  }

  async updateConfig(patch: SoftphoneConfigInput): Promise<void> {
    const credentialsChanged =
      ('username' in patch && patch.username !== this.cfg.username) ||
      ('password' in patch && patch.password !== this.cfg.password) ||
      ('domain' in patch && patch.domain !== this.cfg.domain) ||
      'websocketUrls' in patch;
    const prev = this.cfg;
    this.cfg = resolveConfig({ ...this.cfg, ...patch });
    this.chat.reconcile();
    this.voicemailList.reconcile();
    this.push.reconcile(prev);
    // Force subscribers to re-read config-derived values.
    this.setSnapshot({});
    if (credentialsChanged && this.snapshot.registration.state === 'registered') {
      await this.register();
    }
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private get liveCalls(): Call[] {
    return this.snapshot.calls.filter((c) => LIVE_STATES.has(c.state));
  }

  private findCall(callId?: CallId): Call | undefined {
    const id = callId ?? this.snapshot.activeCallId ?? undefined;
    if (!id) return undefined;
    return this.snapshot.calls.find((c) => c.id === id);
  }

  private requireCall(callId?: CallId): Call {
    const call = this.findCall(callId);
    if (!call) throw new Error(callId ? `Unknown call ${callId}` : 'No active call');
    return call;
  }

  private nextLine(): number {
    const used = new Set(this.snapshot.calls.map((c) => c.line));
    for (let line = 1; line <= this.cfg.maxLines; line++) if (!used.has(line)) return line;
    throw new Error(`All ${this.cfg.maxLines} lines are busy`);
  }

  private updateCall(id: CallId, patch: Partial<Call>): Call | undefined {
    const previous = this.snapshot.calls.find((c) => c.id === id);
    if (!previous) return undefined;
    const call: Call = { ...previous, ...patch };
    this.setSnapshot({ calls: this.snapshot.calls.map((c) => (c.id === id ? call : c)) });
    this.emit('call:updated', { call, previous });
    if (call.state === 'connected' && !this.quality.has(id)) this.startQuality(id);
    return call;
  }

  /** Sample synthetic RTP stats through the real core quality computation. */
  private startQuality(id: CallId): void {
    const intervalMs = this.cfg.callQualityInterval * 1000;
    if (!(intervalMs > 0)) return;
    const q = { stats: new SyntheticCallStats(this.network), tracker: new QualityTracker(), summary: new QualitySummaryBuilder() };
    this.quality.set(id, q);
    const tick = () => {
      const call = this.snapshot.calls.find((c) => c.id === id);
      if (!call || call.state === 'disconnected' || this.quality.get(id) !== q) return;
      if (call.state === 'connected' && call.hold === 'none') {
        const quality = q.tracker.push(q.stats.next());
        q.summary.add(quality);
        this.updateCall(id, { quality });
        this.emit('call:quality', { callId: id, quality });
      } else {
        q.tracker.prime(q.stats.next()); // on hold: keep the baseline current
      }
      this.later(intervalMs, tick, id);
    };
    this.later(intervalMs, tick, id);
  }

  private addCall(call: Call, makeActive: boolean): void {
    if (makeActive && this.cfg.autoHoldOtherLines) {
      for (const other of this.liveCalls) {
        if (other.state === 'connected' && !other.inConference) {
          this.updateCall(other.id, { state: 'held', hold: 'local' });
        }
      }
    }
    this.setSnapshot({
      calls: [...this.snapshot.calls, call],
      activeCallId: makeActive || !this.snapshot.activeCallId ? call.id : this.snapshot.activeCallId,
    });
    this.emit('call:created', { call });
  }

  private endCall(id: CallId, reason: DisconnectReason, code?: number): void {
    const existing = this.snapshot.calls.find((c) => c.id === id);
    if (!existing || existing.state === 'disconnected') return;
    this.clearCallTimers(id);
    this.pendingDtmf.delete(id);
    this.stopVideo(id);
    const qualitySummary = this.quality.get(id)?.summary.build();
    this.quality.delete(id);
    const ended = this.updateCall(id, {
      state: 'disconnected',
      endedAt: Date.now(),
      disconnectReason: reason,
      disconnectCode: code,
      inConference: false,
    });
    if (!ended) return;
    const remaining = this.snapshot.calls.filter((c) => c.id !== id);
    // Conference with a single participant is no longer a conference.
    const confMembers = remaining.filter((c) => c.inConference);
    const fixed =
      confMembers.length === 1
        ? remaining.map((c) => (c.inConference ? { ...c, inConference: false } : c))
        : remaining;
    let activeCallId = this.snapshot.activeCallId;
    if (activeCallId === id) {
      const next =
        fixed.find((c) => c.state === 'connected') ?? fixed.find((c) => LIVE_STATES.has(c.state));
      activeCallId = next?.id ?? null;
    }
    this.setSnapshot({ calls: fixed, activeCallId });
    this.emit('call:ended', { call: ended });

    const cdr: Cdr = {
      callId: ended.id,
      sipCallId: ended.sipCallId,
      line: ended.line,
      direction: ended.direction,
      caller: ended.direction === 'outgoing' ? this.cfg.username : ended.remoteNumber,
      called: ended.direction === 'outgoing' ? ended.remoteNumber : this.cfg.username,
      remoteDisplayName: ended.remoteDisplayName,
      startedAt: ended.createdAt,
      connectedAt: ended.connectedAt,
      endedAt: ended.endedAt ?? Date.now(),
      durationMs: ended.connectedAt ? (ended.endedAt ?? Date.now()) - ended.connectedAt : 0,
      reason,
      code,
    };
    if (qualitySummary) cdr.quality = qualitySummary;
    this.cdrs.push(cdr);
    this.emit('cdr', cdr);
  }

  private normalize(number: string): string {
    let n = number.trim();
    if (this.cfg.normalizeNumbers) n = n.replace(/[\s\-().]/g, '');
    return n;
  }

  async call(number: string, options?: CallOptions): Promise<Call> {
    if (this.snapshot.registration.state !== 'registered') {
      this.notify('warning', 'Not registered', 'Sign in before placing calls');
      throw new Error('Not registered');
    }
    const video = options?.video ?? (this.cfg.video.enabled && this.cfg.video.defaultOn);
    if (video && !this.cfg.video.enabled) throw new Error('Video is disabled (config video.enabled)');
    const [first = '', dtmf] = this.normalize(number).split(',', 2);
    let target = first;
    for (const instance of this.pluginApis.values()) {
      if (instance.hooks?.beforeDial) target = await instance.hooks.beforeDial(target);
    }
    if (!target) throw new Error('Nothing to dial');
    const id = `mock-${++this.seq}`;
    const call: Call = {
      id,
      line: this.nextLine(),
      direction: 'outgoing',
      state: 'setup',
      remoteNumber: target,
      muted: false,
      hold: 'none',
      createdAt: Date.now(),
      inConference: false,
      meta: {},
      ...(video ? { hasVideo: true, cameraOn: true, remoteVideo: false } : {}),
      ...(this.cfg.resume.enabled ? { anchorId: newAnchorId() } : {}),
    };
    if (dtmf) this.pendingDtmf.set(id, dtmf);
    this.addCall(call, true);
    if (video) this.syncVideo(id);

    const dialed = this.cfg.techPrefix + target;
    if (this.opts.busyNumbers.includes(target) || this.opts.busyNumbers.includes(dialed)) {
      this.later(this.opts.ringDelayMs, () => this.endCall(id, 'busy', 486), id);
      return call;
    }
    this.later(
      this.opts.ringDelayMs,
      () => {
        this.updateCall(id, { state: 'ringing' });
      },
      id,
    );
    if (!this.opts.noAnswerNumbers.includes(target)) {
      this.later(
        Math.max(this.opts.connectDelayMs, this.opts.ringDelayMs),
        () => {
          const current = this.findCall(id);
          if (!current || !LIVE_STATES.has(current.state)) return;
          this.updateCall(id, {
            state: 'connected',
            connectedAt: Date.now(),
            sipCallId: `${id}@mock`,
            ...(current.hasVideo ? { remoteVideo: true } : {}),
          });
          if (current.hasVideo) this.syncVideo(id);
          const tones = this.pendingDtmf.get(id);
          if (tones) {
            this.pendingDtmf.delete(id);
            void this.sendDtmf(tones, id);
          }
        },
        id,
      );
    }
    return call;
  }

  async answer(callId?: CallId, options?: AnswerOptions): Promise<void> {
    const call = callId
      ? this.requireCall(callId)
      : (this.snapshot.calls.find((c) => c.direction === 'incoming' && c.state === 'ringing') ??
        this.requireCall());
    if (call.direction !== 'incoming' || (call.state !== 'ringing' && call.state !== 'setup')) {
      return;
    }
    if (this.cfg.autoHoldOtherLines) {
      for (const other of this.liveCalls) {
        if (other.id !== call.id && other.state === 'connected' && !other.inConference) {
          this.updateCall(other.id, { state: 'held', hold: 'local' });
        }
      }
    }
    const video = Boolean(call.hasVideo) && this.cfg.video.enabled && (options?.video ?? this.cfg.video.defaultOn);
    this.updateCall(call.id, {
      state: 'connected',
      connectedAt: Date.now(),
      sipCallId: `${call.id}@mock`,
      // Reload-safe calls: the mock "PBX" anchors every answered call (docs/resume.md).
      ...(this.cfg.resume.enabled ? { anchorId: newAnchorId() } : {}),
      ...(call.hasVideo
        ? video
          ? { cameraOn: true, remoteVideo: true }
          : { hasVideo: false, cameraOn: false, remoteVideo: false }
        : {}),
    });
    this.setSnapshot({ activeCallId: call.id });
    if (call.hasVideo) this.syncVideo(call.id);
  }

  async reject(callId?: CallId, statusCode = 486): Promise<void> {
    const call = callId
      ? this.requireCall(callId)
      : this.snapshot.calls.find((c) => c.direction === 'incoming' && c.state === 'ringing');
    if (!call) return;
    this.endCall(call.id, 'rejected', statusCode);
  }

  async forward(target: string, callId?: CallId): Promise<void> {
    const call = callId
      ? this.requireCall(callId)
      : this.snapshot.calls.find((c) => c.direction === 'incoming' && c.state === 'ringing');
    if (!call || call.direction !== 'incoming' || call.state === 'connected') return;
    this.notify('info', 'Call forwarded', `Forwarded ${call.remoteNumber} to ${this.normalize(target)}`);
    this.endCall(call.id, 'transferred', 302);
  }

  async hangup(callId?: CallId): Promise<void> {
    const call = this.findCall(callId);
    if (!call) return;
    if (call.direction === 'incoming' && call.state === 'ringing') {
      this.endCall(call.id, 'rejected', 486);
    } else if (call.state === 'connected' || call.state === 'held') {
      this.endCall(call.id, 'local-hangup');
    } else {
      this.endCall(call.id, 'cancelled', 487);
    }
  }

  async hangupAll(): Promise<void> {
    for (const call of [...this.snapshot.calls]) await this.hangup(call.id);
  }

  async hold(hold: boolean, callId?: CallId): Promise<void> {
    const call = this.requireCall(callId);
    if (hold && call.state === 'connected') {
      this.updateCall(call.id, { state: 'held', hold: call.hold === 'remote' ? 'both' : 'local' });
    } else if (!hold && call.state === 'held') {
      if (this.cfg.autoHoldOtherLines) {
        for (const other of this.liveCalls) {
          if (other.id !== call.id && other.state === 'connected' && !other.inConference) {
            this.updateCall(other.id, { state: 'held', hold: 'local' });
          }
        }
      }
      this.updateCall(call.id, {
        state: 'connected',
        hold: call.hold === 'both' ? 'remote' : 'none',
      });
      this.setSnapshot({ activeCallId: call.id });
    }
  }

  mute(muted: boolean, callId?: CallId): void {
    const call = this.findCall(callId);
    if (!call) return;
    if (call.inConference) {
      for (const c of this.snapshot.calls) if (c.inConference) this.updateCall(c.id, { muted });
    } else {
      this.updateCall(call.id, { muted });
    }
  }

  async sendDtmf(tones: string, callId?: CallId): Promise<void> {
    const call = this.requireCall(callId);
    const clean = tones.replace(/[^0-9A-D*#]/gi, '');
    if (!clean) return;
    this.dtmfLog.push({ callId: call.id, tones: clean });
  }

  async transfer(target: string, callId?: CallId): Promise<void> {
    const call = this.requireCall(callId);
    const to = this.normalize(target);
    if (!to) throw new Error('Transfer target is required');
    this.notify('info', 'Call transferred', `Transferred ${call.remoteNumber} to ${to}`);
    this.endCall(call.id, 'transferred', 202);
  }

  async startAttendedTransfer(target: string, callId?: CallId): Promise<Call> {
    const original = this.requireCall(callId);
    if (original.state === 'connected') await this.hold(true, original.id);
    const consult = await this.call(target);
    this.updateCall(consult.id, { meta: { ...consult.meta, consultFor: original.id } });
    return this.findCall(consult.id) ?? consult;
  }

  async completeAttendedTransfer(originalCallId: CallId, consultCallId: CallId): Promise<void> {
    const original = this.requireCall(originalCallId);
    const consult = this.requireCall(consultCallId);
    this.notify(
      'info',
      'Call transferred',
      `Connected ${original.remoteNumber} with ${consult.remoteNumber}`,
    );
    this.endCall(consult.id, 'transferred', 202);
    this.endCall(original.id, 'transferred', 202);
  }

  /** Server conference mode: a room leg stands in for the PBX ConfBridge (parties are "transferred"). */
  private serverConference(candidates: Call[]): void {
    const parties = candidates.filter((c) => !c.conference && (c.state === 'connected' || c.state === 'held'));
    let room = this.snapshot.calls.find((c) => c.conference && c.state !== 'disconnected');
    if (parties.length < (room ? 1 : 2)) {
      this.notify('warning', 'Conference', 'At least two connected calls are needed');
      return;
    }
    if (!room) {
      const { serverRoomPrefix, serverRoom, serverEndOnLeave } = this.cfg.conference;
      const target = `${serverRoomPrefix}${serverRoom || this.cfg.username || '1001'}`;
      room = {
        id: `mock-${++this.seq}`,
        line: Math.max(0, ...this.snapshot.calls.map((c) => c.line)) + 1,
        direction: 'outgoing',
        state: 'connected',
        remoteNumber: target,
        muted: false,
        hold: 'none',
        createdAt: Date.now(),
        connectedAt: Date.now(),
        inConference: true,
        conference: { room: target, participants: [], capabilities: serverConferenceCapabilities(serverEndOnLeave) },
        meta: {},
      };
      this.addCall(room, true);
    }
    const roomId = room.id;
    for (const party of parties) {
      const current = this.findCall(roomId)?.conference;
      if (!current) break;
      this.updateCall(roomId, {
        conference: {
          ...current,
          participants: [
            ...current.participants,
            { id: party.id, remoteNumber: party.remoteNumber, remoteDisplayName: party.remoteDisplayName, joinedAt: Date.now() },
          ],
        },
      });
      this.endCall(party.id, 'transferred');
    }
    this.setSnapshot({ activeCallId: roomId });
  }

  private rejectServerConference(call: Call): void {
    if (call.conference) throw new Error('Not supported for a server conference');
  }

  async conference(callIds?: CallId[]): Promise<void> {
    if (this.cfg.conference.mode === 'server') {
      this.serverConference(callIds ? callIds.map((id) => this.requireCall(id)) : this.liveCalls);
      return;
    }
    const members = (callIds ? callIds.map((id) => this.requireCall(id)) : this.liveCalls).filter(
      (c) => c.state === 'connected' || c.state === 'held',
    );
    if (members.length < 2) {
      this.notify('warning', 'Conference', 'At least two connected calls are needed');
      return;
    }
    for (const c of members) {
      // Conferences are audio-only: cameras go off.
      this.updateCall(c.id, { inConference: true, state: 'connected', hold: 'none', ...(c.cameraOn ? { cameraOn: false } : {}) });
      if (c.cameraOn) this.syncVideo(c.id);
    }
    this.notify('info', 'Conference started', `${members.length} parties connected`);
  }

  async removeFromConference(callId: CallId): Promise<void> {
    const call = this.requireCall(callId);
    this.rejectServerConference(call);
    if (!call.inConference) throw new Error('Call is not in the conference');
    this.updateCall(call.id, { inConference: false, partyMuted: false, state: 'held', hold: 'local' });
    const rest = this.snapshot.calls.filter((c) => c.inConference);
    if (rest.length === 1) this.updateCall(rest[0]!.id, { inConference: false, partyMuted: false });
    if (this.snapshot.activeCallId === call.id && rest[0]) this.setSnapshot({ activeCallId: rest[0].id });
  }

  async splitConference(keepCallId?: CallId): Promise<void> {
    const members = this.snapshot.calls.filter((c) => c.inConference);
    if (members.length === 0) throw new Error('There is no conference to split');
    members.forEach((c) => this.rejectServerConference(c));
    const keep =
      members.find((c) => c.id === keepCallId) ??
      members.find((c) => c.id === this.snapshot.activeCallId) ??
      members[0]!;
    for (const c of members) {
      this.updateCall(
        c.id,
        c.id === keep.id
          ? { inConference: false, partyMuted: false }
          : { inConference: false, partyMuted: false, state: 'held', hold: 'local' },
      );
    }
    this.setSnapshot({ activeCallId: keep.id });
  }

  setPartyMuted(callId: CallId, muted: boolean): void {
    const call = this.requireCall(callId);
    this.rejectServerConference(call);
    if (!call.inConference) throw new Error('Only conference parties can be muted individually');
    this.updateCall(call.id, { partyMuted: muted });
  }

  setActiveCall(callId: CallId): void {
    if (!this.snapshot.calls.some((c) => c.id === callId)) return;
    this.setSnapshot({ activeCallId: callId });
  }

  // -------------------------------------------------------------------------
  // Video (V2-VID-01): synthetic canvas streams
  // -------------------------------------------------------------------------

  async setVideo(on: boolean, callId?: CallId): Promise<void> {
    const call = this.requireCall(callId);
    if (call.state !== 'connected' && call.state !== 'held') throw new Error(`Cannot change video in state "${call.state}"`);
    if (on && !this.cfg.video.enabled) throw new Error('Video is disabled (config video.enabled)');
    if (on && call.inConference) throw new Error('Conferences are audio-only');
    if (Boolean(call.cameraOn) === on && (!on || call.hasVideo)) return;
    this.updateCall(call.id, { cameraOn: on, hasVideo: Boolean(call.hasVideo) || on, remoteVideo: Boolean(call.remoteVideo) });
    this.syncVideo(call.id);
  }

  getVideoStreams(callId?: CallId): CallVideoStreams {
    const call = this.findCall(callId);
    const entry = call ? this.video.get(call.id) : undefined;
    return entry?.streams ? { ...entry.streams } : {};
  }

  /** Simulate the remote party turning its camera on/off (default: active call). */
  simulateRemoteVideo(on: boolean, callId?: CallId): void {
    const call = this.findCall(callId);
    if (!call || !this.cfg.video.enabled) return;
    this.updateCall(call.id, { remoteVideo: on, hasVideo: Boolean(call.hasVideo) || on, cameraOn: Boolean(call.cameraOn) });
    this.syncVideo(call.id);
  }

  /** Start/stop the synthetic tracks to match the call and emit `call:video`. */
  private syncVideo(id: CallId): void {
    const call = this.snapshot.calls.find((c) => c.id === id);
    if (!call) return;
    let entry = this.video.get(id);
    if (!entry) {
      entry = {};
      this.video.set(id, entry);
    }
    if (!entry.streams && typeof MediaStream !== 'undefined') {
      entry.streams = { local: new MediaStream(), remote: new MediaStream() };
    }
    const wantLocal = Boolean(call.hasVideo && call.cameraOn);
    const wantRemote = Boolean(call.hasVideo && call.remoteVideo);
    if (wantLocal && !entry.local) entry.local = createSyntheticVideo(this.cfg.username || 'You', 160);
    if (!wantLocal && entry.local) {
      entry.local.stop();
      entry.local = undefined;
    }
    if (wantRemote && !entry.remote) entry.remote = createSyntheticVideo(call.remoteDisplayName || call.remoteNumber, 260);
    if (!wantRemote && entry.remote) {
      entry.remote.stop();
      entry.remote = undefined;
    }
    if (entry.streams) {
      setOnly(entry.streams.local, entry.local?.track);
      setOnly(entry.streams.remote, entry.remote?.track);
    }
    this.emit('call:video', {
      callId: id,
      hasVideo: Boolean(call.hasVideo),
      cameraOn: Boolean(call.cameraOn),
      remoteVideo: Boolean(call.remoteVideo),
    });
  }

  private stopVideo(id: CallId): void {
    const entry = this.video.get(id);
    if (!entry) return;
    entry.local?.stop();
    entry.remote?.stop();
    if (entry.streams) {
      setOnly(entry.streams.local, undefined);
      setOnly(entry.streams.remote, undefined);
    }
    this.video.delete(id);
  }

  private failServerDnd = false;
  private dndOps = 0;

  /** Server DND mode: make the next feature-code "call" fail (the toggle reverts). */
  failNextServerDnd(): void {
    this.failServerDnd = true;
  }

  private applyDnd(dnd: boolean): void {
    if (this.snapshot.dnd === dnd) return;
    this.setSnapshot({ dnd });
    this.emit('dnd:changed', { dnd });
  }

  setDnd(on: boolean): Promise<void> {
    const dnd = Boolean(on);
    const previous = this.snapshot.dnd;
    if (previous === dnd) return Promise.resolve();
    this.applyDnd(dnd);
    if (this.cfg.dnd.mode === 'local') return Promise.resolve();
    // Server modes: simulate the silent feature-code call (dnd.serverOn / serverOff).
    this.dndOps += 1;
    this.setSnapshot({ dndPending: true });
    return new Promise<void>((resolve, reject) => {
      this.later(400, () => {
        this.dndOps -= 1;
        if (this.dndOps === 0) this.setSnapshot({ dndPending: false });
        if (!this.failServerDnd) return resolve();
        this.failServerDnd = false;
        if (this.snapshot.dnd === dnd) this.applyDnd(previous);
        const state = dnd ? 'on' : 'off';
        this.notify('error', 'Do Not Disturb', `Could not turn Do Not Disturb ${state} on the server (SIP 404)`, {
          code: 'dndServerFailed',
          params: { state, reason: 'SIP 404' },
        });
        reject(new Error(`Server-side DND ${state} failed: SIP 404`));
      });
    });
  }

  watch(targets: string | string[]): void {
    if (!this.cfg.presence.enabled) throw new Error('Presence is disabled (config presence.enabled)');
    const list = [...new Set((typeof targets === 'string' ? [targets] : targets).map((t) => t.trim()).filter(Boolean))];
    const next = { ...this.snapshot.presence };
    const added: PresenceInfo[] = [];
    const state: PresenceState = this.snapshot.registration.state === 'registered' ? 'idle' : 'unknown';
    for (const target of list) {
      if (next[target] || Object.keys(next).length >= this.cfg.presence.maxWatched) continue;
      next[target] = { target, state, updatedAt: Date.now() };
      added.push(next[target]);
    }
    if (!added.length) return;
    this.setSnapshot({ presence: next });
    for (const presence of added) this.emit('presence:changed', { target: presence.target, presence });
  }

  unwatch(targets: string | string[]): void {
    const next = { ...this.snapshot.presence };
    const removed: PresenceInfo[] = [];
    for (const target of typeof targets === 'string' ? [targets] : targets) {
      const previous = next[target.trim()];
      if (!previous) continue;
      delete next[previous.target];
      removed.push(previous);
    }
    if (!removed.length) return;
    this.setSnapshot({ presence: next });
    for (const previous of removed) this.emit('presence:changed', { target: previous.target, previous });
  }

  /** Directed pickup: dials `presence.pickupPrefix` + extension; a ringing mock lamp goes idle. */
  async pickup(extension: string): Promise<Call> {
    const ext = extension.trim().replace(/^sips?:([^@]+)@.*$/i, '$1');
    if (!ext) throw new Error('Invalid pickup extension');
    const call = await this.call(`${this.cfg.presence.pickupPrefix}${ext}`);
    if (this.snapshot.presence[ext]?.state === 'ringing') this.setPresenceStates([ext], 'idle');
    return call;
  }

  async callVoicemail(): Promise<Call> {
    const number = this.cfg.voicemail.number.trim() || voicemailNumberFromAccount(this.snapshot.voicemail.account);
    if (!number) throw new Error('No voicemail number configured');
    return this.call(number);
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  async sendMessage(to: string, body: string): Promise<ChatMessage> {
    if (this.cfg.chat.enabled && this.snapshot.registration.state !== 'registered') {
      throw new Error('Not registered');
    }
    return this.chat.send(to, body);
  }

  markConversationRead(peer: string): void {
    this.chat.markRead(peer);
  }

  deleteConversation(peer: string): void {
    this.chat.deleteConversation(peer);
  }

  // -------------------------------------------------------------------------
  // Devices / plugins
  // -------------------------------------------------------------------------

  async listDevices(): Promise<AudioDevice[]> {
    return this.snapshot.devices.available;
  }

  async setDevice(kind: AudioDeviceKind, deviceId: string): Promise<void> {
    this.setSnapshot({
      devices: {
        ...this.snapshot.devices,
        selected: { ...this.snapshot.devices.selected, [kind]: deviceId },
      },
    });
  }

  setVolume(kind: AudioDeviceKind, volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    this.setSnapshot({
      devices: {
        ...this.snapshot.devices,
        volume: { ...this.snapshot.devices.volume, [kind]: v },
      },
    });
  }

  plugin<T = unknown>(id: string): T | undefined {
    return this.pluginApis.get(id)?.api as T | undefined;
  }

  // -------------------------------------------------------------------------
  // Simulation helpers (not part of SoftphoneApi)
  // -------------------------------------------------------------------------

  /**
   * Simulate a BLF / presence NOTIFY for a watched extension, e.g.
   * `simulatePresence('1002', 'ringing', { remoteNumber: '5550100' })`. Ignored for unwatched targets.
   */
  simulatePresence(target: string, state: PresenceState, details: Omit<PresenceReport, 'state'> = {}): void {
    const previous = this.snapshot.presence[target];
    if (!previous) return;
    const presence: PresenceInfo = { ...details, target, state, updatedAt: Date.now() };
    this.setSnapshot({ presence: { ...this.snapshot.presence, [target]: presence } });
    this.emit('presence:changed', { target, presence, previous });
  }

  /** Simulate an incoming chat message. Returns the SIP status (480 while chat is disabled). */
  simulateIncomingMessage(from: string, body: string, displayName?: string): number {
    return this.chat.receive({ from, body, contentType: 'text/plain', fromDisplayName: displayName });
  }

  /** Simulate a PBX delivery report marking a sent message failed. */
  simulateDeliveryFailure(messageId: string): void {
    this.chat.receive({ from: 'pbx', body: '', contentType: 'text/plain', deliveryReport: { status: 'failed', messageId } });
  }

  /** Simulate a message-summary NOTIFY (ignored unless `voicemail.enabled`). */
  simulateVoicemail(counts: Partial<VoicemailState>): void {
    if (!this.cfg.voicemail.enabled) return;
    const previous = this.snapshot.voicemail;
    const voicemail: VoicemailState = { ...EMPTY_MESSAGE_SUMMARY, waiting: (counts.new ?? 0) > 0, ...counts };
    this.setSnapshot({ voicemail });
    this.emit('voicemail:updated', { voicemail, previous });
    this.voicemailList.onSummary(voicemail, previous);
  }

  /**
   * Leave a voicemail in the in-memory mailbox (V2-VM-02). Bumps the MWI
   * counts, which reloads the list when `voicemail.api` is configured.
   */
  simulateVoicemailMessage(input: MockVoicemailInput = {}): VoicemailMessage {
    return this.voicemailBackend.add(input);
  }

  // -------------------------------------------------------------------------
  // Voicemail list (V2-VM-02)
  // -------------------------------------------------------------------------

  refreshVoicemails(): Promise<VoicemailMessage[]> {
    return this.voicemailList.refresh();
  }

  markVoicemailRead(id: string): Promise<void> {
    return this.voicemailList.markRead(id);
  }

  deleteVoicemail(id: string): Promise<void> {
    return this.voicemailList.delete(id);
  }

  getVoicemailAudio(id: string): Promise<Blob> {
    return this.voicemailList.fetchAudio(id);
  }

  /** Simulate a new incoming call. Returns the created call (undefined if rejected: busy, DND, no line). */
  simulateIncomingCall(
    remoteNumber: string,
    remoteDisplayName?: string,
    options: { video?: boolean; pushId?: string } = {},
  ): Call | undefined {
    if (this.snapshot.registration.state !== 'registered') return undefined;
    // Server-side DND: the PBX answers busy, the browser never sees the INVITE.
    if (this.snapshot.dnd && this.cfg.dnd.mode === 'server') return undefined;
    if (this.snapshot.dnd) {
      const now = Date.now();
      const cdr: Cdr = {
        callId: `mock-${++this.seq}`,
        line: 0,
        direction: 'incoming',
        caller: remoteNumber,
        called: this.cfg.username,
        remoteDisplayName,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        reason: 'dnd',
        code: this.cfg.dnd.rejectCode,
      };
      this.cdrs.push(cdr);
      this.emit('cdr', cdr);
      this.notify('info', 'Missed call', `${remoteDisplayName ?? remoteNumber} (Do Not Disturb)`);
      return undefined;
    }
    const busy = this.liveCalls.length > 0;
    if (busy && this.cfg.rejectOnBusy) return undefined;
    let line: number;
    try {
      line = this.nextLine();
    } catch {
      return undefined;
    }
    const call: Call = {
      id: `mock-${++this.seq}`,
      line,
      direction: 'incoming',
      state: 'ringing',
      remoteNumber,
      remoteDisplayName,
      muted: false,
      hold: 'none',
      createdAt: Date.now(),
      inConference: false,
      meta: {},
      ...(options.video && this.cfg.video.enabled ? { hasVideo: true, cameraOn: false, remoteVideo: false } : {}),
      ...(options.pushId ? { pushId: options.pushId } : {}),
    };
    this.addCall(call, false);
    if (this.push.decide(call) === 'answer') {
      this.later(0, () => void this.answer(call.id), call.id);
    } else if (this.cfg.autoAnswer && !busy) {
      this.later(0, () => void this.answer(call.id), call.id);
    } else {
      // Unanswered incoming calls give up after ringTimeout.
      this.later(this.cfg.ringTimeout * 1000, () => this.endCall(call.id, 'no-answer'), call.id);
    }
    return this.findCall(call.id);
  }

  /** Simulate the remote party hanging up (default: active call). */
  simulateRemoteHangup(callId?: CallId): void {
    const call = this.findCall(callId);
    if (!call) return;
    this.endCall(call.id, call.state === 'connected' || call.state === 'held' ? 'remote-hangup' : 'cancelled');
  }

  /** Simulate the remote party answering an outgoing call immediately. */
  simulateRemoteAnswer(callId?: CallId): void {
    const call = this.findCall(callId);
    if (!call || call.direction !== 'outgoing' || call.state === 'connected') return;
    this.clearCallTimers(call.id);
    this.updateCall(call.id, { state: 'connected', connectedAt: Date.now(), ...(call.hasVideo ? { remoteVideo: true } : {}) });
    if (call.hasVideo) this.syncVideo(call.id);
  }

  /** Simulate the remote party sending DTMF to us. */
  simulateDtmfReceived(digit: string, callId?: CallId): void {
    const call = this.requireCall(callId);
    this.emit('call:dtmf-received', { callId: call.id, digit });
  }

  /**
   * Simulate network conditions for call quality: applies to every current
   * and future call. Presets: 'good' | 'fair' | 'poor'.
   */
  simulateNetwork(conditions: NetworkConditions | NetworkPreset): void {
    this.network = conditions;
    for (const q of this.quality.values()) q.stats.set(conditions);
  }

  // -------------------------------------------------------------------------
  // Push (V2-PUSH-01)
  // -------------------------------------------------------------------------

  subscribePush(): Promise<PushState> {
    return this.push.subscribe();
  }

  unsubscribePush(): Promise<PushState> {
    return this.push.unsubscribe();
  }

  setPushLabels(labels: Partial<PushWorkerLabels>): void {
    this.push.setLabels(labels);
  }

  /** Simulate a notification click (as if the service worker posted it to this page). */
  simulatePushLaunch(launch: Omit<PushLaunch, 'at'>): void {
    this.push.receiveLaunch({ ...launch, at: Date.now() }, false);
  }

  /** Simulate an arbitrary notification (toast). */
  simulateNotification(level: 'info' | 'warning' | 'error', title: string, message?: string): void {
    this.emit('notification', { level, title, message });
  }
}

/** Make `stream` contain exactly `track` (or nothing). */
function setOnly(stream: MediaStream, track: MediaStreamTrack | undefined): void {
  for (const t of stream.getTracks()) if (t !== track) stream.removeTrack(t);
  if (track && !stream.getTracks().includes(track)) stream.addTrack(track);
}

/** Factory with the same shape the UI/embed expects: `(config) => SoftphoneApi`. */
export function createMockSoftphone(
  config: SoftphoneConfigInput = {},
  options?: MockSoftphoneOptions,
): MockSoftphone {
  return new MockSoftphone(config, options);
}
