import { PUSH_NOTIFICATION_TAG, PUSH_WORKER_CONFIG_MESSAGE, PUSH_WORKER_MESSAGE, parseLaunch, stripLaunch } from './deep-link';
import type { PushLaunch, PushPermission, PushPlatform, PushSubscriptionData, PushWorkerConfig } from './types';

type Nav = Navigator & { serviceWorker?: ServiceWorkerContainer };

function nav(): Nav | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as Nav);
}

function base64UrlToBytes(value: string): Uint8Array {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function toData(sub: PushSubscription): PushSubscriptionData {
  const json = sub.toJSON() as { endpoint?: string; expirationTime?: number | null; keys?: Record<string, string> };
  return {
    endpoint: json.endpoint ?? sub.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  };
}

function waitActive(reg: ServiceWorkerRegistration, timeoutMs = 10_000): Promise<ServiceWorker> {
  if (reg.active) return Promise.resolve(reg.active);
  return new Promise((resolve, reject) => {
    const worker = reg.installing ?? reg.waiting;
    const timer = setTimeout(() => reject(new Error('Service worker did not activate')), timeoutMs);
    if (!worker) {
      clearTimeout(timer);
      reject(new Error('No service worker'));
      return;
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') {
        clearTimeout(timer);
        resolve(worker);
      } else if (worker.state === 'redundant') {
        clearTimeout(timer);
        reject(new Error('Service worker became redundant'));
      }
    });
  });
}

/** {@link PushPlatform} on top of the browser's service worker, Push API and Notification API. */
export function createBrowserPushPlatform(): PushPlatform {
  const sw = () => nav()?.serviceWorker;
  const registration = async (workerUrl: string, scope?: string) =>
    (await sw()?.getRegistration(scope || workerUrl)) ?? undefined;
  const register = async (workerUrl: string, scope?: string) => {
    const container = sw();
    if (!container) throw new Error('Service workers are not supported');
    const reg = await container.register(workerUrl, scope ? { scope } : undefined);
    await waitActive(reg);
    return reg;
  };

  return {
    isSupported() {
      return (
        typeof window !== 'undefined' &&
        Boolean(sw()) &&
        'PushManager' in window &&
        typeof Notification !== 'undefined' &&
        (window.isSecureContext ?? true)
      );
    },
    permission(): PushPermission {
      if (!this.isSupported()) return 'unsupported';
      return Notification.permission as PushPermission;
    },
    async requestPermission(): Promise<PushPermission> {
      if (!this.isSupported()) return 'unsupported';
      return (await Notification.requestPermission()) as PushPermission;
    },
    async getSubscription(workerUrl, scope) {
      const reg = await registration(workerUrl, scope);
      const sub = await reg?.pushManager.getSubscription();
      return sub ? toData(sub) : null;
    },
    async subscribe(workerUrl, scope, vapidPublicKey) {
      const reg = await register(workerUrl, scope);
      const key = base64UrlToBytes(vapidPublicKey);
      let sub = await reg.pushManager.getSubscription();
      // A subscription made with another VAPID key cannot be reused.
      const existingKey = sub?.options.applicationServerKey;
      if (sub && existingKey && !sameBytes(new Uint8Array(existingKey), key)) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
      return toData(sub);
    },
    async unsubscribe(workerUrl, scope) {
      const reg = await registration(workerUrl, scope);
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return null;
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      return endpoint;
    },
    async configureWorker(workerUrl, scope, config: PushWorkerConfig) {
      const reg = await registration(workerUrl, scope);
      reg?.active?.postMessage({ type: PUSH_WORKER_CONFIG_MESSAGE, config });
    },
    async closeNotifications(workerUrl, scope, pushCallId) {
      const reg = await registration(workerUrl, scope);
      if (!reg?.getNotifications) return;
      const tag = pushCallId ? `${PUSH_NOTIFICATION_TAG}${pushCallId}` : undefined;
      for (const n of await reg.getNotifications(tag ? { tag } : undefined)) {
        if (n.tag?.startsWith(PUSH_NOTIFICATION_TAG)) n.close();
      }
    },
    readLaunch() {
      return typeof location === 'undefined' ? null : parseLaunch(location.search);
    },
    clearLaunch() {
      if (typeof location === 'undefined' || typeof history === 'undefined') return;
      const next = stripLaunch(location.href);
      if (next !== location.href) history.replaceState(history.state, '', next);
    },
    onWorkerLaunch(handler: (launch: Omit<PushLaunch, 'at'>) => void) {
      const container = sw();
      if (!container) return () => {};
      const listener = (event: MessageEvent) => {
        const data = event.data as { type?: string; launch?: Omit<PushLaunch, 'at'> } | null;
        if (data?.type !== PUSH_WORKER_MESSAGE || !data.launch) return;
        const { action, pushCallId, caller } = data.launch;
        if (action !== 'answer' && action !== 'open') return;
        handler({
          action,
          ...(typeof pushCallId === 'string' ? { pushCallId } : {}),
          ...(typeof caller === 'string' ? { caller } : {}),
        });
      };
      container.addEventListener('message', listener);
      container.startMessages?.();
      return () => container.removeEventListener('message', listener);
    },
    appUrl() {
      return typeof location === 'undefined' ? '' : stripLaunch(location.href);
    },
    userAgent() {
      return typeof navigator === 'undefined' ? '' : navigator.userAgent;
    },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
