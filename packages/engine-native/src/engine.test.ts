import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig, type Logger, type ResolvedConfig } from 'sipkit-core';
import { RecordingListener, runEngineContract } from 'sipkit-core/testing';
import { accountFromConfig, NativeSipEngine, nativeSipEngine, targetUri } from './engine';
import { FakeSidecarNetwork } from './fake-sidecar';
import { NativeSipError, type NativeMessage, type NativeRequest } from './protocol';
import { createMemoryTransportPair, type NativeSipTransport } from './transport';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

function config(overrides: Parameters<typeof resolveConfig>[0] = {}): ResolvedConfig {
  return resolveConfig({
    username: '2001',
    password: 'secret',
    transportMode: 'native',
    sipServer: 'pbx.test:5060',
    ...overrides,
  });
}

// The shared V1-TEST-02 contract, against NativeSipEngine over in-memory fake sidecars.
// (The same suite runs against real baresip + Asterisk in native.contract.test.ts.)
{
  const network = new FakeSidecarNetwork();
  network.addAccount('2001', 'secret');
  network.addAccount('2002', 'secret');
  const users = { a: '2001', b: '2002' } as const;
  runEngineContract(
    { describe, it, afterEach },
    {
      name: 'NativeSipEngine over fake sidecars',
      createParty: (role, overrides) => ({
        engine: new NativeSipEngine({ transport: () => network.connect() }),
        config: config({ username: users[role], password: overrides?.password ?? 'secret' }),
      }),
      address: (role) => users[role],
      transferTarget: '600',
      dtmfDigits: '12#*90',
      capabilities: { mediaStreams: false, remoteHoldSignalling: true, registrationFailure: true },
      timeoutMs: 1000,
    },
  );
}

/** A scripted sidecar: records requests, answers via `reply`, emits events on demand. */
function scriptedSidecar(
  reply: (
    req: NativeRequest,
  ) => { ok: true; result?: unknown } | { ok: false; code?: string; message: string } = () => ({
    ok: true,
  }),
) {
  const [engineSide, sidecarSide] = createMemoryTransportPair();
  const requests: NativeRequest[] = [];
  sidecarSide.onMessage((message: NativeMessage) => {
    if (message.type !== 'request') return;
    requests.push(message);
    const r =
      message.cmd === 'hello'
        ? {
            ok: true as const,
            result: {
              protocol: 1,
              sidecar: 'scripted',
              capabilities: { attendedTransfer: false, extraHeaders: true, tls: true },
            },
          }
        : reply(message);
    if (r.ok) sidecarSide.send({ type: 'response', id: message.id, ok: true, result: r.result });
    else
      sidecarSide.send({
        type: 'response',
        id: message.id,
        ok: false,
        error: { code: (r.code ?? 'failed') as 'failed', message: r.message },
      });
  });
  return {
    engineSide,
    sidecarSide,
    requests,
    emit: (event: Record<string, unknown>) =>
      sidecarSide.send({ type: 'event', ...event } as NativeMessage),
  };
}

async function started(transport: NativeSipTransport | (() => NativeSipTransport), cfg = config()) {
  const engine = new NativeSipEngine({ transport, requestTimeoutMs: 500 });
  const listener = new RecordingListener('engine', 1000);
  await engine.start({ config: cfg, listener, logger });
  return { engine, listener };
}

