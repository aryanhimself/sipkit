import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestSoftphone, FakePushPlatform } from '../testing';
import { buildLaunchUrl, parseLaunch, stripLaunch } from '../push';
import type { SoftphoneConfigInput } from '../config';
import type { PushState } from '../types';

const SERVICE = 'https://push.test';
const VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

function pushConfig(over: Partial<NonNullable<SoftphoneConfigInput['push']>> = {}): SoftphoneConfigInput {
  return { push: { enabled: true, serviceUrl: SERVICE, token: 'tok', ...over } };
}

function mockFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/vapid-public-key')) return new Response(JSON.stringify({ publicKey: VAPID }));
    return new Response(JSON.stringify({ ok: true }), { status: init.method === 'POST' ? 201 : 200 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('push: deep link', () => {
  it('builds, parses and strips launch params', () => {
    const url = buildLaunchUrl('https://crm.test/agent?tab=1', { action: 'answer', pushCallId: '17.3', caller: '1001', at: 5 });
    expect(parseLaunch(new URL(url).search)).toEqual({ action: 'answer', pushCallId: '17.3', caller: '1001', at: 5 });
    expect(stripLaunch(url)).toBe('https://crm.test/agent?tab=1');
    expect(parseLaunch('?sipkitPush=hack')).toBeNull();
    expect(parseLaunch('?tab=1')).toBeNull();
  });
});

describe('push: subscription', () => {
  it('is off by default and unsupported without a platform', async () => {
    const { softphone } = await createTestSoftphone();
    expect(softphone.getSnapshot().push).toMatchObject({ enabled: false, supported: false, permission: 'unsupported', subscribed: false });
    await expect(softphone.subscribePush()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('asks for permission, subscribes with the service VAPID key and stores the subscription', async () => {
    const calls = mockFetch();
    const platform = new FakePushPlatform();
    const { softphone } = await createTestSoftphone({ config: pushConfig(), pushPlatform: platform });
    const changes: PushState[] = [];
    softphone.on('push:changed', ({ push }) => changes.push(push));
    expect(softphone.getSnapshot().push).toMatchObject({ enabled: true, supported: true, permission: 'default' });

    const state = await softphone.subscribePush();
    expect(platform.permissionRequests).toBe(1);
    expect(state).toMatchObject({ permission: 'granted', subscribed: true, busy: false });
    expect(changes.some((c) => c.busy)).toBe(true);
    const post = calls.find((c) => c.url === `${SERVICE}/subscriptions`)!;
    expect(post.init.method).toBe('POST');
    expect((post.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(String(post.init.body)) as { extension: string; subscription: { endpoint: string } };
    expect(body.extension).toBe('1001');
    expect(body.subscription.endpoint).toBe('https://push.test/sub/1');
    expect(platform.workerConfig).toMatchObject({ appUrl: 'https://app.test/softphone', serviceUrl: SERVICE });
  });

  it('uses getToken() and a configured VAPID key', async () => {
    const calls = mockFetch();
    const getToken = vi.fn(async () => 'fresh');
    const platform = new FakePushPlatform({ permission: 'granted' });
    const { softphone } = await createTestSoftphone({ config: pushConfig({ vapidPublicKey: VAPID, getToken }), pushPlatform: platform });
    await softphone.subscribePush();
    expect(calls.some((c) => c.url.endsWith('/vapid-public-key'))).toBe(false);
    expect(getToken).toHaveBeenCalled();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer fresh');
    expect(platform.permissionRequests).toBe(0);
  });

  it('reports a denied permission and a rejecting service', async () => {
    mockFetch();
    const denied = new FakePushPlatform({ grant: 'denied' });
    const a = await createTestSoftphone({ config: pushConfig(), pushPlatform: denied });
    await expect(a.softphone.subscribePush()).rejects.toThrow(/permission/);
    expect(a.softphone.getSnapshot().push).toMatchObject({ permission: 'denied', error: 'permission-denied', subscribed: false });

    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('/vapid-public-key')
        ? new Response(JSON.stringify({ publicKey: VAPID }))
        : new Response(JSON.stringify({ error: 'Invalid or expired token' }), { status: 401 }),
    ));
    const b = await createTestSoftphone({ config: pushConfig(), pushPlatform: new FakePushPlatform({ permission: 'granted' }) });
    await expect(b.softphone.subscribePush()).rejects.toThrow(/expired token/);
    expect(b.softphone.getSnapshot().push?.error).toBe('service-rejected');
  });

  it('unsubscribes at the service and in the browser', async () => {
    const calls = mockFetch();
    const platform = new FakePushPlatform({ permission: 'granted' });
    const { softphone } = await createTestSoftphone({ config: pushConfig(), pushPlatform: platform });
    await softphone.subscribePush();
    const state = await softphone.unsubscribePush();
    expect(state.subscribed).toBe(false);
    expect(platform.subscription).toBeNull();
    const del = calls.find((c) => c.init.method === 'DELETE')!;
    expect(JSON.parse(String(del.init.body))).toEqual({ extension: '1001', endpoint: 'https://push.test/sub/1' });
  });

  it('re-sends the subscription after registering once opted in', async () => {
    const calls = mockFetch();
    const platform = new FakePushPlatform({ permission: 'granted' });
    const { softphone, storage } = await createTestSoftphone({ config: pushConfig(), pushPlatform: platform });
    await softphone.subscribePush();
    await softphone.destroy();
    calls.length = 0;

    const again = await createTestSoftphone({ config: pushConfig(), pushPlatform: platform, storage });
    await vi.waitFor(() => expect(calls.filter((c) => c.init.method === 'POST')).toHaveLength(1));
    await vi.waitFor(() => expect(again.softphone.getSnapshot().push?.subscribed).toBe(true));
    expect(platform.closed).toContain(undefined); // notifications closed on register
  });
});

describe('push: notification click', () => {
  it('answers the call the agent clicked "Answer" for (deep link, X-Sipkit-Push-Id)', async () => {
    const platform = new FakePushPlatform({ permission: 'granted', launch: { action: 'answer', pushCallId: 'pbx-7', caller: '1002' } });
    const { softphone, engine } = await createTestSoftphone({ config: pushConfig(), pushPlatform: platform });
    const actions: unknown[] = [];
    softphone.on('push:action', (a) => actions.push(a));
    expect(softphone.getSnapshot().push?.pending).toMatchObject({ action: 'answer', pushCallId: 'pbx-7' });
    expect(platform.launch).not.toBeNull(); // deep link kept until matched

    // Another call first: not matched, keeps ringing.
    engine.simulateIncomingCall({ remoteNumber: '1003', pushId: 'pbx-other' });
    await vi.waitFor(() => expect(softphone.getSnapshot().calls).toHaveLength(1));
    expect(softphone.getSnapshot().calls[0]!.state).toBe('ringing');

    engine.simulateIncomingCall({ remoteNumber: '1002', pushId: 'pbx-7' });
    await vi.waitFor(() => {
      const call = softphone.getSnapshot().calls.find((c) => c.pushId === 'pbx-7');
      expect(call?.state).toBe('connected');
    });
    expect(softphone.getSnapshot().push?.pending).toBeUndefined();
    expect(actions).toHaveLength(1);
    expect(platform.closed).toContain('pbx-7');
    expect(platform.launch).toBeNull(); // deep link removed from the URL
  });

  it('falls back to the caller number when the INVITE has no push id', async () => {
    const platform = new FakePushPlatform({ permission: 'granted' });
    const { softphone, engine } = await createTestSoftphone({ config: pushConfig(), pushPlatform: platform });
    const actions: Array<{ callId?: string }> = [];
    softphone.on('push:action', (a) => actions.push(a));
    platform.simulateWorkerLaunch({ action: 'answer', pushCallId: 'x', caller: '1002' });
    engine.simulateIncomingCall({ remoteNumber: '1002' });
    await vi.waitFor(() => expect(softphone.getSnapshot().calls[0]?.state).toBe('connected'));
    expect(actions.map((a) => Boolean(a.callId))).toEqual([false, true]);
  });

  it('only surfaces the call for "open" and with autoAnswer off', async () => {
    const platform = new FakePushPlatform({ permission: 'granted', launch: { action: 'open', pushCallId: 'p1' } });
    const { softphone, engine } = await createTestSoftphone({ config: pushConfig(), pushPlatform: platform });
    engine.simulateIncomingCall({ remoteNumber: '1002', pushId: 'p1' });
    await vi.waitFor(() => expect(softphone.getSnapshot().calls).toHaveLength(1));
    expect(softphone.getSnapshot().calls[0]!.state).toBe('ringing');
    expect(softphone.getSnapshot().push?.pending).toBeUndefined();

    const p2 = new FakePushPlatform({ permission: 'granted', launch: { action: 'answer', pushCallId: 'p2' } });
    const b = await createTestSoftphone({ config: pushConfig({ autoAnswer: false }), pushPlatform: p2 });
    b.engine.simulateIncomingCall({ remoteNumber: '1002', pushId: 'p2' });
    await vi.waitFor(() => expect(b.softphone.getSnapshot().calls).toHaveLength(1));
    expect(b.softphone.getSnapshot().calls[0]!.state).toBe('ringing');
  });

  it('drops expired clicks and ignores launches while push is disabled', async () => {
    const old = new FakePushPlatform({ launch: { action: 'answer', pushCallId: 'p', at: Date.now() - 600_000 } });
    const a = await createTestSoftphone({ config: pushConfig(), pushPlatform: old });
    expect(a.softphone.getSnapshot().push?.pending).toBeUndefined();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fresh = new FakePushPlatform({ launch: { action: 'answer', pushCallId: 'p' } });
    const b = await createTestSoftphone({ config: pushConfig({ launchTimeout: 10 }), pushPlatform: fresh, start: false });
    expect(b.softphone.getSnapshot().push?.pending).toBeDefined();
    vi.advanceTimersByTime(11_000);
    expect(b.softphone.getSnapshot().push?.pending).toBeUndefined();
    vi.useRealTimers();

    const off = new FakePushPlatform({ launch: { action: 'answer', pushCallId: 'p' } });
    const c = await createTestSoftphone({ pushPlatform: off });
    expect(c.softphone.getSnapshot().push?.pending).toBeUndefined();
    expect(off.launch).not.toBeNull();
  });

  it('enables push at runtime via updateConfig and passes labels to the worker', async () => {
    mockFetch();
    const platform = new FakePushPlatform({ permission: 'granted' });
    const { softphone } = await createTestSoftphone({ pushPlatform: platform });
    await softphone.updateConfig(pushConfig());
    expect(softphone.getSnapshot().push?.enabled).toBe(true);
    softphone.setPushLabels({ title: 'Incoming call', answer: 'Answer' });
    await softphone.subscribePush();
    expect(platform.workerConfig?.labels).toEqual({ title: 'Incoming call', answer: 'Answer' });
  });
});
