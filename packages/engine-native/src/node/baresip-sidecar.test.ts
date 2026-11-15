import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeSipClient } from '../client';
import type { NativeAccount, NativeEvent } from '../protocol';
import { createMemoryTransportPair } from '../transport';
import {
  BaresipSidecar,
  baresipAccountLine,
  reasonFromSipCode,
  userOfUri,
} from './baresip-sidecar';
import { encodeNetstring, NetstringDecoder } from './netstring';

type Reply = { ok: boolean; data?: string };

/** A fake baresip ctrl_tcp: records commands, answers via `onCommand`, emits events on demand. */
class FakeBaresip {
  readonly commands: string[] = [];
  onCommand: (command: string, params: string) => Reply | undefined = () => undefined;
  private server: Server = createServer((socket) => this.accept(socket));
  private sockets = new Set<Socket>();
  port = 0;

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  emit(event: Record<string, unknown>): void {
    const payload = encodeNetstring(JSON.stringify({ event: true, ...event }));
    for (const socket of this.sockets) socket.write(payload);
  }

  dropClients(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.dropClients();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    const decoder = new NetstringDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const payload of decoder.push(chunk)) {
        const { command, params, token } = JSON.parse(payload) as {
          command: string;
          params: string;
          token: string;
        };
        this.commands.push(params ? `${command} ${params}` : command);
        const reply = this.onCommand(command, params) ?? { ok: true, data: '' };
        socket.write(
          encodeNetstring(
            JSON.stringify({ response: true, ok: reply.ok, data: reply.data ?? '', token }),
          ),
        );
      }
    });
  }
}

const account: NativeAccount = {
  username: '2001',
  password: 'secret',
  domain: 'pbx.test',
  server: '10.0.0.5:5060',
  transport: 'udp',
  registerExpires: 300,
  dtmfMode: 'auto',
};

const AOR = 'sip:2001@pbx.test';

let fake: FakeBaresip;
let client: NativeSipClient;
let sidecar: BaresipSidecar;
let events: NativeEvent[];

async function setup(options: { dtmfIntervalMs?: number; transferTimeoutMs?: number } = {}) {
  fake = new FakeBaresip();
  await fake.listen();
  const [engineSide, sidecarSide] = createMemoryTransportPair();
  sidecar = new BaresipSidecar(sidecarSide, {
    host: '127.0.0.1',
    port: fake.port,
    dtmfIntervalMs: 1,
    unregisterTimeoutMs: 200,
    ...options,
  });
  client = new NativeSipClient(engineSide, 2000);
  events = [];
  client.onEvent((e) => events.push(e));
  await client.request({ cmd: 'start', account });
}

