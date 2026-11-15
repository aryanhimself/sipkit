import { describe, expect, it } from 'vitest';
import { createMemoryStorage, createSoftphone, type SoftphoneSnapshot } from 'sipkit-core';
import { nativeSipEngine } from './engine';
import { FakeSidecarNetwork } from './fake-sidecar';

function until(
  sp: { getSnapshot(): SoftphoneSnapshot },
  predicate: (s: SoftphoneSnapshot) => boolean,
  timeoutMs = 2000,
) {
  return new Promise<SoftphoneSnapshot>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const snapshot = sp.getSnapshot();
      if (predicate(snapshot)) return resolve(snapshot);
      if (Date.now() > deadline)
        return reject(new Error(`timed out; snapshot: ${JSON.stringify(snapshot.calls)}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe('Softphone orchestrator on the native engine', () => {
  it('registers with transportMode native (no WebSocket URL) and runs a call end to end', async () => {
    const network = new FakeSidecarNetwork();
    network.addAccount('2001', 'pw');
    network.addAccount('2002', 'pw');
    const make = (username: string) =>
      createSoftphone({
        config: {
          username,
          password: 'pw',
          transportMode: 'native',
          sipServer: 'pbx.test:5060',
          logLevel: 'silent',
        },
        engine: nativeSipEngine({ transport: () => network.connect() }),
        storage: createMemoryStorage(),
        mediaDevices: null,
        console: false,
        createMixer: () => undefined,
      });
    const a = make('2001');
    const b = make('2002');
    await a.start();
    await b.start();
    await until(a, (s) => s.registration.state === 'registered');
    await until(b, (s) => s.registration.state === 'registered');

    const call = await a.call('2002');
    const ringing = await until(b, (s) =>
      s.calls.some((c) => c.direction === 'incoming' && c.state === 'ringing'),
    );
    expect(ringing.calls[0]?.remoteNumber).toBe('2001');
    await b.answer();
    await until(a, (s) => s.calls.find((c) => c.id === call.id)?.state === 'connected');
    await a.sendDtmf('42');
    await a.hold(true);
    await until(a, (s) => s.calls[0]?.state === 'held');
    await a.hold(false);
    await a.hangup();
    await until(b, (s) => s.calls.length === 0);
    await until(a, (s) => s.calls.length === 0);
    const sent = network.requests.filter((r) => r.cmd === 'dtmf');
    expect(sent.map((r) => (r as { tones: string }).tones).join('')).toBe('42');
    await a.stop();
    await b.stop();
  });
});
