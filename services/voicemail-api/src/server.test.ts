import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRange, createVoicemailServer, type ServerConfig } from './server.js';
import { Spool } from './spool.js';
import { addMessage, tempSpool, wav } from './test-utils.js';
import { mintToken } from './token.js';

const SECRET = 's'.repeat(40);
const ORIGIN = 'http://localhost:5179';
let server: Server;
let base: string;
let root: string;
const refresh = vi.fn(async () => true);

async function start(overrides: Partial<ServerConfig> = {}) {
  root = await tempSpool();
  const config: ServerConfig = {
    corsOrigins: [ORIGIN],
    defaultContext: 'default',
    tokenSecret: SECRET,
    tokenMaxTtl: 86400,
    staticTokens: new Map([['1002@default', 'static-1002-token']]),
    devToken: undefined,
    ...overrides,
  };
  server = createVoicemailServer({ config, spool: new Spool({ root }), refresher: { refresh } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const tokenFor = (mailbox: string, context = 'default') => mintToken(SECRET, { mailbox, context, ttlSeconds: 300 });
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => {
  refresh.mockClear();
  await start();
  await addMessage(root, '1002', { index: 0, origtime: 100 });
  await addMessage(root, '1002', { index: 1, origtime: 200 });
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

describe('auth', () => {
  it('requires a token', async () => {
    const res = await fetch(`${base}/v1/mailboxes/1002/messages`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('accepts HMAC tokens for their own mailbox only', async () => {
    expect((await fetch(`${base}/v1/mailboxes/1002/messages`, { headers: auth(tokenFor('1002')) })).status).toBe(200);
    expect((await fetch(`${base}/v1/mailboxes/1002/messages`, { headers: auth(tokenFor('1001')) })).status).toBe(403);
    expect((await fetch(`${base}/v1/mailboxes/1002@other/messages`, { headers: auth(tokenFor('1002')) })).status).toBe(403);
    const expired = mintToken(SECRET, { mailbox: '1002', ttlSeconds: 10, now: Date.now() - 60_000 });
    expect((await fetch(`${base}/v1/mailboxes/1002/messages`, { headers: auth(expired) })).status).toBe(401);
  });

  it('accepts static per-mailbox tokens and the dev token', async () => {
    expect((await fetch(`${base}/v1/mailboxes/1002/messages`, { headers: auth('static-1002-token') })).status).toBe(200);
    expect((await fetch(`${base}/v1/mailboxes/1001/messages`, { headers: auth('static-1002-token') })).status).toBe(401);
    await new Promise((r) => server.close(r));
    await start({ devToken: 'dev-token-123', tokenSecret: undefined });
    expect((await fetch(`${base}/v1/mailboxes/1001/messages`, { headers: auth('dev-token-123') })).status).toBe(200);
    expect((await fetch(`${base}/v1/mailboxes/1001/messages`, { headers: auth(tokenFor('1001')) })).status).toBe(401);
  });

  it('accepts ?access_token= only on the audio route', async () => {
    const t = tokenFor('1002');
    expect((await fetch(`${base}/v1/mailboxes/1002/messages?access_token=${t}`)).status).toBe(401);
    expect((await fetch(`${base}/v1/mailboxes/1002/messages/200-0001/audio?access_token=${t}`)).status).toBe(200);
  });
});

describe('CORS', () => {
  it('answers preflights for allowed origins only', async () => {
    const ok = await fetch(`${base}/v1/mailboxes/1002/messages`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'DELETE' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-headers')).toContain('Authorization');
    const bad = await fetch(`${base}/v1/mailboxes/1002/messages`, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('messages', () => {
  it('lists messages with counts', async () => {
    const res = await fetch(`${base}/v1/mailboxes/1002/messages`, { headers: { ...auth(tokenFor('1002')), Origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { counts: unknown; messages: { id: string }[] };
    expect(body.counts).toEqual({ new: 2, old: 0, urgentNew: 0, urgentOld: 0 });
    expect(body.messages.map((m) => m.id)).toEqual(['200-0001', '100-0000']);
  });

  it('streams audio with Range support', async () => {
    const url = `${base}/v1/mailboxes/1002/messages/200-0001/audio`;
    const full = await fetch(url, { headers: auth(tokenFor('1002')) });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('audio/wav');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    const bytes = Buffer.from(await full.arrayBuffer());
    expect(bytes.equals(wav(801))).toBe(true);

    const part = await fetch(url, { headers: { ...auth(tokenFor('1002')), Range: 'bytes=0-11' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-11/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString('latin1', 0, 4)).toBe('RIFF');

    const tail = await fetch(url, { headers: { ...auth(tokenFor('1002')), Range: 'bytes=-4' } });
    expect(tail.status).toBe(206);
    expect((await tail.arrayBuffer()).byteLength).toBe(4);

    const bad = await fetch(url, { headers: { ...auth(tokenFor('1002')), Range: `bytes=${bytes.length}-` } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe(`bytes */${bytes.length}`);

    const head = await fetch(url, { method: 'HEAD', headers: auth(tokenFor('1002')) });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.length));
  });

  it('marks read and refreshes MWI once', async () => {
    const res = await fetch(`${base}/v1/mailboxes/1002/messages/100-0000/read`, { method: 'POST', headers: auth(tokenFor('1002')) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: '100-0000', folder: 'old' });
    expect(refresh).toHaveBeenCalledWith('default', '1002');
    await fetch(`${base}/v1/mailboxes/1002/messages/100-0000/read`, { method: 'POST', headers: auth(tokenFor('1002')) });
    expect(refresh).toHaveBeenCalledTimes(1);
    const list = (await (await fetch(`${base}/v1/mailboxes/1002/messages`, { headers: auth(tokenFor('1002')) })).json()) as {
      counts: { new: number; old: number };
    };
    expect(list.counts).toMatchObject({ new: 1, old: 1 });
  });

  it('deletes and refreshes MWI', async () => {
    const res = await fetch(`${base}/v1/mailboxes/1002/messages/200-0001`, { method: 'DELETE', headers: auth(tokenFor('1002')) });
    expect(res.status).toBe(204);
    expect(refresh).toHaveBeenCalledWith('default', '1002');
    expect((await fetch(`${base}/v1/mailboxes/1002/messages/200-0001`, { headers: auth(tokenFor('1002')) })).status).toBe(404);
    expect((await fetch(`${base}/v1/mailboxes/1002/messages/200-0001`, { method: 'DELETE', headers: auth(tokenFor('1002')) })).status).toBe(404);
  });

  it('rejects traversal before touching the filesystem', async () => {
    for (const path of [
      '/v1/mailboxes/..%2F..%2Fetc/messages',
      '/v1/mailboxes/1002@..%2F..%2Fetc/messages',
      '/v1/mailboxes/%2E%2E/messages',
      '/v1/mailboxes/1002/messages/..%2F..%2Fpasswd/audio',
    ]) {
      const res = await fetch(`${base}${path}`, { headers: auth(tokenFor('1002')) });
      expect([400, 404], path).toContain(res.status);
    }
    expect((await fetch(`${base}/v1/mailboxes/1002/messages/x/nope`, { headers: auth(tokenFor('1002')) })).status).toBe(404);
  });

  it('405 for wrong methods', async () => {
    expect((await fetch(`${base}/v1/mailboxes/1002/messages`, { method: 'POST', headers: auth(tokenFor('1002')) })).status).toBe(405);
    expect((await fetch(`${base}/v1/mailboxes/1002/messages/100-0000/read`, { headers: auth(tokenFor('1002')) })).status).toBe(405);
  });

  it('health check needs no token', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  });
});

describe('parseRange', () => {
  it('handles the usual forms', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-20', 100)).toEqual({ start: 10, end: 20 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=20-10', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });
});
