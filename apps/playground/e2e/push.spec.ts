import { expect, test, type Page } from '@playwright/test';
import {
  NOTIFY_SECRET,
  clickNotification,
  configurePlayground,
  createSubscriberKeys,
  decryptWebPush,
  deliverPush,
  fakePushManager,
  shownNotifications,
  startFakePushEndpoint,
  startPushService,
  type FakePushEndpoint,
} from './push-helpers';

/**
 * Web Push for incoming calls (V2-PUSH-01), mock engine + the real push
 * service (in-process), the real service worker and real Web Push encryption.
 * Only the browser's push transport is replaced: headless Chromium has no push
 * service, so the subscription points at a local fake push endpoint and the
 * test hands the received message to the service worker over CDP.
 */

// New headless mode: the Notification API is granted/denied like in a real browser.
test.use({ channel: 'chromium', permissions: ['notifications'] });

let push: Awaited<ReturnType<typeof startPushService>>;
let endpoint: FakePushEndpoint;
const keys = createSubscriberKeys();

test.beforeAll(async () => {
  push = await startPushService();
  endpoint = await startFakePushEndpoint();
});

test.afterAll(async () => {
  await push?.close();
  await endpoint?.close();
});

async function login(page: Page, user: string) {
  await page.getByLabel('Extension / username').fill(user);
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
}

async function notify(body: Record<string, string>) {
  const res = await fetch(`${push.url}/notify/incoming`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sipkit-Push-Secret': NOTIFY_SECRET },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { sent: number; subscriptions: number };
}

test.describe('push notifications (mock engine)', () => {
  test.describe.configure({ mode: 'serial' });

  test('subscribe from the prompt, receive an encrypted push, the notification answers the call', async ({ context, page }) => {
    await configurePlayground(context, push.url);
    await fakePushManager(context, `${endpoint.url}/push/agent-1001`, keys);
    await page.goto('/');
    await login(page, '1001');

    // Permission prompt (en) -> the browser permission (granted) -> subscription stored at the service.
    const prompt = page.getByTestId('push-prompt');
    await expect(prompt).toContainText('Never miss a call');
    await prompt.getByTestId('push-prompt-enable').click();
    await expect(prompt).toBeHidden();
    await expect.poll(async () => (await push.service.list('1001')).length).toBe(1);
    expect((await push.service.list('1001'))[0]!.endpointHost).toBe(new URL(endpoint.url).host);

    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByTestId('push-settings')).toHaveAttribute('data-subscribed', 'true');
    await expect(page.getByTestId('push-settings')).toHaveAttribute('data-permission', 'granted');

    // The PBX hook: POST /notify/incoming -> real Web Push (VAPID + aes128gcm) to the fake endpoint.
    expect(await notify({ extension: '1001', callId: 'e2e-call-1', callerId: '5550100', callerName: 'Jane Customer' })).toMatchObject({
      sent: 1,
      subscriptions: 1,
    });
    const message = endpoint.received.at(-1)!;
    expect(message.headers['content-encoding']).toBe('aes128gcm');
    expect(String(message.headers.authorization)).toMatch(/^vapid t=/);
    const payload = decryptWebPush(message.body, keys);
    expect(JSON.parse(payload)).toMatchObject({ type: 'incoming-call', callId: 'e2e-call-1', callerId: '5550100' });

    // The service worker shows the OS notification with Answer / Decline.
    await deliverPush(context, page, payload);
    await expect.poll(() => shownNotifications(page)).toEqual([
      { title: 'Incoming call', body: 'Jane Customer (5550100) is calling', tag: 'sipkit-call-e2e-call-1', actions: ['answer', 'decline'] },
    ]);

    // "Answer" with the tab open: the worker focuses it; the softphone waits for that call and answers it.
    await clickNotification(context, 'answer');
    await expect(page.getByTestId('push-pending')).toHaveAttribute('data-push-call', 'e2e-call-1');
    await expect(page.getByTestId('event-log')).toContainText('push click answer e2e-call-1');
    await page.getByTestId('simulate-push-incoming').click();
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    await expect(page.getByTestId('push-pending')).toBeHidden();
    await page.getByRole('button', { name: 'Hang up' }).click();
  });

  test('tab closed: the notification deep link opens the softphone, which answers the matching call', async ({ context, page }) => {
    await configurePlayground(context, push.url);
    await fakePushManager(context, `${endpoint.url}/push/agent-1002`, keys);
    // What the service worker opens for "Answer" when no softphone tab is open.
    await page.goto(`/?sipkitPush=answer&sipkitPushCall=e2e-call-2&sipkitPushFrom=5550100&sipkitPushAt=${Date.now()}`);
    await login(page, '1002');
    await expect(page.getByTestId('push-pending')).toHaveAttribute('data-push-call', 'e2e-call-2');
    await page.getByTestId('simulate-push-incoming').click();
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-call-state', 'connected');
    await expect(page.getByTestId('event-log')).toContainText('push click answer e2e-call-2 →');
    await expect(page).not.toHaveURL(/sipkitPush/);
  });

  test('Nepali prompt; turning the settings toggle off removes the subscription', async ({ context, page }) => {
    await configurePlayground(context, push.url);
    await fakePushManager(context, `${endpoint.url}/push/agent-1003`, keys);
    await page.goto('/');
    await page.getByRole('radio', { name: 'नेपाली' }).click();
    await page.getByLabel(/एक्सटेन्सन|Extension/).fill('1003');
    await page.getByLabel(/पासवर्ड|Password/).fill('secret');
    await page.getByRole('button', { name: /साइन इन|Sign in/ }).click();
    await expect(page.getByTestId('registration-pill')).toHaveAttribute('data-state', 'registered');
    await expect(page.getByTestId('push-prompt')).toContainText('कुनै कल नछुटाउनुहोस्');
    await page.getByTestId('push-prompt-enable').click();
    await expect.poll(async () => (await push.service.list('1003')).length).toBe(1);

    await page.getByRole('tab', { name: 'सेटिङ' }).click();
    const settings = page.getByTestId('push-settings');
    await expect(settings).toContainText('यो ट्याब बन्द हुँदा मलाई सूचित गर्नुहोस्');
    await settings.getByTestId('push-toggle').click();
    await expect(settings).toHaveAttribute('data-subscribed', 'false');
    await expect.poll(async () => (await push.service.list('1003')).length).toBe(0);
  });
});
