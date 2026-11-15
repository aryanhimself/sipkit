/**
 * Web Push for incoming calls (V2-PUSH-01). See docs/push.md.
 *
 * The browser subscribes (Push API + service worker) and hands the
 * subscription to the sipkit push service. When Asterisk gets a call for an
 * offline extension it asks the service to push; the service worker shows a
 * notification, and a click opens / focuses the softphone with a deep link
 * that is matched to the INVITE (`X-Sipkit-Push-Id`) once the softphone registers.
 */

/** Notification permission, or 'unsupported' when the browser has no Push API / service workers. */
export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

/** What the agent chose on the notification. 'open' = clicked the notification body. */
export type PushLaunchAction = 'answer' | 'open';

/** A notification click waiting for its call (deep link `?sipkitPush=answer&sipkitPushCall=…`, or a message from the service worker). */
export interface PushLaunch {
  action: PushLaunchAction;
  /** PBX call id from the push (`X-Sipkit-Push-Id` on the INVITE). */
  pushCallId?: string;
  /** Caller number from the push (fallback match when the PBX sends no `X-Sipkit-Push-Id`). */
  caller?: string;
  /** Epoch ms the launch was received. It expires after `push.launchTimeout` seconds. */
  at: number;
}

/** Push state on the snapshot (`snapshot.push`, absent on implementations without push). */
export interface PushState {
  /** Config `push.enabled`. */
  enabled: boolean;
  /** The browser supports service workers, the Push API and notifications. */
  supported: boolean;
  permission: PushPermission;
  /** This browser has a push subscription stored at the push service. */
  subscribed: boolean;
  /** subscribe / unsubscribe in flight. */
  busy: boolean;
  /**
   * Last failure code: 'permission-denied' | 'unsupported' | 'service-unreachable' |
   * 'service-rejected' | 'no-vapid-key' | 'subscribe-failed' | 'not-configured'.
   */
  error?: string;
  /** A notification click waiting for its incoming call. */
  pending?: PushLaunch;
}

/** The subscription as sent to the push service (`PushSubscription.toJSON()`). */
export interface PushSubscriptionData {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** Labels and URLs the service worker needs (sent to it by the page; English defaults in the worker). */
export interface PushWorkerConfig {
  /** Page the notification opens (deep link params are added). */
  appUrl: string;
  /** Push service base URL (decline action). */
  serviceUrl?: string;
  labels?: Partial<PushWorkerLabels>;
}

/** Notification texts. `{caller}` is replaced with the caller's name / number. */
export interface PushWorkerLabels {
  title: string;
  body: string;
  answer: string;
  decline: string;
}

/**
 * Browser integration used by the push controller. The default implementation
 * uses `navigator.serviceWorker`, `PushManager` and `Notification`;
 * `sipkit-core/testing` has a fake.
 */
export interface PushPlatform {
  isSupported(): boolean;
  permission(): PushPermission;
  /** Ask for notification permission (call from a user gesture). */
  requestPermission(): Promise<PushPermission>;
  /** Current subscription of the registered worker, if any (does not register the worker). */
  getSubscription(workerUrl: string, scope?: string): Promise<PushSubscriptionData | null>;
  /** Register the service worker (if needed) and subscribe with the VAPID key. */
  subscribe(workerUrl: string, scope: string | undefined, vapidPublicKey: string): Promise<PushSubscriptionData>;
  /** Unsubscribe the browser. Resolves to the endpoint that was removed, if any. */
  unsubscribe(workerUrl: string, scope?: string): Promise<string | null>;
  /** Send the worker its labels / URLs. Best effort. */
  configureWorker(workerUrl: string, scope: string | undefined, config: PushWorkerConfig): Promise<void>;
  /** Close notifications shown by the worker (all call notifications, or one call's). */
  closeNotifications(workerUrl: string, scope: string | undefined, pushCallId?: string): Promise<void>;
  /** The launch in the page URL (deep link), if any. Does not change the URL. */
  readLaunch(): Omit<PushLaunch, 'at'> & { at?: number } | null;
  /** Remove the deep link params from the page URL (history.replaceState). */
  clearLaunch(): void;
  /** Messages from the service worker (a notification click while the page is open). Returns unsubscribe. */
  onWorkerLaunch(handler: (launch: Omit<PushLaunch, 'at'>) => void): () => void;
  /** URL the notification should open, without deep link params. */
  appUrl(): string;
  /** Locale hint sent with the subscription. */
  userAgent?(): string;
}

/** Async token for the push service (e.g. fetched from the CRM backend). */
export type PushTokenProvider = () => string | Promise<string>;