describe('NativeSipEngine', () => {
  it('handshakes (hello, start with the account from config) and exposes the sidecar info', async () => {
    const side = scriptedSidecar();
    const { engine, listener } = await started(
      side.engineSide,
      config({ displayName: 'Desk', authUsername: 'auth2001', sipTransport: 'tls' }),
    );
    expect(side.requests.map((r) => r.cmd)).toEqual(['hello', 'start']);
    expect(side.requests[1]).toMatchObject({
      cmd: 'start',
      account: {
        username: '2001',
        authUsername: 'auth2001',
        password: 'secret',
        displayName: 'Desk',
        domain: 'pbx.test',
        server: 'pbx.test:5060',
        transport: 'tls',
        registerExpires: 300,
        dtmfMode: 'auto',
      },
    });
    expect(engine.sidecar?.sidecar).toBe('scripted');
    expect(listener.of('transport')[0]).toMatchObject({ state: 'connecting' });
  });

  it('refuses a sidecar speaking another protocol version', async () => {
    const [engineSide, sidecarSide] = createMemoryTransportPair();
    sidecarSide.onMessage((m) => {
      if (m.type === 'request')
        sidecarSide.send({
          type: 'response',
          id: m.id,
          ok: true,
          result: { protocol: 99, sidecar: 'x', capabilities: {} },
        });
    });
    const engine = new NativeSipEngine({ transport: engineSide });
    const listener = new RecordingListener();
    await expect(engine.start({ config: config(), listener, logger })).rejects.toThrow(
      /protocol 99/,
    );
    expect(listener.of('transport').at(-1)).toMatchObject({ state: 'disconnected' });
  });

  it('maps sidecar events to the listener', async () => {
    const side = scriptedSidecar();
    const { listener } = await started(side.engineSide);
    side.emit({ event: 'transport', state: 'connected' });
    side.emit({ event: 'registration', state: 'failed', code: 403, reason: '403 Forbidden' });
    side.emit({
      event: 'incoming',
      callId: 'in-1',
      remoteNumber: '2002',
      remoteDisplayName: 'Desk 2002',
      sipCallId: 'abc',
    });
    side.emit({ event: 'ringing', callId: 'out-1' });
    side.emit({ event: 'early-media', callId: 'out-1' });
    side.emit({ event: 'connected', callId: 'in-1', sipCallId: 'abc' });
    side.emit({ event: 'remote-hold', callId: 'in-1', held: true });
    side.emit({ event: 'dtmf', callId: 'in-1', digit: '5' });
    side.emit({ event: 'ended', callId: 'in-1', reason: 'busy', code: 486 });
    side.emit({ event: 'bogus', callId: 'in-1' }); // dropped by validation
    await listener.waitFor('ended');
    expect(listener.events.slice(1)).toEqual([
      { kind: 'transport', state: 'connected', reason: undefined },
      { kind: 'registration', status: { state: 'failed', code: 403, reason: '403 Forbidden' } },
      {
        kind: 'incoming',
        id: 'in-1',
        info: { remoteNumber: '2002', remoteDisplayName: 'Desk 2002', sipCallId: 'abc' },
      },
      { kind: 'ringing', id: 'out-1' },
      { kind: 'early-media', id: 'out-1' },
      { kind: 'connected', id: 'in-1', sipCallId: 'abc' },
      { kind: 'remote-hold', id: 'in-1', held: true },
      { kind: 'dtmf', id: 'in-1', digit: '5' },
      { kind: 'ended', id: 'in-1', reason: 'busy', code: 486 },
    ]);
  });

  it('sends call commands with SIP URIs built from the domain', async () => {
    const side = scriptedSidecar();
    const { engine } = await started(side.engineSide);
    await engine.call('c1', '2002', { extraHeaders: ['X-Agent: 42'] });
    await engine.setHold('c1', true);
    engine.setMuted('c1', true);
    engine.setMuted('c1', true); // deduplicated
    await engine.sendDtmf('c1', '12');
    await engine.blindTransfer('c1', '600');
    await engine.reject('c1');
    await engine.hangup('c1');
    await new Promise((r) => setTimeout(r, 10));
    expect(side.requests.slice(2)).toEqual([
      expect.objectContaining({
        cmd: 'call',
        callId: 'c1',
        target: 'sip:2002@pbx.test',
        headers: ['X-Agent: 42'],
      }),
      expect.objectContaining({ cmd: 'hold', callId: 'c1', hold: true }),
      expect.objectContaining({ cmd: 'mute', callId: 'c1', muted: true }),
      expect.objectContaining({ cmd: 'dtmf', callId: 'c1', tones: '12' }),
      expect.objectContaining({ cmd: 'transfer', callId: 'c1', target: 'sip:600@pbx.test' }),
      expect.objectContaining({ cmd: 'reject', callId: 'c1', code: 486 }),
      expect.objectContaining({ cmd: 'hangup', callId: 'c1' }),
    ]);
  });

  it('ignores hangup / mute for unknown calls and returns no media streams', async () => {
    const side = scriptedSidecar();
    const { engine } = await started(side.engineSide);
    await engine.hangup('nope');
    engine.setMuted('nope', true);
    expect(engine.getMediaStreams()).toEqual({});
    expect(side.requests.map((r) => r.cmd)).toEqual(['hello', 'start']);
  });

  it('rejects with NativeSipError carrying the sidecar error code', async () => {
    const side = scriptedSidecar((req) =>
      req.cmd === 'answer'
        ? { ok: false, code: 'unknown-call', message: 'Unknown call x' }
        : { ok: true },
    );
    const { engine } = await started(side.engineSide);
    const error = await engine.answer('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NativeSipError);
    expect(error).toMatchObject({ code: 'unknown-call', message: 'Unknown call x' });
  });

  it('marks attended transfer unsupported when the sidecar does not announce it', async () => {
    const side = scriptedSidecar();
    const { engine } = await started(side.engineSide);
    await expect(engine.attendedTransfer('a', 'b')).rejects.toMatchObject({ code: 'unsupported' });
    expect(side.requests.some((r) => r.cmd === 'attendedTransfer')).toBe(false);
  });

  it('times out requests the sidecar never answers', async () => {
    const [silentEngineSide] = createMemoryTransportPair(); // nobody answers on the other end
    const silent = new NativeSipEngine({ transport: silentEngineSide, requestTimeoutMs: 50 });
    await expect(
      silent.start({ config: config(), listener: new RecordingListener(), logger }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('reports a dead sidecar: transport disconnected, registration failed, live calls ended', async () => {
    const side = scriptedSidecar();
    const { engine, listener } = await started(side.engineSide);
    await engine.call('c1', '2002');
    side.emit({ event: 'incoming', callId: 'in-1', remoteNumber: '2002' });
    await listener.waitFor('incoming');
    side.sidecarSide.close();
    await listener.waitFor('ended', (e) => e.id === 'in-1');
    expect(listener.of('transport').at(-1)).toMatchObject({ state: 'disconnected' });
    expect(listener.of('registration').at(-1)?.status.state).toBe('failed');
    expect(
      listener
        .of('ended')
        .map((e) => [e.id, e.reason])
        .sort(),
    ).toEqual([
      ['c1', 'failed'],
      ['in-1', 'failed'],
    ]);
    await expect(engine.register()).rejects.toMatchObject({ code: 'not-started' });
  });

  it('restarts through a transport factory; a plain transport can only start once', async () => {
    const network = new FakeSidecarNetwork();
    network.addAccount('2001', 'secret');
    let opened = 0;
    const factory = nativeSipEngine({ transport: () => (opened++, network.connect()) });
    const engine = factory();
    await engine.start({ config: config(), listener: new RecordingListener(), logger });
    await engine.stop();
    await engine.start({ config: config(), listener: new RecordingListener(), logger });
    expect(opened).toBe(2);
    await engine.stop();

    const once = new NativeSipEngine({ transport: network.connect() });
    await once.start({ config: config(), listener: new RecordingListener(), logger });
    await once.stop();
    await expect(
      once.start({ config: config(), listener: new RecordingListener(), logger }),
    ).rejects.toMatchObject({ code: 'transport' });
  });
});

describe('config helpers', () => {
  it('accountFromConfig falls back to the domain and requires a server', () => {
    expect(accountFromConfig(resolveConfig({ username: '1', domain: 'pbx.test' }))).toMatchObject({
      server: 'pbx.test',
      domain: 'pbx.test',
    });
    expect(accountFromConfig(config({ sipServer: '[::1]:5070', domain: '' }))).toMatchObject({
      domain: '[::1]',
    });
    expect(() => accountFromConfig(resolveConfig({ username: '1' }))).toThrow(/sipServer/);
  });

  it('targetUri keeps SIP URIs and qualifies bare users', () => {
    expect(targetUri('2002', 'pbx.test')).toBe('sip:2002@pbx.test');
    expect(targetUri('2002@other.test', 'pbx.test')).toBe('sip:2002@other.test');
    expect(targetUri('sips:2002@pbx.test;transport=tls', 'x')).toBe(
      'sips:2002@pbx.test;transport=tls',
    );
  });
});
