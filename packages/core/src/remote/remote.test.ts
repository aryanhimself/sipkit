import { describe, expect, it, vi } from 'vitest';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';
import { createTestSoftphone } from '../testing';
import { resolveConfig } from '../config';
import type { SoftphoneApi } from '../types';
import {
  EXTENSION_BRIDGE_NS,
  MessagePortTransport,
  RemoteSoftphone,
  connectExtension,
  createCdrLog,
  createLoopbackPair,
  createSharedSoftphone,
  isExtensionWindowMessage,
  parseClientMessage,
  parseHostMessage,
  pickProvisioning,
  publicConfig,
  remoteMessage,
  sanitizeSnapshot,
  serveSoftphone,
  validateCommand,
  type ChannelLike,
  type LocksLike,
  type SharedSoftphone,
} from './index';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('protocol', () => {
  it('whitelists commands and checks their arguments', () => {
    expect(validateCommand('call', ['1002'])).toBe(true);
    expect(validateCommand('call', ['1002', { video: true }])).toBe(true);
    expect(validateCommand('call', ['1002', { video: true, evil: 1 }])).toBe(false);
    expect(validateCommand('call', [''])).toBe(false);
    expect(validateCommand('call', [42])).toBe(false);
    expect(validateCommand('hold', ['yes'])).toBe(false);
    expect(validateCommand('sendDtmf', ['12#*'])).toBe(true);
    expect(validateCommand('sendDtmf', ['<script>'])).toBe(false);
    expect(validateCommand('reject', ['c1', 200])).toBe(false);
    expect(validateCommand('hangup', ['c1', 'extra'])).toBe(false);
    expect(validateCommand('start', [])).toBe(false);
    expect(validateCommand('stop', [])).toBe(false);
    expect(validateCommand('plugin', ['x'])).toBe(false);
    expect(validateCommand('__proto__', [])).toBe(false);
    expect(validateCommand('setVolume', ['speaker', 2])).toBe(false);
  });

  it('parses only namespaced, versioned, well-formed messages', () => {
    expect(parseClientMessage(remoteMessage({ type: 'hello', clientId: 'abc' }))).not.toBeNull();
    expect(parseClientMessage({ type: 'hello', clientId: 'abc' })).toBeNull();
    expect(parseClientMessage({ ...remoteMessage({ type: 'hello', clientId: 'abc' }), v: 2 })).toBeNull();
    expect(parseClientMessage(remoteMessage({ type: 'hello', clientId: 'a b' }))).toBeNull();
    expect(parseClientMessage(remoteMessage({ type: 'command', id: 1, name: 'call', args: ['1'] }))).not.toBeNull();
    expect(parseClientMessage(remoteMessage({ type: 'command', id: -1, name: 'call', args: ['1'] }))).toBeNull();
    expect(parseClientMessage(remoteMessage({ type: 'command', id: 1, name: 'stop', args: [] } as never))).toBeNull();
    // A host message is not a client message and vice versa.
    expect(parseClientMessage(remoteMessage({ type: 'state', snapshot: {} } as never))).toBeNull();
    expect(parseHostMessage(remoteMessage({ type: 'state', snapshot: { app: 'x' } } as never))).toBeNull();
    expect(parseHostMessage(remoteMessage({ type: 'event', name: 'log', payload: {} } as never))).toBeNull();
  });

  it('never shares secrets in the config', () => {
    const cfg = resolveConfig({
      username: '1001',
      password: 'hunter2',
      registerHeaders: ['Authorization: Bearer abc'],
      extraHeaders: ['X-Secret: 1'],
      iceServers: [{ urls: 'turn:t', username: 'u', credential: 'turnpw' }],
      voicemail: { enabled: true, api: { baseUrl: 'https://vm', token: 'vmtoken', getToken: async () => 'x' } },
      push: { enabled: true, token: 'pushtoken' },
    });
    const pub = publicConfig(cfg);
    const text = JSON.stringify(pub);
    for (const secret of ['hunter2', 'Bearer abc', 'X-Secret', 'turnpw', 'vmtoken', 'pushtoken']) expect(text).not.toContain(secret);
    expect(pub.username).toBe('1001');
    // The UI can still build a config from it.
    expect(resolveConfig(pub).voicemail.enabled).toBe(true);
  });

  it('keeps only provisioning keys from updateConfig', () => {
    expect(
      pickProvisioning({ username: '1002', password: 'p', techPrefix: '9', registerHeaders: ['Authorization: Bearer t'], websocketUrls: 'nope' }),
    ).toEqual({ username: '1002', password: 'p', registerHeaders: ['Authorization: Bearer t'] });
  });
});

