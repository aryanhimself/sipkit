import { networkInterfaces } from 'node:os';
import { expect, test, type BrowserContext } from '@playwright/test';
import {
  configurePlayground,
  createSubscriberKeys,
  decryptWebPush,
  fakePushManager,
  startFakePushEndpoint,
  type FakePushEndpoint,
} from '../push-helpers';
import { closePhone, dial, expectCallState, expectMediaFlowing, openPhone, type Phone } from './helpers';

/**
 * Push for incoming calls (V2-PUSH-01) against a real Asterisk + the push
 * service container (docs/push.md, "Testing"):
 *
 *   E2E_PUSH_URL     push service as the browser and this test reach it (e.g. http://172.28.0.232:8790)
 *   E2E_PUSH_TOKEN   its PUSH_DEV_TOKEN
 *   E2E_PUSH_SECRET  its PUSH_NOTIFY_SECRET
 *
 * The PBX must run with SIPKIT_PUSH_URL / SIPKIT_PUSH_SECRET pointing at the same
 * service (and PUSH_ALLOW_INSECURE_ENDPOINTS=1 on the service, because the
 * browser "push service" here is a fake endpoint inside this test process).
 *
 * Flow: 1002 subscribes, closes its tab (no unREGISTER, like a real tab close),
 * 1001 calls 1002, Asterisk asks the push service to notify 1002, the
 * encrypted push reaches 1002's (fake) push endpoint, then 1002's softphone
 * opens with the deep link the notification would open, registers, and answers
 * the call that is still ringing.
 */
const PUSH_URL = process.env.E2E_PUSH_URL ?? '';
const PUSH_TOKEN = process.env.E2E_PUSH_TOKEN ?? '';
const PUSH_SECRET = process.env.E2E_PUSH_SECRET ?? '';

/** This container's address on the PBX network, reachable from the push service container. */
function ownAddress(): string {
  const prefix = (new URL(PUSH_URL).hostname.match(/^(\d+\.\d+\.\d+)\./) ?? [])[1];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && (!prefix || a.address.startsWith(`${prefix}.`))) return a.address;
    }
  }
  return '127.0.0.1';
}

async function events(): Promise<Array<{ type: string; extension?: string; callId?: string }>> {
  const res = await fetch(`${PUSH_URL}/debug/events`, { headers: { 'X-Sipkit-Push-Secret': PUSH_SECRET } });
  return ((await res.json()) as { events: Array<{ type: string; extension?: string; callId?: string }> }).events;
}

// New headless mode: the Notification API is granted/denied like in a real browser.
test.use({ channel: 'chromium' });

test.describe('real Asterisk: push notifications for incoming calls', () => {
  test.skip(!PUSH_URL || !PUSH_TOKEN || !PUSH_SECRET, 'needs E2E_PUSH_URL, E2E_PUSH_TOKEN and E2E_PUSH_SECRET (docs/push.md)');

  let endpoint: FakePushEndpoint | undefined;
  let a: Phone | undefined;
  let b: Phone | undefined;
  let bContext: BrowserContext | undefined;
  const keys = createSubscriberKeys();

  test.beforeEach(async () => {
    endpoint = await startFakePushEndpoint('0.0.0.0', ownAddress());
  });

  test.afterEach(async () => {
    await closePhone(a);
    await closePhone(b);
    await bContext?.close().catch(() => undefined);
    await endpoint?.close();
    a = b = bContext = endpoint = undefined;
  });

  async function subscribeAndCloseTab(browser: Parameters<typeof openPhone>[0], user: string, tag: string) {
    bContext = await browser.newContext({ permissions: ['microphone', 'notifications'] });
    await configurePlayground(bContext, PUSH_URL, PUSH_TOKEN);
    await fakePushManager(bContext, `${endpoint!.url}/push/${tag}`, keys);
    const first = await openPhone(browser, user, undefined, { context: bContext });
    await first.page.getByRole('tab', { name: 'Settings' }).click();
    const settings = first.page.getByTestId('push-settings');
    await settings.getByTestId('push-toggle').click();
    await expect(settings).toHaveAttribute('data-subscribed', 'true');
    const list = (await (
      await fetch(`${PUSH_URL}/subscriptions?extension=${user}`, { headers: { Authorization: `Bearer ${PUSH_TOKEN}` } })
    ).json()) as { subscriptions: Array<{ endpointHost: string }> };
    expect(list.subscriptions.map((s) => s.endpointHost)).toContain(new URL(endpoint!.url).host);
    // Close the tab like a user would: no unREGISTER. The WebSocket closes and
    // Asterisk drops the contact, so the extension is offline.
    await first.page.close();
  }

  async function waitForPush(): Promise<{ callId: string; callerId: string; decline?: { exp: number; sig: string } }> {
    await expect.poll(() => endpoint!.received.length, { message: 'the push service should push to 1002', timeout: 15_000 }).toBeGreaterThan(0);
    const payload = JSON.parse(decryptWebPush(endpoint!.received[0]!.body, keys)) as {
      type: string;
      callId: string;
      callerId: string;
      decline?: { exp: number; sig: string };
    };
    expect(payload.type).toBe('incoming-call');
    return payload;
  }

  test('tab closed: the call triggers a push, the agent opens the softphone and answers the still-ringing call', async ({ browser }) => {
    test.setTimeout(120_000);
    await subscribeAndCloseTab(browser, '1002', 'agent-1002');

    a = await openPhone(browser, '1001');
    await dial(a, '1002');
    const push = await waitForPush();
    expect(push.callerId).toBe('1001');
    expect((await events()).some((e) => e.type === 'notify' && e.extension === '1002' && e.callId === push.callId)).toBe(true);
    // The caller keeps hearing ringing while the agent comes online.
    await expectCallState(a, 'ringing');

    // What the service worker opens for "Answer" (headless Chromium cannot click OS notifications).
    const deepLink = `/?sipkitPush=answer&sipkitPushCall=${encodeURIComponent(push.callId)}&sipkitPushFrom=1001&sipkitPushAt=${Date.now()}`;
    b = await openPhone(browser, '1002', undefined, { context: bContext, path: deepLink });
    bContext = undefined; // closed with b
    await expectCallState(b, 'connected');
    await expectCallState(a, 'connected');
    await expect(b.page.getByTestId('event-log')).toContainText(`push click answer ${push.callId} →`);
    await expectMediaFlowing(b);

    await a.page.getByRole('button', { name: 'Hang up' }).click();
    await expect(b.page.getByTestId('call-screen')).toBeHidden();
    await expect.poll(async () => (await events()).some((e) => e.type === 'cancel' && e.callId === push.callId)).toBe(true);
  });

  test('tab closed: Decline on the notification makes the PBX return busy', async ({ browser }) => {
    test.setTimeout(90_000);
    await subscribeAndCloseTab(browser, '1002', 'agent-1002-decline');
    a = await openPhone(browser, '1001');
    await dial(a, '1002');
    const push = await waitForPush();
    expect(push.decline).toBeTruthy();
    // What the service worker posts for "Decline".
    const res = await fetch(`${PUSH_URL}/calls/${encodeURIComponent(push.callId)}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extension: '1002', ...push.decline }),
    });
    expect(res.status).toBe(200);
    // The dialplan polls the call status every 2 s and answers busy.
    await expect(a.page.getByTestId('call-screen')).toBeHidden({ timeout: 10_000 });
    await expect(a.page.getByTestId('event-log')).toContainText('(busy)');
  });
});
