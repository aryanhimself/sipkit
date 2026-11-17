import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestSoftphone } from '../testing';
import type { CallQuality, Cdr } from '../types';
import { flush } from '../__tests__/helpers';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

async function connectedCall(config = {}) {
  const ctx = await createTestSoftphone({ config });
  const call = await ctx.softphone.call('1002');
  ctx.engine.simulateNetwork(call.id, 'good');
  ctx.engine.simulateRemoteAnswer(call.id);
  const samples: CallQuality[] = [];
  ctx.softphone.on('call:quality', ({ callId, quality }) => {
    if (callId === call.id) samples.push(quality);
  });
  return { ...ctx, call, samples };
}

describe('QualityMonitor', () => {
  it('samples every callQualityInterval while connected and exposes call.quality', async () => {
    const { softphone, call, samples } = await connectedCall();
    await tick(1999);
    expect(samples).toHaveLength(0);
    await tick(1);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ level: 'good', codec: 'opus', rttMs: 40 });
    expect(softphone.getCall(call.id)?.quality).toEqual(samples[0]);
    await tick(4000);
    expect(samples).toHaveLength(3);
  });

  it('degrades to poor under simulated loss and recovers with hysteresis', async () => {
    const { softphone, engine, call, samples } = await connectedCall();
    await tick(2000);
    expect(samples.at(-1)?.level).toBe('good');
    engine.simulateNetwork(call.id, 'poor');
    await tick(2000);
    expect(samples.at(-1)?.level).toBe('poor');
    expect(samples.at(-1)?.inbound.packetLossPct).toBe(15);
    expect(softphone.getCall(call.id)?.quality?.level).toBe('poor');
    engine.simulateNetwork(call.id, 'good');
    await tick(2000);
    expect(samples.at(-1)?.level).toBe('poor');
    await tick(2000);
    expect(samples.at(-1)?.level).toBe('good');
  });

  it('warns once when a connected call carries no audio', async () => {
    const { softphone, engine, call, samples } = await connectedCall();
    const notes: string[] = [];
    softphone.on('notification', (n) => notes.push(String(n.code)));
    engine.simulateNetwork(call.id, { lossPct: 100, rttMs: 40, jitterMs: 2 });
    await tick(2000);
    expect(samples.at(-1)).toMatchObject({ noAudio: 'receive', level: 'poor', mos: 1 });
    await tick(4000);
    expect(notes.filter((c) => c === 'callNoAudio')).toHaveLength(1);
  });

  it('attaches an end-of-call summary to the CDR', async () => {
    const { softphone, engine, call } = await connectedCall();
    const cdrs: Cdr[] = [];
    softphone.on('cdr', (c) => cdrs.push(c));
    await tick(2000);
    engine.simulateNetwork(call.id, 'poor');
    await tick(2000);
    await softphone.hangup(call.id);
    expect(cdrs).toHaveLength(1);
    expect(cdrs[0]?.quality).toMatchObject({
      samples: 2,
      maxLossPct: 15,
      maxRttMs: 400,
      worstLevel: 'poor',
      codec: 'opus',
    });
    expect(cdrs[0]?.quality?.minMos).toBeLessThan(3.6);
  });

  it('leaves the CDR without quality when nothing was sampled', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const cdr = vi.fn();
    softphone.on('cdr', cdr);
    const call = await softphone.call('1002');
    engine.simulateRemoteAnswer(call.id); // no stats configured
    await tick(6000);
    expect(softphone.getCall(call.id)?.quality).toBeUndefined();
    await softphone.hangup(call.id);
    expect(cdr.mock.calls[0]?.[0]).not.toHaveProperty('quality');
  });

  it('is off when callQualityInterval is 0', async () => {
    const { samples } = await connectedCall({ callQualityInterval: 0 });
    await tick(10_000);
    expect(samples).toHaveLength(0);
  });

  it('pauses on hold and re-baselines on resume', async () => {
    const { softphone, engine, call, samples } = await connectedCall();
    await tick(2000);
    expect(samples).toHaveLength(1);
    await softphone.hold(true, call.id);
    await tick(10_000);
    expect(samples).toHaveLength(1);
    engine.simulateNetwork(call.id, 'poor'); // loss while held must not count after resume…
    await softphone.hold(false, call.id);
    engine.simulateNetwork(call.id, 'good');
    await flush();
    await tick(2000);
    expect(samples).toHaveLength(2);
    expect(samples[1]?.inbound.packetLossPct).toBe(0);
    expect(samples[1]?.inbound.bitrateKbps).toBe(80);
  });

  it('stops sampling when the call ends and survives getCallStats failures', async () => {
    const { softphone, engine, call, samples } = await connectedCall();
    engine.failNext('getCallStats');
    await tick(2000);
    expect(samples).toHaveLength(0);
    await tick(2000);
    expect(samples).toHaveLength(1);
    engine.simulateRemoteHangup(call.id);
    await tick(10_000);
    expect(samples).toHaveLength(1);
    expect(softphone.getSnapshot().calls).toEqual([]);
  });

  it('ignores a late stats result after the call ended', async () => {
    const { softphone, engine, call, samples } = await connectedCall();
    let release: (v: undefined) => void = () => undefined;
    engine.getCallStats = () => new Promise((r) => (release = r));
    await tick(2000);
    await softphone.hangup(call.id);
    release(undefined);
    await flush();
    expect(samples).toHaveLength(0);
  });
});
