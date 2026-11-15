/**
 * sipkit push service worker (V2-PUSH-01, docs/push.md).
 *
 * Built to `sipkit-ui/sipkit-push-sw.js`. Serve that file from your app's
 * origin (default URL `/sipkit-push-sw.js`, config `push.serviceWorkerUrl`).
 *
 * - `push` (from the sipkit push service): shows "Incoming call" with
 *   Answer / Decline actions, or closes it when the call was cancelled.
 * - Answer / click: focuses the softphone page and tells it which call to
 *   pick up, or opens it with a deep link (`?sipkitPush=answer&sipkitPushCall=…`)
 *   that the softphone matches to the INVITE once it has registered.
 * - Decline: tells the push service, so the PBX stops waiting for the agent.
 *
 * Self-contained on purpose (no imports): it runs in the worker scope, not the
 * page. The protocol constants mirror packages/core/src/push/deep-link.ts and
 * a unit test keeps them in sync.
 */

export interface PushLabels {
  title: string;
  /** `{caller}` is replaced with the caller's name / number. */
  body: string;
  answer: string;
  decline: string;
}

export interface PushWorkerSettings {
  appUrl?: string;
  serviceUrl?: string;
  labels?: Partial<PushLabels>;
}

interface IncomingCallPush {
  v: 1;
  type: 'incoming-call';
  callId: string;
  extension: string;
  callerId: string;
  callerName?: string;
  at: number;
  ttl: number;
  decline?: { exp: number; sig: string; url?: string };
}

interface CallCancelledPush {
  v: 1;
  type: 'call-cancelled';
  callId: string;
  extension: string;
}

// ------------------------------------------------------------- minimal worker types

interface NotificationLike {
  tag: string;
  data: unknown;
  close(): void;
}
interface WindowClientLike {
  url: string;
  focused?: boolean;
  focus(): Promise<WindowClientLike>;
  postMessage(message: unknown): void;
}
interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface PushEventLike extends ExtendableEventLike {
  data?: { json(): unknown; text(): string } | null;
}
interface NotificationEventLike extends ExtendableEventLike {
  notification: NotificationLike;
  action: string;
}
interface MessageEventLike extends ExtendableEventLike {
  data: unknown;
}
export interface PushWorkerScope {
  registration: {
    scope: string;
    showNotification(title: string, options: Record<string, unknown>): Promise<void>;
    getNotifications(filter?: { tag?: string }): Promise<NotificationLike[]>;
  };
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<WindowClientLike | null>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: never) => void): void;
  caches?: {
    open(name: string): Promise<{ match(key: string): Promise<{ json(): Promise<unknown> } | undefined>; put(key: string, res: unknown): Promise<void> }>;
  };
  fetch(url: string, init: Record<string, unknown>): Promise<unknown>;
  sipkitPushWorker?: PushWorkerApi;
}

export interface PushWorkerApi {
  handlePush(payload: unknown): Promise<void>;
  handleClick(notification: NotificationLike, action: string): Promise<void>;
  settings(): Promise<PushWorkerSettings>;
}

// ------------------------------------------------------------- protocol

export const LAUNCH_PARAMS = { action: 'sipkitPush', callId: 'sipkitPushCall', caller: 'sipkitPushFrom', at: 'sipkitPushAt' } as const;
export const LAUNCH_MESSAGE = 'sipkit-push-launch';
export const CONFIG_MESSAGE = 'sipkit-push-config';
export const NOTIFICATION_TAG = 'sipkit-call-';

const DEFAULT_LABELS: PushLabels = {
  title: 'Incoming call',
  body: '{caller} is calling',
  answer: 'Answer',
  decline: 'Decline',
};

const CACHE_NAME = 'sipkit-push-v1';
const CACHE_KEY = '/__sipkit-push-settings__';

function str(v: unknown, max = 500): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function sanitizeSettings(input: unknown): PushWorkerSettings {
  const c = (input ?? {}) as { appUrl?: unknown; serviceUrl?: unknown; labels?: Record<string, unknown> };
  const labels: Partial<PushLabels> = {};
  for (const k of ['title', 'body', 'answer', 'decline'] as const) {
    const v = str(c.labels?.[k], 200);
    if (v) labels[k] = v;
  }
  return {
    ...(str(c.appUrl, 2000) ? { appUrl: str(c.appUrl, 2000) } : {}),
    ...(str(c.serviceUrl, 2000) ? { serviceUrl: str(c.serviceUrl, 2000)!.replace(/\/+$/, '') } : {}),
    labels,
  };
}

function isIncoming(p: unknown): p is IncomingCallPush {
  const x = p as Partial<IncomingCallPush> | null;
  return Boolean(x && x.v === 1 && x.type === 'incoming-call' && typeof x.callId === 'string');
}

function isCancelled(p: unknown): p is CallCancelledPush {
  const x = p as Partial<CallCancelledPush> | null;
  return Boolean(x && x.v === 1 && x.type === 'call-cancelled' && typeof x.callId === 'string');
}