function waitEvent(predicate: (e: NativeEvent) => boolean, timeoutMs = 1000): Promise<NativeEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const hit = events.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() > deadline)
        return reject(new Error(`no matching event; got ${JSON.stringify(events)}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

const callEvent = (type: string, id: string, extra: Record<string, unknown> = {}) => ({
  class: 'call',
  type,
  id,
  accountaor: AOR,
  ...extra,
});

/** Place an outgoing call whose baresip id is `bid`; CALL_OUTGOING arrives before the dial response. */
async function dialOut(callId = 'c1', bid = 'bid-1') {
  fake.onCommand = (command) => {
    if (command !== 'dial') return undefined;
    fake.emit(
      callEvent('CALL_OUTGOING', bid, { direction: 'outgoing', peeruri: 'sip:2002@pbx.test' }),
    );
    fake.emit(callEvent('CALL_RINGING', bid, { direction: 'outgoing' }));
    return { ok: true, data: `call uri: sip:2002@pbx.test\ncall id: ${bid}\n` };
  };
  await client.request({ cmd: 'call', callId, target: 'sip:2002@pbx.test' });
}

function incoming(bid = 'in-bid') {
  fake.emit(
    callEvent('CALL_INCOMING', bid, {
      direction: 'incoming',
      peeruri: 'sip:2002@pbx.test;transport=udp',
      peerdisplayname: 'Desk 2002',
    }),
  );
  return waitEvent((e) => e.event === 'incoming').then((e) => (e as { callId: string }).callId);
}

afterEach(async () => {
  await sidecar?.dispose();
  client?.close();
  await fake?.close();
});

describe('BaresipSidecar', () => {
  it('start replaces any UA with the account and reports the transport', async () => {
    await setup();
    expect(fake.commands).toEqual(['uadelall', `uanew ${baresipAccountLine(account)}`]);
    expect(events).toEqual([
      { event: 'transport', state: 'connecting' },
      { event: 'transport', state: 'connected' },
    ]);
    const hello = await client.request({ cmd: 'hello', protocol: 1 });
    expect(hello).toMatchObject({
      protocol: 1,
      sidecar: 'baresip',
      capabilities: { attendedTransfer: false },
    });
  });

  it('fails start with a transport error when baresip is unreachable', async () => {
    const [engineSide, sidecarSide] = createMemoryTransportPair();
    sidecar = new BaresipSidecar(sidecarSide, {
      host: '127.0.0.1',
      port: 1,
      connectTimeoutMs: 100,
    });
    client = new NativeSipClient(engineSide, 2000);
    await expect(client.request({ cmd: 'start', account })).rejects.toMatchObject({
      code: 'transport',
    });
  });

  it('register / refresh / failure / unregister map to registration events', async () => {
    await setup();
    await client.request({ cmd: 'register' });
    expect(fake.commands.at(-1)).toBe('uareg 300 0');
    fake.emit({ class: 'ua', type: 'REGISTERING', accountaor: AOR });
    fake.emit({ class: 'ua', type: 'REGISTER_OK', accountaor: AOR, param: '200 OK' });
    fake.emit({ class: 'ua', type: 'REGISTER_OK', accountaor: AOR, param: '200 OK' }); // refresh
    fake.emit({ class: 'ua', type: 'REGISTER_OK', accountaor: 'sip:other@pbx.test' }); // other UA
    await waitEvent((e) => e.event === 'registration' && e.state === 'registered');
    await client.request({ cmd: 'unregister' });
    expect(fake.commands.at(-1)).toBe('uareg 0 0');
    fake.emit({ class: 'ua', type: 'UNREGISTERING', accountaor: AOR });
    fake.emit({ class: 'ua', type: 'REGISTER_OK', accountaor: AOR, param: '200 OK' });
    await waitEvent((e) => e.event === 'registration' && e.state === 'unregistered');
    await client.request({ cmd: 'register' });
    fake.emit({ class: 'ua', type: 'REGISTER_FAIL', accountaor: AOR, param: '403 Forbidden' });
    await waitEvent((e) => e.event === 'registration' && e.state === 'failed');
    expect(events.filter((e) => e.event === 'registration')).toEqual([
      { event: 'registration', state: 'registering' },
      { event: 'registration', state: 'registered' },
      { event: 'registration', state: 'unregistered' },
      { event: 'registration', state: 'failed', code: 403, reason: '403 Forbidden' },
    ]);
    // Unregister after a failure reports at once (nothing to un-REGISTER).
    await client.request({ cmd: 'unregister' });
    expect(events.at(-1)).toEqual({ event: 'registration', state: 'unregistered' });
  });

  it('reports unregistered after a timeout when baresip never confirms', async () => {
    await setup();
    await client.request({ cmd: 'register' });
    fake.emit({ class: 'ua', type: 'REGISTER_OK', accountaor: AOR });
    await waitEvent((e) => e.event === 'registration' && e.state === 'registered');
    await client.request({ cmd: 'unregister' });
    await waitEvent((e) => e.event === 'registration' && e.state === 'unregistered', 1000);
  });

  it('maps an outgoing call (events before the dial response are replayed) and a remote hangup', async () => {
    await setup();
    await dialOut('c1', 'bid-1');
    await waitEvent((e) => e.event === 'ringing');
    fake.emit(callEvent('CALL_ESTABLISHED', 'bid-1', { direction: 'outgoing' }));
    fake.emit(callEvent('CALL_HOLD', 'bid-1'));
    fake.emit(callEvent('CALL_RESUME', 'bid-1'));
    fake.emit(callEvent('CALL_DTMF_START', 'bid-1', { param: '7' }));
    fake.emit(callEvent('CALL_DTMF_END', 'bid-1'));
    fake.emit(callEvent('CALL_CLOSED', 'bid-1', { param: 'Connection reset by peer [104]' }));
    await waitEvent((e) => e.event === 'ended');
    expect(events.slice(2)).toEqual([
      { event: 'ringing', callId: 'c1' },
      { event: 'connected', callId: 'c1', sipCallId: 'bid-1' },
      { event: 'remote-hold', callId: 'c1', held: true },
      { event: 'remote-hold', callId: 'c1', held: false },
      { event: 'dtmf', callId: 'c1', digit: '7' },
      { event: 'ended', callId: 'c1', reason: 'remote-hangup' },
    ]);
  });

  it('classifies outgoing failures by SIP status and local cancel', async () => {
    await setup();
    await dialOut('c1', 'b1');
    fake.emit(callEvent('CALL_CLOSED', 'b1', { param: '486 Busy Here,Q.850;cause=17' }));
    expect(await waitEvent((e) => e.event === 'ended' && e.callId === 'c1')).toMatchObject({
      reason: 'busy',
      code: 486,
    });
    await dialOut('c2', 'b2');
    await client.request({ cmd: 'hangup', callId: 'c2' });
    expect(fake.commands.at(-1)).toBe('hangup b2');
    fake.emit(callEvent('CALL_CLOSED', 'b2', { param: 'Rejected by user' }));
    expect(await waitEvent((e) => e.event === 'ended' && e.callId === 'c2')).toEqual({
      event: 'ended',
      callId: 'c2',
      reason: 'cancelled',
    });
    await dialOut('c3', 'b3');
    fake.emit(callEvent('CALL_CLOSED', 'b3', { param: 'Connection timed out' }));
    expect(await waitEvent((e) => e.event === 'ended' && e.callId === 'c3')).toEqual({
      event: 'ended',
      callId: 'c3',
      reason: 'failed',
    });
  });

  it('adds extra headers around the dial and validates targets', async () => {
    await setup();
    fake.onCommand = (command) =>
      command === 'dial' ? { ok: true, data: 'call id: hb\n' } : undefined;
    await client.request({
      cmd: 'call',
      callId: 'c1',
      target: 'sip:2002@pbx.test',
      headers: ['X-Agent: 42 a'],
    });
    expect(fake.commands.slice(-3)).toEqual([
      'uaaddheader X-Agent=42%20a 0',
      'dial sip:2002@pbx.test',
      'uarmheader X-Agent 0',
    ]);
    await expect(
      client.request({ cmd: 'call', callId: 'c2', target: 'sip:x y' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      client.request({ cmd: 'call', callId: 'c3', target: 'sip:a@b', headers: ['bad header'] }),
    ).rejects.toMatchObject({ code: 'invalid' });
    fake.onCommand = (command) =>
      command === 'dial' ? { ok: false, data: 'could not dial\n' } : undefined;
    await expect(
      client.request({ cmd: 'call', callId: 'c4', target: 'sip:a@b' }),
    ).rejects.toMatchObject({ code: 'failed', message: 'baresip: could not dial' });
  });

  it('maps incoming calls: answer, reject with a status, remote cancel', async () => {
    await setup();
    const id = await incoming('in-1');
    expect(events.at(-1)).toEqual({
      event: 'incoming',
      callId: id,
      remoteNumber: '2002',
      remoteDisplayName: 'Desk 2002',
      sipCallId: 'in-1',
    });
    await client.request({ cmd: 'answer', callId: id });
    expect(fake.commands.at(-1)).toBe('accept in-1');
    fake.emit(callEvent('CALL_ESTABLISHED', 'in-1', { direction: 'incoming' }));
    await waitEvent((e) => e.event === 'connected');
    await client.request({ cmd: 'hangup', callId: id });
    fake.emit(callEvent('CALL_CLOSED', 'in-1', { param: 'Rejected by user' }));
    expect(await waitEvent((e) => e.event === 'ended')).toMatchObject({ reason: 'local-hangup' });

    events.length = 0;
    const id2 = await incoming('in-2');
    await client.request({ cmd: 'reject', callId: id2, code: 603 });
    expect(fake.commands.at(-1)).toBe('hangup in-2 scode=603');
    fake.emit(callEvent('CALL_CLOSED', 'in-2', { param: 'Rejected by user' }));
    expect(await waitEvent((e) => e.event === 'ended')).toEqual({
      event: 'ended',
      callId: id2,
      reason: 'rejected',
      code: 603,
    });

    events.length = 0;
    const id3 = await incoming('in-3');
    fake.emit(callEvent('CALL_CLOSED', 'in-3', { param: 'Connection reset by peer [104]' }));
    expect(await waitEvent((e) => e.event === 'ended')).toEqual({
      event: 'ended',
      callId: id3,
      reason: 'cancelled',
    });
    await expect(client.request({ cmd: 'answer', callId: id3 })).rejects.toMatchObject({
      code: 'unknown-call',
    });
  });

  it('selects the call before hold / mute / DTMF and sends digits one by one', async () => {
    await setup();
    await dialOut('c1', 'b1');
    fake.emit(callEvent('CALL_ESTABLISHED', 'b1'));
    await waitEvent((e) => e.event === 'connected');
    fake.commands.length = 0;
    await client.request({ cmd: 'hold', callId: 'c1', hold: true });
    await client.request({ cmd: 'hold', callId: 'c1', hold: false });
    await client.request({ cmd: 'mute', callId: 'c1', muted: true });
    await client.request({ cmd: 'dtmf', callId: 'c1', tones: '1#' });
    expect(fake.commands).toEqual([
      'hold b1',
      'resume b1',
      'callfind b1',
      'mute yes',
      'callfind b1',
      'sndcode 1',
      'callfind b1',
      'sndcode #',
    ]);
    await expect(client.request({ cmd: 'dtmf', callId: 'c1', tones: '1x' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      client.request({ cmd: 'attendedTransfer', callId: 'c1', toCallId: 'c2' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('blind transfer resolves when the call closes and reports transferred', async () => {
    await setup();
    await dialOut('c1', 'b1');
    fake.emit(callEvent('CALL_ESTABLISHED', 'b1'));
    await waitEvent((e) => e.event === 'connected');
    const transfer = client.request({ cmd: 'transfer', callId: 'c1', target: 'sip:600@pbx.test' });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.commands.slice(-2)).toEqual(['callfind b1', 'transfer sip:600@pbx.test']);
    fake.emit(callEvent('CALL_CLOSED', 'b1', { param: 'Call transfered' }));
    await transfer;
    expect(await waitEvent((e) => e.event === 'ended')).toEqual({
      event: 'ended',
      callId: 'c1',
      reason: 'transferred',
    });
  });

  it('a failed blind transfer rejects and resumes the call', async () => {
    await setup();
    await dialOut('c1', 'b1');
    fake.emit(callEvent('CALL_ESTABLISHED', 'b1'));
    await waitEvent((e) => e.event === 'connected');
    const transfer = client.request({ cmd: 'transfer', callId: 'c1', target: 'sip:999@pbx.test' });
    await new Promise((r) => setTimeout(r, 30));
    fake.emit(callEvent('CALL_TRANSFER_FAILED', 'b1', { param: '404 Not Found' }));
    await expect(transfer).rejects.toMatchObject({
      code: 'failed',
      message: 'Transfer failed: 404 Not Found',
    });
    expect(fake.commands.at(-1)).toBe('resume b1');
  });

  it('losing baresip ends calls and reports the transport down', async () => {
    await setup();
    await dialOut('c1', 'b1');
    fake.dropClients();
    await waitEvent((e) => e.event === 'transport' && e.state === 'disconnected');
    expect(events).toContainEqual({ event: 'ended', callId: 'c1', reason: 'failed' });
    expect(events.at(-1)).toMatchObject({ event: 'registration', state: 'failed' });
    await expect(client.request({ cmd: 'register' })).rejects.toMatchObject({
      code: 'not-started',
    });
  });

  it('stop drops the UA and closes the control connection; commands then fail', async () => {
    await setup();
    await client.request({ cmd: 'stop' });
    expect(fake.commands.at(-1)).toBe('uadelall');
    await expect(client.request({ cmd: 'register' })).rejects.toMatchObject({
      code: 'not-started',
    });
  });
});

describe('baresip helpers', () => {
  it('builds the account line', () => {
    expect(baresipAccountLine(account)).toBe(
      '<sip:2001@pbx.test;transport=udp>;auth_pass=secret;outbound="sip:10.0.0.5:5060;transport=udp";answermode=manual;regint=0',
    );
    expect(
      baresipAccountLine({
        ...account,
        displayName: 'Desk 1',
        authUsername: 'a1',
        transport: 'tls',
        outboundProxy: 'proxy.test:5061',
        dtmfMode: 'info',
      }),
    ).toBe(
      '"Desk 1" <sip:2001@pbx.test;transport=tls>;auth_user=a1;auth_pass=secret;outbound="sip:proxy.test:5061;transport=tls";dtmfmode=info;answermode=manual;regint=0',
    );
  });

  it('rejects values that would break the account line', () => {
    expect(() => baresipAccountLine({ ...account, password: 'a;b' })).toThrow(/password/);
    expect(() => baresipAccountLine({ ...account, username: 'a b' })).toThrow(/username/);
    expect(() => baresipAccountLine({ ...account, displayName: 'x"y' })).toThrow(/displayName/);
    expect(() => baresipAccountLine({ ...account, domain: '' })).toThrow(/domain/);
    expect(() => baresipAccountLine({ ...account, transport: 'ws' as 'udp' })).toThrow(/transport/);
  });

  it('parses users and SIP codes', () => {
    expect(userOfUri('sip:2002@pbx;transport=udp')).toBe('2002');
    expect(userOfUri('<sips:alice@x>')).toBe('alice');
    expect(userOfUri('sip:pbx.test')).toBe('pbx.test');
    expect(userOfUri(undefined)).toBe('');
    expect([486, 600, 603, 408, 480, 487, 500].map(reasonFromSipCode)).toEqual([
      'busy',
      'busy',
      'rejected',
      'no-answer',
      'no-answer',
      'cancelled',
      'failed',
    ]);
  });
});
