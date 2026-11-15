import type { ResolvedConfig } from '../config';
import { SoftphoneError } from '../errors';
import type { PluginStorage } from '../plugin';
import type { Call, CallId, Logger, RegistrationState } from '../types';
import type {
  PushLaunch,
  PushPermission,
  PushPlatform,
  PushState,
  PushSubscriptionData,
  PushWorkerLabels,
} from './types';

export interface PushControllerDeps {
  config: () => ResolvedConfig;
  logger: Logger;
  /** Browser integration; `null` where there is none (SSR, tests without a fake). */
  platform: PushPlatform | null;
  /** Remembers that the agent opted in, so the subscription is refreshed after each sign-in. */
  storage: PluginStorage;
  get: () => PushState;
  /** Publish new state (snapshot + `push:changed`). */
  set: (next: PushState) => void;
  emitAction: (payload: { launch: PushLaunch; callId?: CallId }) => void;
  fetch?: typeof fetch;
  now?: () => number;
}

const OPT_IN_KEY = 'push.optedIn';

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The SIP user part: "1001" from "1001" or "sip:1001@pbx". */
function extensionOf(username: string): string {
  return username.replace(/^sips?:/i, '').split('@')[0]!.trim();
}

/**
 * Web Push for incoming calls (V2-PUSH-01). Owns the subscription lifecycle
 * (permission, service worker, push service API), remembers the opt-in and
 * matches notification clicks (deep link / worker message) to the INVITE that
 * follows once the softphone registers. Shared by the Softphone and the mock.
 */
export class PushController {
  private registered = false;
  private vapidKey?: string;
  private labels: Partial<PushWorkerLabels> = {};
  private offWorker?: () => void;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private initialised = false;
  private disposed = false;

  constructor(private readonly d: PushControllerDeps) {}

  /** Initial snapshot state. */
  static initial(cfg: ResolvedConfig, platform: PushPlatform | null): PushState {
    const supported = Boolean(platform?.isSupported());
    return {
      enabled: cfg.push.enabled,
      supported,
      permission: supported ? platform!.permission() : 'unsupported',
      subscribed: false,
      busy: false,
    };
  }

  private get cfg(): ResolvedConfig['push'] {
    return this.d.config().push;
  }

