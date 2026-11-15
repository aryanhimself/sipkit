import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type ServiceConfig } from './config.ts';
import type { IncomingCallPush, PushPayload } from './payload.ts';
import { createPushServer, type PushServer } from './server.ts';
import { generateVapidKeys, type PushSender, type SendOptions } from './sender.ts';
import { JsonFileStore, MemoryStore } from './store.ts';
import { createSubscriberKeys, decryptWebPush, startFakePushEndpoint, type FakePushEndpoint } from './testing.ts';
import { mintToken, verifyToken } from './tokens.ts';

const VAPID = generateVapidKeys();
const SECRET = 'x'.repeat(40);

function testConfig(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    ...loadConfig({
      VAPID_PUBLIC_KEY: VAPID.publicKey,
      VAPID_PRIVATE_KEY: VAPID.privateKey,
      PUSH_TOKEN_SECRET: SECRET,
      PUSH_DEV_TOKEN: 'dev-token',
      PUSH_NOTIFY_SECRET: 'pbx-secret',
      PUSH_STORE_FILE: '',
      PUSH_ALLOW_INSECURE_ENDPOINTS: '1',
      PUSH_DEBUG: '1',
    }),
    ...over,
  };
}

function subscription(endpoint: string, keys = createSubscriberKeys()) {
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, expirationTime: null };
}

class RecordingSender implements PushSender {
  sent: Array<{ endpoint: string; payload: PushPayload; options: SendOptions }> = [];
  status = new Map<string, number>();
  async send(sub: { endpoint: string }, payload: string, options: SendOptions) {
    this.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as PushPayload, options });
    return { statusCode: this.status.get(sub.endpoint) ?? 201 };
  }
}

