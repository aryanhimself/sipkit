import { describe, expect, it } from 'vitest';
import type { EngineCallStats } from '../types';
import {
  QualityLevelFilter,
  QualitySummaryBuilder,
  QualityTracker,
  estimateMos,
  levelForMos,
  mosFromR,
  mosToQualityScore,
  rFactor,
} from './quality';
import { NETWORK_PRESETS, SyntheticCallStats } from './synthetic';

describe('E-model math', () => {
  it('converts R to MOS with the G.107 formula (known values)', () => {
    expect(mosFromR(93.2)).toBeCloseTo(4.41, 2);
    expect(mosFromR(80)).toBeCloseTo(4.02, 2);
    expect(mosFromR(70)).toBeCloseTo(3.6, 2);
    expect(mosFromR(50)).toBeCloseTo(2.58, 2);
    expect(mosFromR(0)).toBe(1);
    expect(mosFromR(-5)).toBe(1);
    expect(mosFromR(3)).toBe(1); // formula dips below 1 for tiny R: clamped
    expect(mosFromR(120)).toBe(4.5);
  });

  it('computes R from delay and loss', () => {
    // Perfect network: only the 10 ms packetisation delay → Id = 0.24.
    expect(rFactor({})).toBeCloseTo(92.96, 2);
    // 2% loss on G.711: Ie,eff = 95·2/(2+25.1) = 7.01
    expect(rFactor({ lossPct: 2, codec: 'PCMU' })).toBeCloseTo(92.96 - 7.011, 2);
    // Large delay crosses the 177.3 ms knee: d = 300/2 + 2·20 + 10 = 200
    expect(rFactor({ rttMs: 300, jitterMs: 20 })).toBeCloseTo(93.2 - (0.024 * 200 + 0.11 * 22.7), 2);
    // G.729 has a base impairment.
    expect(rFactor({ codec: 'g729' })).toBeCloseTo(92.96 - 11, 2);
    // Garbage in is clamped rather than producing NaN / > 100% loss.
    expect(rFactor({ lossPct: 500, rttMs: -10 })).toBeGreaterThanOrEqual(0);
  });

  it('maps MOS to levels and a 0..5 quality score', () => {
    expect(estimateMos({})).toBeCloseTo(4.40, 2);
    expect(levelForMos(4.4)).toBe('good');
    expect(levelForMos(4.0)).toBe('good');
    expect(levelForMos(3.8)).toBe('fair');
    expect(levelForMos(3.59)).toBe('poor');
    expect(mosToQualityScore(4.41)).toBe(5);
    expect(mosToQualityScore(1)).toBe(0);
    expect(mosToQualityScore(2.75)).toBe(3);
  });

  it('network presets land in their levels', () => {
    for (const level of ['good', 'fair', 'poor'] as const) {
      const p = NETWORK_PRESETS[level];
      expect(levelForMos(estimateMos({ lossPct: p.lossPct, jitterMs: p.jitterMs, rttMs: p.rttMs }))).toBe(level);
    }
  });
});

describe('QualityLevelFilter (hysteresis)', () => {
  it('degrades immediately and recovers after consecutive good samples', () => {
    const f = new QualityLevelFilter({ recoverSamples: 2, margin: 0.1 });
    expect(f.push(4.4)).toBe('good');
    expect(f.push(2.0)).toBe('poor');
    expect(f.push(4.4)).toBe('poor'); // 1 of 2
    expect(f.push(4.4)).toBe('good');
  });

  it('does not flicker around a threshold', () => {
    const f = new QualityLevelFilter({ recoverSamples: 2, margin: 0.1 });
    expect(f.push(3.95)).toBe('fair');
    // 4.05 is above 4.0 but not by the 0.1 margin: stays fair.
    for (let i = 0; i < 5; i++) expect(f.push(i % 2 ? 3.95 : 4.05)).toBe('fair');
    // An interrupted streak resets.
    expect(f.push(4.3)).toBe('fair');
    expect(f.push(3.9)).toBe('fair');
    expect(f.push(4.3)).toBe('fair');
    expect(f.push(4.3)).toBe('good');
  });
});

const sample = (t: number, p: Partial<EngineCallStats> = {}): EngineCallStats => ({ timestamp: t, ...p });