/** Deep link for a click (same format as core `buildLaunchUrl`). */
export function launchUrl(base: string, action: 'answer' | 'open', call: { callId: string; callerId?: string }, at: number): string {
  const url = new URL(base);
  url.searchParams.set(LAUNCH_PARAMS.action, action);
  url.searchParams.set(LAUNCH_PARAMS.callId, call.callId);
  if (call.callerId) url.searchParams.set(LAUNCH_PARAMS.caller, call.callerId);
  url.searchParams.set(LAUNCH_PARAMS.at, String(at));
  return url.toString();
}

function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- worker

/** Wire the push worker into a service worker scope (`self`). Returns its handlers (tests). */
export function installPushWorker(scope: PushWorkerScope, now: () => number = Date.now): PushWorkerApi {
  let cached: PushWorkerSettings | undefined;

  async function settings(): Promise<PushWorkerSettings> {
    if (cached) return cached;
    try {
      const res = await (await scope.caches?.open(CACHE_NAME))?.match(CACHE_KEY);
      cached = res ? sanitizeSettings(await res.json()) : {};
    } catch {
      cached = {};
    }
    return cached;
  }

  async function saveSettings(next: PushWorkerSettings): Promise<void> {
    cached = next;
    try {
      const cache = await scope.caches?.open(CACHE_NAME);
      await cache?.put(CACHE_KEY, new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json' } }));
    } catch {
      /* best effort: defaults are used after a worker restart */
    }
  }

  async function closeCall(callId: string): Promise<void> {
    for (const n of await scope.registration.getNotifications({ tag: `${NOTIFICATION_TAG}${callId}` })) n.close();
  }

  async function handlePush(payload: unknown): Promise<void> {
    if (isCancelled(payload)) {
      await closeCall(payload.callId);
      return;
    }
    const s = await settings();
    const labels = { ...DEFAULT_LABELS, ...s.labels };
    if (!isIncoming(payload)) {
      // userVisibleOnly: every push must show something.
      await scope.registration.showNotification(labels.title, { tag: `${NOTIFICATION_TAG}unknown` });
      return;
    }
    const caller = payload.callerName ? `${payload.callerName} (${payload.callerId})` : payload.callerId;
    const stale = payload.at && payload.ttl ? now() - payload.at > payload.ttl * 1000 : false;
    if (stale) return;
    await scope.registration.showNotification(labels.title, {
      body: labels.body.replace('{caller}', caller),
      tag: `${NOTIFICATION_TAG}${payload.callId}`,
      renotify: true,
      requireInteraction: true,
      silent: false,
      timestamp: payload.at,
      actions: [
        { action: 'answer', title: labels.answer },
        { action: 'decline', title: labels.decline },
      ],
      data: payload,
    });
  }

  async function handleClick(notification: NotificationLike, action: string): Promise<void> {
    notification.close();
    const data = notification.data;
    if (!isIncoming(data)) return;
    const s = await settings();
    if (action === 'decline') {
      const d = data.decline;
      const url = d?.url ?? (s.serviceUrl ? `${s.serviceUrl}/calls/${encodeURIComponent(data.callId)}/decline` : undefined);
      if (d && url) {
        await scope
          .fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ extension: data.extension, exp: d.exp, sig: d.sig }),
          })
          .catch(() => undefined);
      }
      return;
    }
    const launch = { action: action === 'answer' ? ('answer' as const) : ('open' as const), pushCallId: data.callId, caller: data.callerId };
    const appUrl = s.appUrl ?? scope.registration.scope;
    const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => samePage(c.url, appUrl));
    if (open) {
      const focused = await open.focus().catch(() => open);
      focused.postMessage({ type: LAUNCH_MESSAGE, launch });
      return;
    }
    await scope.clients.openWindow(launchUrl(appUrl, launch.action, data, now()));
  }

  scope.addEventListener('install', ((event: ExtendableEventLike) => event.waitUntil(scope.skipWaiting())) as (e: never) => void);
  scope.addEventListener('activate', ((event: ExtendableEventLike) => event.waitUntil(scope.clients.claim())) as (e: never) => void);
  scope.addEventListener('message', ((event: MessageEventLike) => {
    const msg = event.data as { type?: string; config?: unknown } | null;
    if (msg?.type !== CONFIG_MESSAGE) return;
    event.waitUntil(saveSettings(sanitizeSettings(msg.config)));
  }) as (e: never) => void);
  scope.addEventListener('push', ((event: PushEventLike) => {
    let payload: unknown = null;
    try {
      payload = event.data?.json() ?? null;
    } catch {
      payload = null;
    }
    event.waitUntil(handlePush(payload));
  }) as (e: never) => void);
  scope.addEventListener('notificationclick', ((event: NotificationEventLike) => {
    event.waitUntil(handleClick(event.notification, event.action));
  }) as (e: never) => void);

  const api: PushWorkerApi = { handlePush, handleClick, settings };
  // Exposed for debugging and end-to-end tests (Playwright `serviceWorker.evaluate`).
  scope.sipkitPushWorker = api;
  return api;
}

declare const ServiceWorkerGlobalScope: { new (): unknown } | undefined;
if (typeof ServiceWorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  installPushWorker(self as unknown as PushWorkerScope);
}
