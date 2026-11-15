import { describe, expect, it, vi } from 'vitest';
import {
  PUSH_LAUNCH_PARAMS,
  PUSH_NOTIFICATION_TAG,
  PUSH_WORKER_CONFIG_MESSAGE,
  PUSH_WORKER_MESSAGE,
  parseLaunch,
} from 'sipkit-core';
import { CONFIG_MESSAGE, LAUNCH_MESSAGE, LAUNCH_PARAMS, NOTIFICATION_TAG, installPushWorker, type PushWorkerScope } from './service-worker';

const NOW = 1_800_000_000_000;

function fakeScope(windows: Array<{ url: string }> = []) {
  const listeners = new Map<string, (e: unknown) => void>();
  const shown: Array<{ title: string; options: Record<string, unknown>; closed: boolean }> = [];
  const posted: unknown[] = [];
  const opened: string[] = [];
  const fetches: Array<{ url: string; init: Record<string, unknown> }> = [];
  const store = new Map<string, unknown>();
  const clients = windows.map((w) => ({
    url: w.url,
    focus: vi.fn(async function (this: unknown) {
      return client;
    }),
    postMessage: (m: unknown) => posted.push(m),
  }));
  const client = clients[0]!;
  const scope: PushWorkerScope = {
    registration: {
      scope: 'https://app.test/',
      showNotification: async (title, options) => void shown.push({ title, options, closed: false }),
      getNotifications: async (filter) =>
        shown
          .filter((n) => !n.closed && (!filter?.tag || n.options.tag === filter.tag))
          .map((n) => ({ tag: String(n.options.tag), data: n.options.data, close: () => void (n.closed = true) })),
    },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => {
        opened.push(url);
        return null;
      },
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
    addEventListener: (type, l) => void listeners.set(type, l as (e: unknown) => void),
    caches: {
      open: async () => ({
        match: async (k: string) => (store.has(k) ? { json: async () => store.get(k) } : undefined),
        put: async (k: string, res: unknown) => void store.set(k, await (res as Response).json()),
      }),
    },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return {};
    },
  };
  const fire = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { scope, shown, posted, opened, fetches, fire, listeners };
}

const incoming = {
  v: 1,
  type: 'incoming-call',
  callId: '1800000000.7',
  extension: '1002',
  callerId: '1001',
  callerName: 'Front desk',
  at: NOW,
  ttl: 45,
  decline: { exp: 99, sig: 'sig' },
};

describe('push service worker', () => {
  it('uses the same protocol constants as core', () => {
    expect(LAUNCH_PARAMS).toEqual(PUSH_LAUNCH_PARAMS);
    expect(LAUNCH_MESSAGE).toBe(PUSH_WORKER_MESSAGE);
    expect(CONFIG_MESSAGE).toBe(PUSH_WORKER_CONFIG_MESSAGE);
    expect(NOTIFICATION_TAG).toBe(PUSH_NOTIFICATION_TAG);
  });

  it('shows an incoming call notification with Answer / Decline, localised by the page', async () => {
    const f = fakeScope();
    installPushWorker(f.scope, () => NOW + 1000);
    await f.fire('message', { data: { type: CONFIG_MESSAGE, config: { appUrl: 'https://app.test/phone', labels: { title: 'आगमन कल', answer: 'उत्तर' } } } });
    await f.fire('push', { data: { json: () => incoming } });
    expect(f.shown).toHaveLength(1);
    expect(f.shown[0]!.title).toBe('आगमन कल');
    expect(f.shown[0]!.options).toMatchObject({
      body: 'Front desk (1001) is calling',
      tag: 'sipkit-call-1800000000.7',
      requireInteraction: true,
      actions: [
        { action: 'answer', title: 'उत्तर' },
        { action: 'decline', title: 'Decline' },
      ],
    });
  });

  it('skips stale calls and closes cancelled ones', async () => {
    const f = fakeScope();
    const api = installPushWorker(f.scope, () => NOW + 60_000);
    await api.handlePush(incoming);
    expect(f.shown).toHaveLength(0);
    const g = fakeScope();
    const api2 = installPushWorker(g.scope, () => NOW);
    await api2.handlePush(incoming);
    await api2.handlePush({ v: 1, type: 'call-cancelled', callId: incoming.callId, extension: '1002' });
    expect(g.shown[0]!.closed).toBe(true);
  });

  it('Answer focuses the open softphone and posts the launch', async () => {
    const f = fakeScope([{ url: 'https://app.test/phone?tab=1' }]);
    const api = installPushWorker(f.scope, () => NOW);
    await f.fire('message', { data: { type: CONFIG_MESSAGE, config: { appUrl: 'https://app.test/phone' } } });
    await api.handleClick({ tag: 'x', data: incoming, close: vi.fn() }, 'answer');
    expect(f.posted).toEqual([{ type: LAUNCH_MESSAGE, launch: { action: 'answer', pushCallId: incoming.callId, caller: '1001' } }]);
    expect(f.opened).toHaveLength(0);
  });

  it('opens the app with a deep link core understands when no tab is open', async () => {
    const f = fakeScope();
    const api = installPushWorker(f.scope, () => NOW);
    await f.fire('message', { data: { type: CONFIG_MESSAGE, config: { appUrl: 'https://app.test/phone?tab=1' } } });
    await api.handleClick({ tag: 'x', data: incoming, close: vi.fn() }, '');
    const url = new URL(f.opened[0]!);
    expect(url.pathname).toBe('/phone');
    expect(url.searchParams.get('tab')).toBe('1');
    expect(parseLaunch(url.search)).toEqual({ action: 'open', pushCallId: incoming.callId, caller: '1001', at: NOW });
  });

  it('Decline posts the signed decline to the push service', async () => {
    const f = fakeScope();
    const api = installPushWorker(f.scope, () => NOW);
    await f.fire('message', { data: { type: CONFIG_MESSAGE, config: { serviceUrl: 'https://push.test/' } } });
    await api.handleClick({ tag: 'x', data: incoming, close: vi.fn() }, 'decline');
    expect(f.fetches[0]!.url).toBe('https://push.test/calls/1800000000.7/decline');
    expect(JSON.parse(String(f.fetches[0]!.init.body))).toEqual({ extension: '1002', exp: 99, sig: 'sig' });
    expect(f.opened).toHaveLength(0);
  });
});