describe('QualityTracker', () => {
  it('computes delta-based loss, bitrate, jitter, RTT, codec', () => {
    const tr = new QualityTracker();
    const first = tr.push(
      sample(0, {
        inbound: { packetsReceived: 100, packetsLost: 0, bytesReceived: 10_000, jitterMs: 5, codec: 'opus' },
        outbound: { packetsSent: 100, bytesSent: 10_000 },
        remoteInbound: { packetsLost: 0, jitterMs: 4, rttMs: 50 },
        rttMs: 30,
      }),
    );
    expect(first.inbound.packetLossPct).toBe(0);
    expect(first.inbound.bitrateKbps).toBeUndefined(); // no previous sample
    expect(first.rttMs).toBe(50); // RTCP RTT preferred over ICE
    expect(first.codec).toBe('opus');
    expect(first.level).toBe('good');

    const second = tr.push(
      sample(2000, {
        inbound: { packetsReceived: 190, packetsLost: 10, bytesReceived: 30_000, jitterMs: 12 },
        outbound: { packetsSent: 200, bytesSent: 30_000 },
        remoteInbound: { packetsLost: 5, jitterMs: 8 },
        rttMs: 30,
      }),
    );
    expect(second.inbound.packetLossPct).toBe(10); // 10 lost / (90 + 10)
    expect(second.outbound.packetLossPct).toBe(5); // 5 lost / 100 sent
    expect(second.inbound.bitrateKbps).toBe(80); // 20 000 B · 8 / 2000 ms
    expect(second.inbound.jitterMs).toBe(12);
    expect(second.outbound.jitterMs).toBe(8);
    expect(second.rttMs).toBe(30); // falls back to the candidate pair
    expect(second.totals).toEqual({ packetsSent: 200, packetsReceived: 190, packetsLost: 10 });
    expect(second.mos).toBeLessThan(first.mos);
    expect(second.level).toBe('poor');
  });

  it('treats counters that go backwards as a reset', () => {
    const tr = new QualityTracker();
    tr.push(sample(0, { inbound: { packetsReceived: 1000, packetsLost: 50, bytesReceived: 100_000 } }));
    const q = tr.push(sample(2000, { inbound: { packetsReceived: 95, packetsLost: 5, bytesReceived: 9_000 } }));
    expect(q.inbound.packetLossPct).toBe(5); // 5 / (95 + 5), not negative
    expect(q.inbound.bitrateKbps).toBeUndefined();
  });

  it('clamps a decreasing packetsLost (late packets) to zero loss', () => {
    const tr = new QualityTracker();
    tr.push(sample(0, { inbound: { packetsReceived: 100, packetsLost: 10 } }));
    const q = tr.push(sample(2000, { inbound: { packetsReceived: 200, packetsLost: 8 } }));
    expect(q.inbound.packetLossPct).toBe(0);
  });

  it('handles missing fields and empty intervals', () => {
    const tr = new QualityTracker();
    const q = tr.push(sample(0));
    expect(q.inbound).toEqual({});
    expect(q.outbound).toEqual({});
    expect(q.rttMs).toBeUndefined();
    expect(q.mos).toBe(4.4);
    // No packets in the interval → loss unknown, not 0/0 = NaN.
    tr.push(sample(1000, { inbound: { packetsReceived: 0, packetsLost: 0 } }));
    const idle = tr.push(sample(2000, { inbound: { packetsReceived: 0, packetsLost: 0 } }));
    expect(idle.inbound.packetLossPct).toBeUndefined();
    // Outbound loss falls back to RTCP fractionLost when no counters are present.
    const fl = tr.push(sample(3000, { outbound: { packetsSent: 0 }, remoteInbound: { fractionLost: 0.25 } }));
    expect(fl.outbound.packetLossPct).toBe(25);
  });

  it('prime() sets a baseline without producing a sample', () => {
    const tr = new QualityTracker();
    tr.push(sample(0, { inbound: { packetsReceived: 100, packetsLost: 50 } }));
    tr.prime(sample(10_000, { inbound: { packetsReceived: 100, packetsLost: 50 } }));
    const q = tr.push(sample(12_000, { inbound: { packetsReceived: 200, packetsLost: 50 } }));
    expect(q.inbound.packetLossPct).toBe(0);
  });

  it('drives the synthetic generator through the levels', () => {
    const gen = new SyntheticCallStats('good', 0);
    const tr = new QualityTracker();
    expect(tr.push(gen.next(2000)).level).toBe('good');
    gen.set('poor');
    const poor = tr.push(gen.next(4000));
    expect(poor.level).toBe('poor');
    expect(poor.inbound.packetLossPct).toBe(15);
    gen.set('good');
    expect(tr.push(gen.next(6000)).level).toBe('poor');
    expect(tr.push(gen.next(8000)).level).toBe('good');
  });
});

describe('QualitySummaryBuilder', () => {
  it('returns undefined without samples', () => {
    expect(new QualitySummaryBuilder().build()).toBeUndefined();
  });

  it('aggregates worst-direction loss/jitter, RTT and MOS', () => {
    const b = new QualitySummaryBuilder();
    const base = { totals: { packetsSent: 0, packetsReceived: 0, packetsLost: 0 } };
    b.add({ ...base, at: 1, level: 'good', mos: 4.4, rttMs: 40, codec: 'opus', inbound: { packetLossPct: 0, jitterMs: 2 }, outbound: { packetLossPct: 1, jitterMs: 6 } });
    b.add({ ...base, at: 2, level: 'poor', mos: 2.0, rttMs: 300, inbound: { packetLossPct: 20, jitterMs: 50 }, outbound: {} });
    b.add({ ...base, at: 3, level: 'fair', mos: 3.8, inbound: {}, outbound: {} });
    expect(b.build()).toEqual({
      samples: 3,
      avgLossPct: 10.5,
      maxLossPct: 20,
      avgJitterMs: 28,
      maxJitterMs: 50,
      avgRttMs: 170,
      maxRttMs: 300,
      avgMos: 3.4,
      minMos: 2.0,
      worstLevel: 'poor',
      codec: 'opus',
    });
  });
});
