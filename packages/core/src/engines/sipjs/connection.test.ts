import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../config';
import type { Logger } from '../../types';

// Light SIP.js mock: only the surface SipConnection touches.
const failing = new Set<string>();
const created: MockUA[] = [];
class MockUA {
  static makeURI = (s: string) => ({ toString: () => s });
  delegate: { onDisconnect?: (e?: Error) => void } | undefined;
  _sessions: Record<string, unknown> = {};
  connected = false;
  constructor(public options: { transportOptions: { server: string }; delegate: MockUA['delegate'] }) {
    this.delegate = options.delegate;
    created.push(this);
  }
  async start() {
    if (failing.has(this.options.transportOptions.server)) throw new Error('connect failed');
    this.connected = true;
  }
  async stop() {
    this.connected = false;
  }
  async reconnect() {
    return this.start();
  }
  isConnected() {
    return this.connected;
  }
}
const registers: unknown[] = [];
class MockRegisterer {
  state = 'Initial';
  private listeners: Array<(s: string) => void> = [];
  stateChange = { addListener: (l: (s: string) => void) => this.listeners.push(l) };
  constructor(public ua: MockUA, public options: unknown) {}
  async register() {
    registers.push(this.options);
    this.state = 'Registered';
    this.listeners.forEach((l) => l('Registered'));
  }
  async unregister() {
    this.state = 'Unregistered';
    this.listeners.forEach((l) => l('Unregistered'));
  }
  async dispose() {}
}
vi.mock('sip.js', () => ({
  UserAgent: MockUA,
  Registerer: MockRegisterer,
  RegistererState: { Registered: 'Registered', Unregistered: 'Unregistered' },
  SIPExtension: { Supported: 'Supported' },
}));

const { SipConnection } = await import('./connection');

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function setup(overrides: Record<string, unknown> = {}) {
  const cfg = resolveConfig({
    username: '1001',
    password: 'pw',
    websocketUrls: ['wss://a.test/ws', 'wss://b.test/ws'],
    reconnectionDelay: 1,
    registerExpires: 120,
    ...overrides,
  });
  const listener = { onTransportState: vi.fn(), onRegistration: vi.fn() };
  const conn = new SipConnection(cfg, listener, logger, () => undefined);
  return { conn, listener };
}

beforeEach(() => {
  failing.clear();
  created.length = 0;
  registers.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SipConnection', () => {
  it('fails over to the next WebSocket URL', async () => {
    failing.add('wss://a.test/ws');
    const { conn, listener } = setup();
    await conn.start();
    expect(created.map((u) => u.options.transportOptions.server)).toEqual(['wss://a.test/ws', 'wss://b.test/ws']);
    expect(conn.isConnected()).toBe(true);
    expect(listener.onTransportState).toHaveBeenLastCalledWith('connected');
    await conn.stop();
  });

  it('passes keepalive, credentials and registerExpires to SIP.js', async () => {
    const { conn } = setup({ keepAliveInterval: 15, authUsername: 'auth1001' });
    await conn.start();
    const opts = created[0]!.options as unknown as Record<string, unknown> & { transportOptions: Record<string, unknown> };
    expect(opts.transportOptions.keepAliveInterval).toBe(15);
    expect(opts.authorizationUsername).toBe('auth1001');
    await conn.register();
    expect(registers[0]).toEqual({ expires: 120, extraHeaders: [] });
    await conn.stop();
  });

  it('sends registerHeaders on REGISTER (token auth)', async () => {
    const { conn } = setup({ registerHeaders: ['Authorization: Bearer abc'] });
    await conn.start();
    await conn.register();
    expect(registers[0]).toEqual({ expires: 120, extraHeaders: ['Authorization: Bearer abc'] });
    await conn.stop();
  });

  it('backs off, reconnects and re-registers after a drop', async () => {
    const { conn, listener } = setup();
    await conn.start();
    await conn.register();
    expect(listener.onRegistration).toHaveBeenLastCalledWith({ state: 'registered' });
    failing.add('wss://a.test/ws');
    failing.add('wss://b.test/ws');
    created[0]!.delegate?.onDisconnect?.(new Error('socket closed'));
    expect(listener.onTransportState).toHaveBeenCalledWith('disconnected', 'socket closed');
    await vi.advanceTimersByTimeAsync(1000); // round 1 fails
    expect(conn.isConnected()).toBe(false);
    failing.clear();
    await vi.advanceTimersByTimeAsync(2000); // round 2 (2s backoff) succeeds
    expect(conn.isConnected()).toBe(true);
    expect(registers).toHaveLength(2);
    await conn.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after reconnectionAttempts rounds', async () => {
    failing.add('wss://a.test/ws');
    failing.add('wss://b.test/ws');
    const { conn, listener } = setup({ reconnectionAttempts: 1 });
    await conn.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listener.onRegistration).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'failed', reason: expect.stringMatching(/after 1 attempts/) }),
    );
    expect(vi.getTimerCount()).toBe(0);
    await conn.stop();
  });

  it('defers REGISTER until connected', async () => {
    failing.add('wss://a.test/ws');
    failing.add('wss://b.test/ws');
    const { conn } = setup();
    await conn.start();
    await conn.register();
    expect(registers).toHaveLength(0);
    failing.clear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(registers).toHaveLength(1);
    await conn.stop();
  });
});