describe('tokens', () => {
  it('mints and verifies HMAC tokens bound to an extension', () => {
    const token = mintToken(SECRET, '1001', 60);
    expect(verifyToken(SECRET, token)?.sub).toBe('1001');
    expect(verifyToken('y'.repeat(40), token)).toBeNull();
    expect(verifyToken(SECRET, token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();
    expect(verifyToken(SECRET, token, Date.now() + 61_000)).toBeNull();
    expect(verifyToken(SECRET, 'garbage')).toBeNull();
  });
});

describe('config', () => {
  it('rejects a missing VAPID key pair and secrets', () => {
    expect(() => loadConfig({})).toThrow(/VAPID_PUBLIC_KEY/);
    expect(() => loadConfig({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', PUSH_TOKEN_SECRET: 'short', PUSH_NOTIFY_SECRET: 'x' })).toThrow(/32 characters/);
  });
});

describe('push service over HTTP', () => {
  let push: PushServer;
  let base: string;
  let sender: RecordingSender;

  async function start(cfg = testConfig(), store = new MemoryStore()) {
    sender = new RecordingSender();
    push = await createPushServer({ config: cfg, store, sender });
    await new Promise<void>((resolve) => push.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(push.server.address() as AddressInfo).port}`;
  }

  const api = (path: string, init: RequestInit & { token?: string; pbx?: boolean } = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.pbx ? { 'X-Sipkit-Push-Secret': 'pbx-secret' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  afterEach(async () => {
    await new Promise<void>((resolve) => push.server.close(() => resolve()));
  });

  it('serves the VAPID public key and CORS preflight', async () => {
    await start();
    expect(await (await api('/vapid-public-key')).json()).toEqual({ publicKey: VAPID.publicKey });
    const pre = await fetch(`${base}/subscriptions`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
  });

  it('stores subscriptions per extension with a minted token and rejects other extensions', async () => {
    await start();
    const token = mintToken(SECRET, '1001');
    const res = await api('/subscriptions', { method: 'POST', token, body: JSON.stringify({ subscription: subscription('https://push.test/a') }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, extension: '1001' });
    const denied = await api('/subscriptions', {
      method: 'POST',
      token,
      body: JSON.stringify({ extension: '1002', subscription: subscription('https://push.test/b') }),
    });
    expect(denied.status).toBe(403);
    expect((await api('/subscriptions', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await api('/subscriptions', { method: 'POST', token: 'skp1.bad.sig', body: '{}' })).status).toBe(401);
    const list = (await (await api('/subscriptions', { token })).json()) as { subscriptions: unknown[] };
    expect(list.subscriptions).toHaveLength(1);
  });

  it('accepts the development token for any extension (extension required)', async () => {
    await start();
    expect(
      (await api('/subscriptions', { method: 'POST', token: 'dev-token', body: JSON.stringify({ subscription: subscription('https://push.test/a') }) })).status,
    ).toBe(400);
    expect(
      (
        await api('/subscriptions', {
          method: 'POST',
          token: 'dev-token',
          body: JSON.stringify({ extension: '1002', subscription: subscription('https://push.test/a') }),
        })
      ).status,
    ).toBe(201);
  });

  it('validates subscriptions (https + known push hosts in production mode)', async () => {
    await start(testConfig({ allowInsecureEndpoints: false }));
    const token = mintToken(SECRET, '1001');
    const post = (endpoint: string) => api('/subscriptions', { method: 'POST', token, body: JSON.stringify({ subscription: subscription(endpoint) }) });
    expect((await post('http://fcm.googleapis.com/fcm/send/x')).status).toBe(400);
    expect((await post('https://10.0.0.5/x')).status).toBe(400);
    expect((await post('https://evil.example.com/x')).status).toBe(400);
    expect((await post('https://fcm.googleapis.com/fcm/send/abc')).status).toBe(201);
    expect((await post('https://updates.push.services.mozilla.com/wpush/v2/abc')).status).toBe(201);
    const bad = await api('/subscriptions', {
      method: 'POST',
      token,
      body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short', auth: 'x' } } }),
    });
    expect(bad.status).toBe(400);
  });

  it('notifies every subscription of the extension on an incoming call (form body from Asterisk CURL)', async () => {
    await start();
    await push.service.subscribe('1002', subscription('https://push.test/a'));
    await push.service.subscribe('1002', subscription('https://push.test/b'));
    await push.service.subscribe('1003', subscription('https://push.test/c'));
    expect((await api('/notify/incoming', { method: 'POST', body: '{}' })).status).toBe(401);
    const res = await fetch(`${base}/notify/incoming`, {
      method: 'POST',
      headers: { 'X-Sipkit-Push-Secret': 'pbx-secret', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'extension=1002&callId=1730000000.42&callerId=1001&callerName=Front%20desk',
    });
    expect(await res.json()).toEqual({ sent: 2, failed: 0, pruned: 0, subscriptions: 2 });
    expect(sender.sent.map((s) => s.endpoint).sort()).toEqual(['https://push.test/a', 'https://push.test/b']);
    const payload = sender.sent[0]!.payload as IncomingCallPush;
    expect(payload).toMatchObject({ v: 1, type: 'incoming-call', callId: '1730000000.42', extension: '1002', callerId: '1001', callerName: 'Front desk' });
    expect(payload.decline?.sig).toBeTruthy();
    expect(sender.sent[0]!.options).toMatchObject({ urgency: 'high', ttl: 45 });
    expect(await (await api('/calls/1730000000.42/status', { pbx: true })).text()).toBe('ringing');
  });

  it('prunes 404/410 subscriptions and counts other failures', async () => {
    await start();
    await push.service.subscribe('1002', subscription('https://push.test/gone'));
    await push.service.subscribe('1002', subscription('https://push.test/flaky'));
    await push.service.subscribe('1002', subscription('https://push.test/ok'));
    sender.status.set('https://push.test/gone', 410);
    sender.status.set('https://push.test/flaky', 500);
    const result = await push.service.notifyIncoming({ extension: '1002', callId: 'c1', callerId: '1001' });
    expect(result).toEqual({ sent: 1, failed: 1, pruned: 1, subscriptions: 3 });
    expect((await push.service.list('1002')).map((s) => s.endpointHost)).toHaveLength(2);
    for (let i = 0; i < 4; i++) await push.service.notifyIncoming({ extension: '1002', callId: `c${i + 2}`, callerId: '1001' });
    expect(await push.service.prune()).toBe(1); // flaky failed 5 times in a row
    expect(await push.service.list('1002')).toHaveLength(1);
  });

  it('prunes subscriptions past their expirationTime', async () => {
    await start();
    await push.service.subscribe('1002', { ...subscription('https://push.test/old'), expirationTime: Date.now() - 1 });
    const res = await api('/admin/prune', { method: 'POST', pbx: true });
    expect(await res.json()).toEqual({ pruned: 1 });
  });

  it('cancels and declines calls; the dialplan polls the status', async () => {
    await start();
    await push.service.subscribe('1002', subscription('https://push.test/a'));
    await push.service.notifyIncoming({ extension: '1002', callId: 'call-1', callerId: '1001' });
    const decline = (sender.sent[0]!.payload as IncomingCallPush).decline!;
    const bad = await api('/calls/call-1/decline', { method: 'POST', body: JSON.stringify({ extension: '1002', exp: decline.exp, sig: 'nope' }) });
    expect(bad.status).toBe(403);
    const ok = await api('/calls/call-1/decline', { method: 'POST', body: JSON.stringify({ extension: '1002', ...decline }) });
    expect(ok.status).toBe(200);
    expect(await (await api('/calls/call-1/status', { pbx: true })).text()).toBe('declined');

    await push.service.notifyIncoming({ extension: '1002', callId: 'call-2', callerId: '1001' });
    await api('/notify/cancel', { method: 'POST', pbx: true, body: JSON.stringify({ extension: '1002', callId: 'call-2', reason: 'hangup' }) });
    expect(sender.sent.at(-1)!.payload).toMatchObject({ type: 'call-cancelled', callId: 'call-2', reason: 'hangup' });
    expect(sender.sent.at(-1)!.options.topic).toBe(sender.sent.at(-2)!.options.topic);
    expect(await (await api('/calls/call-2/status', { pbx: true })).text()).toBe('cancelled');
    expect(await (await api('/calls/unknown-call/status', { pbx: true })).text()).toBe('unknown');
  });

  it('unsubscribes one endpoint or all of an extension', async () => {
    await start();
    const token = mintToken(SECRET, '1001');
    await push.service.subscribe('1001', subscription('https://push.test/a'));
    await push.service.subscribe('1001', subscription('https://push.test/b'));
    const one = await api('/subscriptions', { method: 'DELETE', token, body: JSON.stringify({ endpoint: 'https://push.test/a' }) });
    expect(await one.json()).toEqual({ ok: true, removed: 1 });
    const all = await api('/subscriptions', { method: 'DELETE', token, body: '{}' });
    expect(await all.json()).toEqual({ ok: true, removed: 1 });
  });

  it('keeps at most maxPerExtension subscriptions', async () => {
    await start(testConfig({ maxPerExtension: 2 }));
    for (const e of ['a', 'b', 'c']) await push.service.subscribe('1001', subscription(`https://push.test/${e}`));
    expect(await push.service.list('1001')).toHaveLength(2);
  });

  it('exposes recent events in debug mode', async () => {
    await start();
    await push.service.notifyIncoming({ extension: '1002', callId: 'c9', callerId: '1001' });
    const { events } = (await (await api('/debug/events', { pbx: true })).json()) as { events: Array<{ type: string }> };
    expect(events.map((e) => e.type)).toContain('notify');
  });
});

describe('real Web Push encryption against a fake push endpoint', () => {
  let endpoint: FakePushEndpoint;
  beforeEach(async () => {
    endpoint = await startFakePushEndpoint();
  });
  afterEach(async () => {
    await endpoint.close();
  });

  it('sends a VAPID-signed aes128gcm message the subscriber can decrypt; 410 prunes it', async () => {
    const push = await createPushServer({ config: testConfig(), store: new MemoryStore() });
    const keys = createSubscriberKeys();
    await push.service.subscribe('1002', subscription(`${endpoint.url}/push/abc`, keys));
    const result = await push.service.notifyIncoming({ extension: '1002', callId: '42.1', callerId: '1001', callerName: 'Alice' });
    expect(result.sent).toBe(1);
    const msg = endpoint.received[0]!;
    expect(msg.path).toBe('/push/abc');
    expect(msg.headers['content-encoding']).toBe('aes128gcm');
    expect(msg.headers.urgency).toBe('high');
    expect(msg.headers.ttl).toBe('45');
    expect(String(msg.headers.authorization)).toMatch(/^vapid t=.+, k=/);
    const payload = JSON.parse(decryptWebPush(msg.body, keys)) as IncomingCallPush;
    expect(payload).toMatchObject({ type: 'incoming-call', callId: '42.1', callerId: '1001', callerName: 'Alice' });

    endpoint.respondWith(410);
    expect((await push.service.notifyIncoming({ extension: '1002', callId: '42.2', callerId: '1001' })).pruned).toBe(1);
    expect(await push.service.list('1002')).toHaveLength(0);
  });
});

describe('JsonFileStore', () => {
  it('persists across reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sipkit-push-'));
    try {
      const file = join(dir, 'nested', 'subs.json');
      const a = await JsonFileStore.open(file);
      await a.upsert({ extension: '1001', endpoint: 'https://push.test/a', keys: { p256dh: 'p', auth: 'a' }, createdAt: 1, updatedAt: 1 });
      await a.upsert({ extension: '1002', endpoint: 'https://push.test/b', keys: { p256dh: 'p', auth: 'a' }, createdAt: 1, updatedAt: 1 });
      await a.remove('https://push.test/b');
      const b = await JsonFileStore.open(file);
      expect((await b.all()).map((r) => r.endpoint)).toEqual(['https://push.test/a']);
      expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