  private get platform(): PushPlatform | null {
    return this.d.platform && this.d.platform.isSupported() ? this.d.platform : null;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private patch(p: Partial<PushState>): void {
    const next: PushState = { ...this.d.get(), ...p };
    for (const k of Object.keys(p) as (keyof PushState)[]) if (p[k] === undefined) delete next[k];
    this.d.set(next);
  }

  private get workerScope(): string | undefined {
    return this.cfg.serviceWorkerScope.trim() || undefined;
  }

  /** Start listening (deep link, worker messages) and read the current state. Call once. */
  init(): void {
    if (this.initialised || this.disposed) return;
    this.initialised = true;
    if (!this.cfg.enabled) return;
    const platform = this.platform;
    if (!platform) return;
    this.offWorker = platform.onWorkerLaunch((launch) => this.receiveLaunch({ ...launch, at: this.now() }, false));
    const fromUrl = platform.readLaunch();
    if (fromUrl) this.receiveLaunch({ ...fromUrl, at: fromUrl.at && fromUrl.at <= this.now() ? fromUrl.at : this.now() }, true);
    void this.refresh();
  }

  /** Re-read permission and whether this browser is subscribed. */
  async refresh(): Promise<void> {
    const platform = this.platform;
    if (!platform || !this.cfg.enabled) return;
    try {
      const sub = await platform.getSubscription(this.cfg.serviceWorkerUrl, this.workerScope);
      this.patch({
        permission: platform.permission(),
        subscribed: Boolean(sub) && this.d.storage.get<boolean>(OPT_IN_KEY) === true,
      });
    } catch (error) {
      this.d.logger.debug('Reading the push subscription failed', error);
    }
  }

  /** Re-evaluate after a config change. */
  reconcile(prev: ResolvedConfig): void {
    const was = prev.push.enabled;
    const now = this.cfg.enabled;
    if (was === now) return;
    this.patch({ enabled: now });
    if (now) {
      this.initialised = false;
      this.init();
      if (this.registered) void this.resync();
    } else {
      this.offWorker?.();
      this.offWorker = undefined;
      this.clearPending();
    }
  }

  /** Feed every registration state change. */
  onRegistration(state: RegistrationState): void {
    const was = this.registered;
    this.registered = state === 'registered';
    if (!this.registered || was || !this.cfg.enabled || !this.platform) return;
    // Online again: the notification is no longer needed (the call rings in the page).
    const platform = this.platform;
    platform.closeNotifications(this.cfg.serviceWorkerUrl, this.workerScope).catch(() => undefined);
    void this.configureWorker();
    void this.resync();
  }

  /** Localised notification texts (sent to the service worker). */
  setLabels(labels: Partial<PushWorkerLabels>): void {
    this.labels = { ...this.labels, ...labels };
    if (this.d.get().subscribed) void this.configureWorker();
  }

  /**
   * Subscribe this browser: notification permission (prompts when 'default';
   * call from a click), service worker, Push API subscription, then
   * `POST {serviceUrl}/subscriptions`.
   */
  async subscribe(): Promise<PushState> {
    const cfg = this.cfg;
    if (!cfg.enabled) throw new SoftphoneError('NOT_SUPPORTED', 'Push is disabled (config push.enabled)');
    const platform = this.platform;
    if (!platform) {
      this.patch({ error: 'unsupported' });
      throw new SoftphoneError('NOT_SUPPORTED', 'This browser does not support Web Push');
    }
    if (!cfg.serviceUrl.trim()) {
      this.patch({ error: 'not-configured' });
      throw new SoftphoneError('NOT_SUPPORTED', 'push.serviceUrl is not configured');
    }
    this.patch({ busy: true, error: undefined });
    try {
      let permission: PushPermission = platform.permission();
      if (permission === 'default') permission = await platform.requestPermission();
      this.patch({ permission });
      if (permission !== 'granted') {
        throw new PushFailure('permission-denied', 'Notification permission was not granted');
      }
      const key = await this.vapidPublicKey();
      let sub: PushSubscriptionData;
      try {
        sub = await platform.subscribe(cfg.serviceWorkerUrl, this.workerScope, key);
      } catch (error) {
        throw new PushFailure('subscribe-failed', `Push subscription failed: ${errorText(error)}`, error);
      }
      await this.sendToService('POST', { subscription: sub, userAgent: platform.userAgent?.() });
      this.d.storage.set(OPT_IN_KEY, true);
      this.patch({ subscribed: true, busy: false });
      await this.configureWorker();
      return this.d.get();
    } catch (error) {
      const code = error instanceof PushFailure ? error.code : 'subscribe-failed';
      this.patch({ busy: false, error: code });
      if (error instanceof SoftphoneError) throw error;
      throw new SoftphoneError('INVALID_STATE', error instanceof Error ? error.message : String(error), { cause: error });
    }
  }

  /** Remove the subscription at the push service and in the browser. */
  async unsubscribe(): Promise<PushState> {
    const platform = this.platform;
    this.d.storage.set(OPT_IN_KEY, false);
    if (!platform) {
      this.patch({ subscribed: false });
      return this.d.get();
    }
    this.patch({ busy: true, error: undefined });
    try {
      const sub = await platform.getSubscription(this.cfg.serviceWorkerUrl, this.workerScope);
      if (sub && this.cfg.serviceUrl.trim()) {
        await this.sendToService('DELETE', { endpoint: sub.endpoint }).catch((error: unknown) =>
          this.d.logger.warn('Removing the subscription from the push service failed', error),
        );
      }
      await platform.unsubscribe(this.cfg.serviceWorkerUrl, this.workerScope);
      this.patch({ subscribed: false, busy: false });
    } catch (error) {
      this.patch({ subscribed: false, busy: false, error: 'subscribe-failed' });
      this.d.logger.warn('Push unsubscribe failed', error);
    }
    return this.d.get();
  }

  /**
   * Incoming-call policy hook: 'answer' when `call` is the call the agent
   * clicked "Answer" for. Consumes the pending launch either way on a match.
   */
  decide(call: Call): 'answer' | undefined {
    const pending = this.d.get().pending;
    if (!pending || call.direction !== 'incoming') return undefined;
    if (this.now() - pending.at > this.cfg.launchTimeout * 1000) {
      this.clearPending();
      return undefined;
    }
    const matches = pending.pushCallId && call.pushId
      ? pending.pushCallId === call.pushId
      : !pending.caller || pending.caller === call.remoteNumber;
    if (!matches) return undefined;
    this.clearPending();
    this.d.emitAction({ launch: pending, callId: call.id });
    this.platform?.closeNotifications(this.cfg.serviceWorkerUrl, this.workerScope, pending.pushCallId).catch(() => undefined);
    return pending.action === 'answer' && this.cfg.autoAnswer ? 'answer' : undefined;
  }

  /** Feed a launch (tests / hosts with their own notification handling). */
  receiveLaunch(launch: PushLaunch, fromUrl: boolean): void {
    if (!this.cfg.enabled) return;
    if (this.now() - launch.at > this.cfg.launchTimeout * 1000) {
      this.d.logger.info('Ignoring an expired push notification click');
      if (fromUrl) this.platform?.clearLaunch();
      return;
    }
    this.d.logger.info(`Push notification click: ${launch.action}${launch.pushCallId ? ` (${launch.pushCallId})` : ''}`);
    // The deep link stays in the URL until the call is matched or the click expires, so a
    // second instance (React StrictMode, a host re-creating the softphone) still sees it.
    this.patch({ pending: launch });
    this.d.emitAction({ launch });
    clearTimeout(this.expiryTimer);
    const remaining = launch.at + this.cfg.launchTimeout * 1000 - this.now();
    this.expiryTimer = setTimeout(() => {
      if (this.d.get().pending === launch) this.clearPending();
    }, Math.max(0, remaining));
  }

  dispose(): void {
    this.disposed = true;
    this.offWorker?.();
    this.offWorker = undefined;
    clearTimeout(this.expiryTimer);
  }

  // ------------------------------------------------------------ internals

  private clearPending(): void {
    clearTimeout(this.expiryTimer);
    this.platform?.clearLaunch();
    if (this.d.get().pending) this.patch({ pending: undefined });
  }

  /** After (re-)registering: make sure the service has this browser's current subscription. */
  private async resync(): Promise<void> {
    const platform = this.platform;
    if (!platform || !this.cfg.enabled || !this.cfg.autoResubscribe || !this.cfg.serviceUrl.trim()) return;
    if (this.d.storage.get<boolean>(OPT_IN_KEY) !== true || platform.permission() !== 'granted') return;
    try {
      const key = await this.vapidPublicKey();
      const sub = await platform.subscribe(this.cfg.serviceWorkerUrl, this.workerScope, key);
      await this.sendToService('POST', { subscription: sub, userAgent: platform.userAgent?.() });
      this.patch({ subscribed: true, permission: 'granted', error: undefined });
    } catch (error) {
      this.d.logger.warn('Refreshing the push subscription failed', error);
      this.patch({ error: error instanceof PushFailure ? error.code : 'subscribe-failed' });
    }
  }

  private async configureWorker(): Promise<void> {
    const platform = this.platform;
    if (!platform) return;
    await platform
      .configureWorker(this.cfg.serviceWorkerUrl, this.workerScope, {
        appUrl: this.cfg.appUrl.trim() || platform.appUrl(),
        ...(this.cfg.serviceUrl.trim() ? { serviceUrl: trimSlash(this.cfg.serviceUrl.trim()) } : {}),
        labels: this.labels,
      })
      .catch((error: unknown) => this.d.logger.debug('Configuring the push service worker failed', error));
  }

  private async vapidPublicKey(): Promise<string> {
    const configured = this.cfg.vapidPublicKey.trim();
    if (configured) return configured;
    if (this.vapidKey) return this.vapidKey;
    let res: Response;
    try {
      res = await this.http(`${trimSlash(this.cfg.serviceUrl.trim())}/vapid-public-key`, { method: 'GET' });
    } catch (error) {
      throw new PushFailure('service-unreachable', `Push service unreachable: ${errorText(error)}`, error);
    }
    const body = (await res.json().catch(() => ({}))) as { publicKey?: string };
    if (!res.ok || !body.publicKey) throw new PushFailure('no-vapid-key', 'The push service returned no VAPID public key');
    this.vapidKey = body.publicKey;
    return body.publicKey;
  }

  private async token(): Promise<string> {
    const cfg = this.cfg;
    const token = cfg.getToken ? await cfg.getToken() : cfg.token;
    if (!token) throw new PushFailure('not-configured', 'No push token (config push.token / push.getToken)');
    return token;
  }

  private async sendToService(method: 'POST' | 'DELETE', body: Record<string, unknown>): Promise<void> {
    const extension = extensionOf(this.d.config().username);
    const token = await this.token();
    let res: Response;
    try {
      res = await this.http(`${trimSlash(this.cfg.serviceUrl.trim())}/subscriptions`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...(extension ? { extension } : {}), ...body }),
      });
    } catch (error) {
      throw new PushFailure('service-unreachable', `Push service unreachable: ${errorText(error)}`, error);
    }
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new PushFailure('service-rejected', `Push service rejected the request: ${detail}`);
    }
  }

  private http(url: string, init: RequestInit): Promise<Response> {
    const f = this.d.fetch ?? globalThis.fetch;
    return f(url, { ...init, signal: AbortSignal.timeout?.(10_000) });
  }
}

class PushFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'PushFailure';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