async function hostWithClient(api: SoftphoneApi) {
  const [clientEnd, hostEnd] = createLoopbackPair();
  const cdrLog = createCdrLog(api);
  const session = serveSoftphone(api, hostEnd, { host: { kind: 'local', engine: 'fake' }, cdrLog });
  const remote = new RemoteSoftphone();
  await remote.connect(clientEnd);
  return { remote, session, clientEnd, hostEnd };
}

describe('RemoteSoftphone over a host session', () => {
  it('mirrors state and executes commands on the host instance', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const { remote } = await hostWithClient(softphone);
    expect(remote.status).toBe('connected');
    expect(remote.getSnapshot().registration.state).toBe('registered');
    expect(remote.config.username).toBe('1001');
    expect(remote.config.password).toBe('');

    const created = vi.fn();
    remote.on('call:created', created);
    engine.simulateIncomingCall({ remoteNumber: '1002' });
    await until(() => remote.getSnapshot().calls.length === 1);
    expect(created).toHaveBeenCalled();
    const id = remote.getSnapshot().calls[0]!.id;
    expect(id).toBe(softphone.getSnapshot().calls[0]!.id);

    await remote.answer(id);
    await until(() => remote.getSnapshot().calls[0]?.state === 'connected');
    remote.mute(true, id);
    await until(() => softphone.getSnapshot().calls[0]?.muted === true);
    await remote.hold(true, id);
    expect(softphone.getSnapshot().calls[0]?.hold).not.toBe('none');

    await expect(remote.sendDtmf('<x>')).rejects.toThrow(/refused/i);
    await remote.hangup(id);
    await until(() => remote.getSnapshot().calls.length === 0);
    // Recent calls come from the host's CDR log.
    const history = remote.plugin<{ list(): unknown[] }>('call-history');
    expect(history?.list()).toHaveLength(1);
  });

  it('applies only provisioning keys from a client', async () => {
    const { softphone } = await createTestSoftphone();
    const { remote } = await hostWithClient(softphone);
    await remote.updateConfig({ displayName: 'Agent', techPrefix: '9' });
    expect(softphone.config.displayName).toBe('Agent');
    expect(softphone.config.techPrefix).toBe('');
  });

  it('a second client attaching mid-call gets the same call (reload)', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const first = await hostWithClient(softphone);
    engine.simulateIncomingCall({ remoteNumber: '1002' });
    await until(() => first.remote.getSnapshot().calls.length === 1);
    await first.remote.answer();
    await until(() => softphone.getSnapshot().calls[0]?.state === 'connected');
    const before = softphone.getSnapshot().calls[0]!;
    first.remote.disconnect(); // the page reloads
    await tick();
    expect(softphone.getSnapshot().calls[0]?.state).toBe('connected');
    const second = await hostWithClient(softphone);
    const call = second.remote.getSnapshot().calls[0]!;
    expect(call.id).toBe(before.id);
    expect(call.connectedAt).toBe(before.connectedAt);
    expect(call.state).toBe('connected');
  });

  it('rejects pending commands and reports detached when the host goes away', async () => {
    const { softphone } = await createTestSoftphone();
    const { remote, session } = await hostWithClient(softphone);
    session.dispose('test');
    await until(() => remote.status === 'detached');
    await expect(remote.register()).rejects.toThrow(/not connected/i);
    // The last snapshot stays (no flicker).
    expect(remote.getSnapshot().registration.state).toBe('registered');
  });

  it('sanitizeSnapshot drops non-JSON meta and the push subscription', () => {
    const snap = sanitizeSnapshot({
      app: 'started',
      registration: { state: 'registered' },
      calls: [{ id: 'c', meta: { fn: () => 1, ok: 1 } } as never],
      activeCallId: null,
      devices: { available: [], selected: {} },
      engine: 'x',
      voicemail: {} as never,
      dnd: false,
      presence: {},
      chat: {} as never,
      push: { subscribed: true } as never,
    });
    expect(snap.push).toBeUndefined();
    expect(snap.calls[0]!.meta).toEqual({ ok: 1 });
  });
});

