import type { EngineCallStats } from '../types';

/** Simulated network conditions for {@link SyntheticCallStats}. */
export interface NetworkConditions {
  /** Packet loss in both directions, 0..100. */
  lossPct: number;
  jitterMs: number;
  rttMs: number;
  codec?: string;
}

/** Ready-made conditions that land in each quality level. */
export const NETWORK_PRESETS = {
  good: { lossPct: 0, jitterMs: 3, rttMs: 40 },
  fair: { lossPct: 4, jitterMs: 20, rttMs: 150 },
  poor: { lossPct: 15, jitterMs: 60, rttMs: 400 },
} as const satisfies Record<string, NetworkConditions>;

export type NetworkPreset = keyof typeof NETWORK_PRESETS;

const PACKETS_PER_SECOND = 50; // 20 ms ptime
const BYTES_PER_PACKET = 200; // ~80 kbit/s incl. headers

/**
 * Deterministic generator of cumulative RTP counters for fake/mock engines,
 * so tests and demos can drive the real quality computation. Conditions can
 * change at any time; counters keep accumulating like a real stream.
 */
export class SyntheticCallStats {
  conditions: NetworkConditions;
  private last: number;
  private expected = 0;
  private received = 0;
  private lost = 0;
  private lostCarry = 0;

  constructor(conditions: NetworkConditions | NetworkPreset = 'good', startedAt: number = Date.now()) {
    this.conditions = typeof conditions === 'string' ? { ...NETWORK_PRESETS[conditions] } : { ...conditions };
    this.last = startedAt;
  }

  set(conditions: NetworkConditions | NetworkPreset): void {
    this.conditions = typeof conditions === 'string' ? { ...NETWORK_PRESETS[conditions] } : { ...conditions };
  }

  /** Advance the stream to `now` and return cumulative stats. */
  next(now: number = Date.now()): EngineCallStats {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    const packets = Math.round((elapsed / 1000) * PACKETS_PER_SECOND);
    const lossExact = (packets * Math.min(100, Math.max(0, this.conditions.lossPct))) / 100 + this.lostCarry;
    const lostNow = Math.floor(lossExact);
    this.lostCarry = lossExact - lostNow;
    this.expected += packets;
    this.lost += lostNow;
    this.received += packets - lostNow;
    const codec = this.conditions.codec ?? 'opus';
    return {
      timestamp: now,
      inbound: {
        packetsReceived: this.received,
        packetsLost: this.lost,
        bytesReceived: this.received * BYTES_PER_PACKET,
        jitterMs: this.conditions.jitterMs,
        codec,
      },
      outbound: { packetsSent: this.expected, bytesSent: this.expected * BYTES_PER_PACKET, codec },
      remoteInbound: {
        packetsLost: this.lost,
        jitterMs: this.conditions.jitterMs,
        rttMs: this.conditions.rttMs,
      },
      rttMs: this.conditions.rttMs,
    };
  }
}
