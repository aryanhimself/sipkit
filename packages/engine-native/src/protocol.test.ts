import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  asNativeMessage,
  encodeNativeMessage,
  parseNativeMessage,
  type NativeMessage,
} from './protocol';
import { createBridgeTransport, createMemoryTransportPair } from './transport';
import { JsonLinesTransport } from './node/json-lines';
import { encodeNetstring, NetstringDecoder } from './node/netstring';

describe('protocol messages', () => {
  it('round-trips requests, responses and events through JSON lines', () => {
    const messages: NativeMessage[] = [
      { type: 'request', id: 1, cmd: 'call', callId: 'c1', target: 'sip:2002@pbx' },
      { type: 'response', id: 1, ok: true },
      { type: 'response', id: 2, ok: false, error: { code: 'unknown-call', message: 'nope' } },
      { type: 'event', event: 'ended', callId: 'c1', reason: 'busy', code: 486 },
    ];
    for (const message of messages) {
      const line = encodeNativeMessage(message);
      expect(line.endsWith('\n')).toBe(true);
      expect(parseNativeMessage(line)).toEqual(message);
    }
  });

  it('rejects malformed or unknown messages', () => {
    expect(parseNativeMessage('not json')).toBeUndefined();
    expect(parseNativeMessage('')).toBeUndefined();
    expect(asNativeMessage(null)).toBeUndefined();
    expect(asNativeMessage([])).toBeUndefined();
    expect(asNativeMessage({ type: 'request', id: 1, cmd: 'rm -rf' })).toBeUndefined();
    expect(asNativeMessage({ type: 'request', id: '1', cmd: 'stop' })).toBeUndefined();
    expect(asNativeMessage({ type: 'request', id: 1, cmd: 'hangup', callId: 5 })).toBeUndefined();
    expect(asNativeMessage({ type: 'response', id: 1, ok: false })).toBeUndefined();
    expect(asNativeMessage({ type: 'event', event: 'nope' })).toBeUndefined();
    expect(asNativeMessage({ type: 'event', event: 'dtmf', callId: {} })).toBeUndefined();
    expect(asNativeMessage({ type: 'other' })).toBeUndefined();
  });
});

describe('transports', () => {
  it('memory pair delivers asynchronously, clones, and propagates close', async () => {
    const [a, b] = createMemoryTransportPair();
    const got: NativeMessage[] = [];
    b.onMessage((m) => got.push(m));
    const message: NativeMessage = { type: 'event', event: 'ringing', callId: 'c1' };
    a.send(message);
    expect(got).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toEqual([message]);
    expect(got[0]).not.toBe(message);
    const closed = new Promise<string | undefined>((resolve) => b.onClose(resolve));
    a.close();
    expect(await closed).toBe('peer closed');
    a.send(message); // dropped, no throw
  });

  it('bridge transport validates incoming values and forwards close', () => {
    let deliver: (value: unknown) => void = () => undefined;
    let closeBridge: (reason?: string) => void = () => undefined;
    const sent: unknown[] = [];
    const transport = createBridgeTransport({
      send: (m) => sent.push(m),
      onMessage: (cb) => ((deliver = cb), () => (deliver = () => undefined)),
      onClose: (cb) => ((closeBridge = cb), () => undefined),
    });
    const got: NativeMessage[] = [];
    let closedWith: string | undefined;
    transport.onMessage((m) => got.push(m));
    transport.onClose((r) => (closedWith = r));
    deliver({ type: 'event', event: 'dtmf', callId: 'c', digit: '1' });
    deliver({ type: 'event', event: 'evil' });
    deliver('garbage');
    expect(got).toHaveLength(1);
    transport.send({ type: 'request', id: 1, cmd: 'stop' });
    expect(sent).toEqual([{ type: 'request', id: 1, cmd: 'stop' }]);
    closeBridge('main process gone');
    expect(closedWith).toBe('main process gone');
    transport.send({ type: 'request', id: 2, cmd: 'stop' });
    expect(sent).toHaveLength(1);
  });

  it('JSON-lines transport frames over streams, tolerating split chunks and junk lines', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new JsonLinesTransport(input, output);
    const got: NativeMessage[] = [];
    transport.onMessage((m) => got.push(m));
    input.write('{"type":"event","event":"ring');
    input.write(
      'ing","callId":"c1"}\nhello from a log line\n{"type":"response","id":3,"ok":true}\n',
    );
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual([
      { type: 'event', event: 'ringing', callId: 'c1' },
      { type: 'response', id: 3, ok: true },
    ]);
    transport.send({ type: 'request', id: 1, cmd: 'register' });
    expect(output.read()?.toString()).toBe('{"type":"request","id":1,"cmd":"register"}\n');
    const closed = new Promise((resolve) => transport.onClose(resolve));
    input.end();
    await closed;
  });
});

describe('netstring', () => {
  it('encodes and incrementally decodes (multi-byte safe)', () => {
    const decoder = new NetstringDecoder();
    const frame = Buffer.concat([encodeNetstring('{"a":"नमस्ते"}'), encodeNetstring('x')]);
    expect(decoder.push(frame.subarray(0, 5))).toEqual([]);
    expect(decoder.push(frame.subarray(5))).toEqual(['{"a":"नमस्ते"}', 'x']);
  });

  it('throws on malformed frames', () => {
    expect(() => new NetstringDecoder().push(Buffer.from('abc:x,'))).toThrow(/bad length/);
    expect(() => new NetstringDecoder().push(Buffer.from('1:xy'))).toThrow(/comma/);
    expect(() => new NetstringDecoder().push(Buffer.from('12345678901'))).toThrow(/length prefix/);
  });
});
