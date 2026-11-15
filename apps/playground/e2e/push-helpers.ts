import type { BrowserContext, Page } from '@playwright/test';
import { createPushServer, type PushServer } from '../../../services/push/src/server.ts';
import { loadConfig } from '../../../services/push/src/config.ts';
import { generateVapidKeys } from '../../../services/push/src/sender.ts';
import { MemoryStore } from '../../../services/push/src/store.ts';
import type { SubscriberKeys } from '../../../services/push/src/testing.ts';

export { createSubscriberKeys, decryptWebPush, startFakePushEndpoint } from '../../../services/push/src/testing.ts';
export type { FakePushEndpoint, SubscriberKeys } from '../../../services/push/src/testing.ts';

export const DEV_TOKEN = 'e2e-dev-push-token';
export const NOTIFY_SECRET = 'e2e-notify-secret';

/** The push service (services/push) in-process on a random port, with a dev token and http endpoints allowed. */
export async function startPushService(host = '127.0.0.1'): Promise<PushServer & { url: string; close(): Promise<void> }> {
  const vapid = generateVapidKeys();
  const config = loadConfig({
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    PUSH_TOKEN_SECRET: 'e2e-token-secret-0123456789abcdefghij',
    PUSH_DEV_TOKEN: DEV_TOKEN,
    PUSH_NOTIFY_SECRET: NOTIFY_SECRET,
    PUSH_STORE_FILE: '',
    PUSH_ALLOW_INSECURE_ENDPOINTS: '1',
    PUSH_DEBUG: '1',
  });
  const push = await createPushServer({ config, store: new MemoryStore() });
  await new Promise<void>((resolve) => push.server.listen(0, host, resolve));
  const { port } = push.server.address() as { port: number };
  return {
    ...push,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    close: () => new Promise((resolve) => push.server.close(() => resolve())),
  };
}

/**
 * Headless Chromium has no push service (its PushManager.subscribe() fails),
 * so tests replace it with a subscription that points at a local fake push
 * endpoint and carries keys the test can decrypt with. Everything else (the
 * service worker, Notification API, the push service and its encryption) is real.
 */
export async function fakePushManager(context: BrowserContext, endpoint: string, keys: SubscriberKeys): Promise<void> {
  await context.addInitScript(
    ({ endpoint, p256dh, auth }) => {
      if (typeof PushManager === 'undefined') return;
      const KEY = 'e2e:push-subscription';
      const make = (applicationServerKey: ArrayBuffer | null) => ({
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey },
        getKey: () => null,
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
        unsubscribe: async () => {
          localStorage.removeItem(KEY);
          return true;
        },
      });
      PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
        localStorage.setItem(KEY, '1');
        const key = options?.applicationServerKey;
        const buf = key instanceof ArrayBuffer ? key : ArrayBuffer.isView(key) ? (key.buffer as ArrayBuffer) : null;
        return make(buf) as unknown as PushSubscription;
      };
      PushManager.prototype.getSubscription = async function () {
        return localStorage.getItem(KEY) ? (make(null) as unknown as PushSubscription) : null;
      };
    },
    { endpoint, p256dh: keys.p256dh, auth: keys.auth },
  );
}

/** Point the playground at a push service (read by createMock / the real config form). */
export async function configurePlayground(context: BrowserContext, serviceUrl: string, token = DEV_TOKEN): Promise<void> {
  await context.addInitScript(
    ({ serviceUrl, token }) => localStorage.setItem('pg:push', JSON.stringify({ serviceUrl, token })),
    { serviceUrl, token },
  );
}

/** Deliver a push message to the page's service worker (Chrome DevTools Protocol). */
export async function deliverPush(context: BrowserContext, page: Page, data: string): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const registrations: Array<{ registrationId: string; scopeURL: string; isDeleted: boolean }> = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: typeof registrations }) => registrations.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');
  const origin = new URL(page.url()).origin;
  for (let i = 0; i < 50 && !registrations.some((r) => !r.isDeleted && r.scopeURL.startsWith(origin)); i++) {
    await page.waitForTimeout(100);
  }
  const reg = registrations.find((r) => !r.isDeleted && r.scopeURL.startsWith(origin));
  if (!reg) throw new Error('No service worker registration');
  await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: reg.registrationId, data });
  await cdp.detach();
}

/** Notifications currently shown by the service worker. */
export function shownNotifications(page: Page) {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration('/sipkit-push-sw.js');
    return ((await reg?.getNotifications()) ?? []).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      actions: ((n as Notification & { actions?: Array<{ action: string; title: string }> }).actions ?? []).map((a) => a.action),
    }));
  });
}

/** Click a notification action inside the service worker (headless Chromium cannot click OS notifications). */
export async function clickNotification(context: BrowserContext, action: 'answer' | 'decline' | ''): Promise<void> {
  const worker = context.serviceWorkers().find((w) => w.url().includes('sipkit-push-sw.js'));
  if (!worker) throw new Error('Push service worker not running');
  await worker.evaluate(async (act) => {
    const scope = self as unknown as {
      registration: { getNotifications(): Promise<Array<{ tag: string; data: unknown; close(): void }>> };
      sipkitPushWorker: { handleClick(n: unknown, action: string): Promise<void> };
    };
    const [n] = await scope.registration.getNotifications();
    if (!n) throw new Error('No notification');
    await scope.sipkitPushWorker.handleClick(n, act);
  }, action);
}