// ---------------------------------------------------------------------------
// Extension handshake
// ---------------------------------------------------------------------------

interface FakeWindow {
  win: Window;
  posted: { data: unknown; ports: unknown[] }[];
  /** Simulates a message event from this window (like a content script would post). */
  dispatch(data: unknown, ports?: unknown[], source?: unknown, origin?: string): void;
  onPost(fn: (data: unknown, ports: unknown[]) => void): void;
}

function fakeWindow(origin = 'https://crm.example.com'): FakeWindow {
  const listeners = new Set<(e: MessageEvent) => void>();
  const posted: FakeWindow['posted'] = [];
  const postHooks: ((d: unknown, p: unknown[]) => void)[] = [];
  const win = {
    location: { origin },
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.add(l),
    removeEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.delete(l),
    postMessage: (data: unknown, _origin: string, ports: unknown[] = []) => {
      posted.push({ data, ports });
      for (const h of postHooks) h(data, ports);
    },
  } as unknown as Window;
  return {
    win,
    posted,
    dispatch(data, ports = [], source = win, o = origin) {
      for (const l of [...listeners]) l({ data, ports, source, origin: o } as unknown as MessageEvent);
    },
    onPost: (fn) => postHooks.push(fn),
  };
}

describe('extension handshake', () => {
  const g = globalThis as unknown as { MessageChannel: unknown };
  const original = g.MessageChannel;
  const useNodeChannels = () => {
    g.MessageChannel = NodeMessageChannel;
    return () => {
      g.MessageChannel = original;
    };
  };

  it('resolves null when no extension answers', async () => {
    const restore = useNodeChannels();
    const { win, posted } = fakeWindow();
    const result = await connectExtension({ window: win, clientId: 'c1', timeoutMs: 30 });
    expect(result).toBeNull();
    expect(isExtensionWindowMessage(posted[0]!.data)).toBe(true);
    restore();
  });

  it('connects through the acked port and gets the host welcome', async () => {
    const restore = useNodeChannels();
    const { softphone } = await createTestSoftphone();
    const fw = fakeWindow();
    // Fake content script: ack + serve the softphone over the page's port.
    fw.onPost((data, ports) => {
      if (!isExtensionWindowMessage(data) || data.type !== 'ext:hello') return;
      const port = ports[0] as MessagePort;
      port.postMessage({ ns: EXTENSION_BRIDGE_NS, v: 1, type: 'ext:ack', extensionVersion: '1.0.0' });
      serveSoftphone(softphone, new MessagePortTransport(port), { host: { kind: 'extension', engine: 'fake' } });
    });
    const conn = await connectExtension({ window: fw.win, clientId: 'c1', timeoutMs: 500 });
    expect(conn?.extensionVersion).toBe('1.0.0');
    const remote = new RemoteSoftphone();
    await remote.connect(conn!.transport);
    expect(remote.host?.kind).toBe('extension');
    expect(remote.getSnapshot().registration.state).toBe('registered');
    remote.disconnect();
    restore();
  });

  it('a refusal (origin not allowed) means no extension', async () => {
    const restore = useNodeChannels();
    const fw = fakeWindow();
    fw.onPost((data, ports) => {
      if (isExtensionWindowMessage(data) && data.type === 'ext:hello')
        (ports[0] as MessagePort).postMessage({ ns: EXTENSION_BRIDGE_NS, v: 1, type: 'ext:refused', reason: 'origin-not-allowed' });
    });
    expect(await connectExtension({ window: fw.win, clientId: 'c1', timeoutMs: 500 })).toBeNull();
    restore();
  });

  it('retries when the content script announces itself late, and ignores foreign windows', async () => {
    const restore = useNodeChannels();
    const fw = fakeWindow();
    let ready = false;
    fw.onPost((data, ports) => {
      if (ready && isExtensionWindowMessage(data) && data.type === 'ext:hello')
        (ports[0] as MessagePort).postMessage({ ns: EXTENSION_BRIDGE_NS, v: 1, type: 'ext:ack' });
    });
    const pending = connectExtension({ window: fw.win, clientId: 'c1', timeoutMs: 300 });
    ready = true;
    // An announce from another frame / origin must be ignored.
    fw.dispatch({ ns: EXTENSION_BRIDGE_NS, v: 1, type: 'ext:announce' }, [], {}, 'https://evil.example');
    expect(fw.posted).toHaveLength(1);
    fw.dispatch({ ns: EXTENSION_BRIDGE_NS, v: 1, type: 'ext:announce' });
    const conn = await pending;
    expect(conn).not.toBeNull();
    conn?.transport.close();
    restore();
  });
});

// ---------------------------------------------------------------------------
// Web host: leader election over Web Locks + BroadcastChannel (fakes)
// ---------------------------------------------------------------------------

function fakeLocks(): LocksLike {
  const queues = new Map<string, { cb: () => Promise<void>; signal?: AbortSignal; resolve: (v: unknown) => void }[]>();
  const held = new Set<string>();
  const pump = (name: string) => {
    if (held.has(name)) return;
    const q = queues.get(name) ?? [];
    let next = q.shift();
    while (next?.signal?.aborted) next = q.shift();
    if (!next) return;
    held.add(name);
    const job = next;
    void job
      .cb()
      .catch(() => undefined)
      .finally(() => {
        held.delete(name);
        job.resolve(undefined);
        pump(name);
      });
  };
  return {
    request(name, options, cb) {
      return new Promise((resolve) => {
        const q = queues.get(name) ?? [];
        q.push({ cb, signal: options.signal, resolve });
        queues.set(name, q);
        options.signal?.addEventListener('abort', () => resolve(undefined));
        pump(name);
      });
    },
  };
}

function fakeChannels(): (name: string) => ChannelLike {
  const members = new Map<string, Set<{ listeners: Set<(e: MessageEvent) => void> }>>();
  return (name) => {
    const me = { listeners: new Set<(e: MessageEvent) => void>() };
    const set = members.get(name) ?? new Set();
    set.add(me);
    members.set(name, set);
    return {
      postMessage(message) {
        const data = structuredClone(message);
        for (const m of set) if (m !== me) queueMicrotask(() => m.listeners.forEach((l) => l({ data } as MessageEvent)));
      },
      addEventListener: (_t, l) => me.listeners.add(l),
      removeEventListener: (_t, l) => me.listeners.delete(l),
      close: () => set.delete(me),
    };
  };
}

describe('createSharedSoftphone', () => {
  it("mode 'local' returns the local instance", async () => {
    const local = { tag: 'local' } as unknown as SoftphoneApi;
    expect(await createSharedSoftphone({ config: {}, createLocal: () => local })).toBe(local);
  });

  it('falls back to a local instance without Web Locks', async () => {
    const local = { tag: 'local' } as unknown as SoftphoneApi;
    const result = await createSharedSoftphone({
      config: { instance: { mode: 'shared', preferExtension: false } },
      createLocal: () => local,
      env: { locks: null, createChannel: fakeChannels() },
    });
    expect(result).toBe(local);
  });

  it('elects one leader, mirrors state to clients and hands over on leave', async () => {
    const locks = fakeLocks();
    const createChannel = fakeChannels();
    const engines: Awaited<ReturnType<typeof createTestSoftphone>>['engine'][] = [];
    const createLocal = async (config: object) => {
      const { softphone, engine } = await createTestSoftphone({ config, start: false });
      engines.push(engine);
      return softphone;
    };
    const config = { instance: { mode: 'shared' as const, preferExtension: false } };
    const env = { locks, createChannel, window: undefined };

    const a = (await createSharedSoftphone({ config, createLocal, env })) as SharedSoftphone;
    await until(() => a.role === 'leader' && a.getSnapshot().registration.state === 'registered');
    const b = (await createSharedSoftphone({ config, createLocal, env })) as SharedSoftphone;
    await until(() => b.status === 'connected');
    expect(b.role).toBe('client');
    expect(a.instancesCreated).toBe(1);
    expect(b.instancesCreated).toBe(0);
    expect(b.getSnapshot().registration.state).toBe('registered');

    // Incoming call rings on the leader; tab B answers it.
    engines[0]!.simulateIncomingCall({ remoteNumber: '1002' });
    await until(() => b.getSnapshot().calls.length === 1);
    await b.answer(b.getSnapshot().calls[0]!.id);
    await until(() => a.getSnapshot().calls[0]?.state === 'connected');

    // The leader goes away: B takes over and creates the (only) new instance.
    await a.destroy();
    await until(() => b.role === 'leader' && b.getSnapshot().registration.state === 'registered');
    expect(b.instancesCreated).toBe(1);
    expect(engines).toHaveLength(2);
    await b.destroy();
  });
});
