import type {
  CallQuality,
  CallQualityStream,
  CallQualitySummary,
  CallVideoQuality,
  EngineCallStats,
  QualityLevel,
} from '../types';

/**
 * Pure call-quality computation (no timers, no engine). Turns a series of
 * cumulative {@link EngineCallStats} into per-interval {@link CallQuality}
 * samples and an end-of-call {@link CallQualitySummary}.
 *
 * MOS uses a simplified ITU-T G.107 E-model:
 *   d    = rtt/2 + 2·jitter + 10 ms          (one-way delay incl. jitter buffer + packetisation)
 *   Id   = 0.024·d + 0.11·(d − 177.3)·H(d − 177.3)
 *   Ie,e = Ie + (95 − Ie) · Ppl / (Ppl + Bpl) (random loss, BurstR = 1)
 *   R    = 93.2 − Id − Ie,e
 *   MOS  = 1 + 0.035·R + 7·10⁻⁶·R·(R − 60)·(100 − R)   (clamped to 1..4.5)
 */

/** MOS thresholds: ≥ good → good, ≥ fair → fair, otherwise poor. */
export const QUALITY_THRESHOLDS = { good: 4.0, fair: 3.6 } as const;

/** Codec impairment factors (ITU-T G.113). Unknown codecs (and Opus, conservatively) use G.711 + PLC values. */
const CODEC_IMPAIRMENT: Record<string, { ie: number; bpl: number }> = {
  pcmu: { ie: 0, bpl: 25.1 },
  pcma: { ie: 0, bpl: 25.1 },
  g722: { ie: 0, bpl: 25.1 },
  g729: { ie: 11, bpl: 19 },
  ilbc: { ie: 10, bpl: 32 },
};
const DEFAULT_IMPAIRMENT = { ie: 0, bpl: 25.1 };

export interface RFactorInput {
  rttMs?: number;
  jitterMs?: number;
  lossPct?: number;
  codec?: string;
}

/** E-model transmission rating R (0..93.2). */
export function rFactor({ rttMs = 0, jitterMs = 0, lossPct = 0, codec }: RFactorInput): number {
  const d = Math.max(0, rttMs) / 2 + 2 * Math.max(0, jitterMs) + 10;
  const id = 0.024 * d + (d > 177.3 ? 0.11 * (d - 177.3) : 0);
  const { ie, bpl } = (codec && CODEC_IMPAIRMENT[codec.toLowerCase()]) || DEFAULT_IMPAIRMENT;
  const ppl = Math.min(100, Math.max(0, lossPct));
  const ieEff = ie + ((95 - ie) * ppl) / (ppl + bpl);
  return Math.max(0, 93.2 - id - ieEff);
}

/** ITU-T G.107 R → MOS conversion, clamped to 1..4.5. */
export function mosFromR(r: number): number {
  if (r <= 0) return 1;
  if (r >= 100) return 4.5;
  const mos = 1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r);
  return Math.min(4.5, Math.max(1, mos));
}

/** MOS estimate (1..4.5) for the given network figures. */
export function estimateMos(input: RFactorInput): number {
  return mosFromR(rFactor(input));
}

/** Unsmoothed level for a MOS value. */
export function levelForMos(mos: number): QualityLevel {
  if (mos >= QUALITY_THRESHOLDS.good) return 'good';
  if (mos >= QUALITY_THRESHOLDS.fair) return 'fair';
  return 'poor';
}

const RANK: Record<QualityLevel, number> = { poor: 0, fair: 1, good: 2 };

/** Worst of two levels. */
export function worseLevel(a: QualityLevel, b: QualityLevel): QualityLevel {
  return RANK[a] <= RANK[b] ? a : b;
}

export interface LevelFilterOptions {
  /** Consecutive better samples needed before the level improves (default 2). */
  recoverSamples?: number;
  /** MOS must clear the higher threshold by this margin to count as better (default 0.1). */
  margin?: number;
}

/**
 * Hysteresis for the quality level: degrade immediately (users notice bad
 * audio at once), recover only after `recoverSamples` consecutive samples
 * that clear the threshold by `margin`, so the indicator does not flicker.
 */
export class QualityLevelFilter {
  private current: QualityLevel | undefined;
  private streak = 0;
  private readonly recoverSamples: number;
  private readonly margin: number;

  constructor(options: LevelFilterOptions = {}) {
    this.recoverSamples = Math.max(1, options.recoverSamples ?? 2);
    this.margin = Math.max(0, options.margin ?? 0.1);
  }

  get level(): QualityLevel | undefined {
    return this.current;
  }

  push(mos: number): QualityLevel {
    const raw = levelForMos(mos);
    if (this.current === undefined || RANK[raw] < RANK[this.current]) {
      this.current = raw;
      this.streak = 0;
      return raw;
    }
    const better = levelForMos(mos - this.margin);
    if (RANK[better] > RANK[this.current]) {
      this.streak += 1;
      if (this.streak >= this.recoverSamples) {
        this.current = better;
        this.streak = 0;
      }
    } else {
      this.streak = 0;
    }
    return this.current;
  }
}

const round = (n: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/**
 * Delta of a cumulative counter. A counter that went backwards (SSRC change,
 * renegotiation) is treated as restarted from 0, so the current value is the delta.
 */
function counterDelta(current: number, previous: number | undefined): number {
  if (previous === undefined || current < previous) return Math.max(0, current);
  return current - previous;
}

function pct(part: number, whole: number): number | undefined {
  if (!(whole > 0)) return undefined;
  return round(Math.min(100, Math.max(0, (100 * part) / whole)));
}

function kbps(bytes: number | undefined, prevBytes: number | undefined, dtMs: number): number | undefined {
  if (bytes === undefined || prevBytes === undefined || !(dtMs > 0) || bytes < prevBytes) return undefined;
  return round(((bytes - prevBytes) * 8) / dtMs, 1);
}

const isNum = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

function maxDefined(...values: (number | undefined)[]): number | undefined {
  const nums = values.filter(isNum);
  return nums.length ? Math.max(...nums) : undefined;
}

/**
 * Stateful converter from cumulative engine stats to per-interval quality.
 * The first sample measures from the start of the stream (counters at 0).
 */
export class QualityTracker {
  private prev: EngineCallStats | undefined;
  private readonly filter: QualityLevelFilter;

  constructor(options: LevelFilterOptions = {}) {
    this.filter = new QualityLevelFilter(options);
  }

  /** Use `stats` as the baseline for the next interval without producing a sample (e.g. after hold). */
  prime(stats: EngineCallStats): void {
    this.prev = stats;
  }

  push(stats: EngineCallStats): CallQuality {
    const prev = this.prev;
    this.prev = stats;
    const dt = prev ? stats.timestamp - prev.timestamp : 0;

    const inbound: CallQualityStream = {};
    if (stats.inbound) {
      const p = prev?.inbound;
      const received = counterDelta(stats.inbound.packetsReceived, p?.packetsReceived);
      const reset = p !== undefined && stats.inbound.packetsReceived < p.packetsReceived;
      // packetsLost may legitimately decrease (late / duplicate packets): clamp at 0.
      const lost = reset || !p ? Math.max(0, stats.inbound.packetsLost) : Math.max(0, stats.inbound.packetsLost - p.packetsLost);
      inbound.packetLossPct = pct(lost, received + lost);
      if (isNum(stats.inbound.jitterMs)) inbound.jitterMs = round(stats.inbound.jitterMs, 1);
      const rate = kbps(stats.inbound.bytesReceived, reset ? undefined : p?.bytesReceived, dt);
      if (rate !== undefined) inbound.bitrateKbps = rate;
    }

    const outbound: CallQualityStream = {};
    if (stats.outbound) {
      const p = prev?.outbound;
      const reset = p !== undefined && stats.outbound.packetsSent < p.packetsSent;
      const sent = counterDelta(stats.outbound.packetsSent, p?.packetsSent);
      const remote = stats.remoteInbound;
      const prevRemote = reset ? undefined : prev?.remoteInbound;
      if (remote && isNum(remote.packetsLost)) {
        const lost = isNum(prevRemote?.packetsLost)
          ? Math.max(0, remote.packetsLost - prevRemote.packetsLost)
          : Math.max(0, remote.packetsLost);
        outbound.packetLossPct = pct(lost, sent);
      }
      if (outbound.packetLossPct === undefined && remote && isNum(remote.fractionLost)) {
        outbound.packetLossPct = round(Math.min(100, Math.max(0, remote.fractionLost * 100)));
      }
      if (remote && isNum(remote.jitterMs)) outbound.jitterMs = round(remote.jitterMs, 1);
      const rate = kbps(stats.outbound.bytesSent, reset ? undefined : p?.bytesSent, dt);
      if (rate !== undefined) outbound.bitrateKbps = rate;
    }

    const rtt = isNum(stats.remoteInbound?.rttMs) ? stats.remoteInbound.rttMs : stats.rttMs;
    const codec = stats.inbound?.codec ?? stats.outbound?.codec;
    // Dead media: no packets at all in this interval. Loss-based MOS can't see this
    // (0 lost of 0 received looks perfect), so report it explicitly.
    // The first sample covers the time since connect (one sampling interval), so it counts too.
    // With no audio stats at all we can't tell, so only judge once a stream exists.
    const measured = (!prev || dt > 0) && Boolean(stats.inbound || stats.outbound);
    const noReceive = measured && counterDelta(stats.inbound?.packetsReceived ?? 0, prev?.inbound?.packetsReceived) === 0;
    const noSend = measured && counterDelta(stats.outbound?.packetsSent ?? 0, prev?.outbound?.packetsSent) === 0;
    const noAudio = noReceive && noSend ? 'both' : noReceive ? 'receive' : noSend ? 'send' : undefined;
    const mos = noAudio ? 1 : round(
      estimateMos({
        rttMs: rtt,
        jitterMs: maxDefined(inbound.jitterMs, outbound.jitterMs),
        lossPct: maxDefined(inbound.packetLossPct, outbound.packetLossPct),
        codec,
      }),
    );

    const quality: CallQuality = {
      at: stats.timestamp,
      // Dead media is reported as poor right away but kept out of the smoothing filter,
      // so the indicator recovers as soon as audio starts.
      level: noAudio ? 'poor' : this.filter.push(mos),
      mos,
      inbound,
      outbound,
      totals: {
        packetsSent: stats.outbound?.packetsSent ?? 0,
        packetsReceived: stats.inbound?.packetsReceived ?? 0,
        packetsLost: Math.max(0, stats.inbound?.packetsLost ?? 0),
      },
    };
    if (isNum(rtt)) quality.rttMs = round(rtt, 1);
    if (codec) quality.codec = codec;
    if (noAudio) quality.noAudio = noAudio;
    const video = videoQuality(stats, prev, dt);
    if (video) quality.video = video;
    return quality;
  }
}

/** Video metrics for one interval (V2-VID-01). Informational only: never feeds MOS. */
function videoQuality(stats: EngineCallStats, prev: EngineCallStats | undefined, dt: number): CallVideoQuality | undefined {
  const v = stats.video;
  if (!v) return undefined;
  const pv = prev?.video;
  const out: CallVideoQuality = { inbound: {}, outbound: {} };
  const frame = (target: CallVideoQuality['inbound'], s: { framesPerSecond?: number; frameWidth?: number; frameHeight?: number }) => {
    if (isNum(s.framesPerSecond)) target.framesPerSecond = round(s.framesPerSecond, 1);
    if (isNum(s.frameWidth)) target.frameWidth = s.frameWidth;
    if (isNum(s.frameHeight)) target.frameHeight = s.frameHeight;
  };
  if (v.inbound) {
    const p = pv?.inbound;
    const reset = p !== undefined && v.inbound.packetsReceived < p.packetsReceived;
    const received = counterDelta(v.inbound.packetsReceived, reset ? undefined : p?.packetsReceived);
    const lost = reset || !p ? Math.max(0, v.inbound.packetsLost) : Math.max(0, v.inbound.packetsLost - p.packetsLost);
    const loss = pct(lost, received + lost);
    if (loss !== undefined) out.inbound.packetLossPct = loss;
    const rate = kbps(v.inbound.bytesReceived, reset ? undefined : p?.bytesReceived, dt);
    if (rate !== undefined) out.inbound.bitrateKbps = rate;
    frame(out.inbound, v.inbound);
  }
  if (v.outbound) {
    const p = pv?.outbound;
    const reset = p !== undefined && v.outbound.packetsSent < p.packetsSent;
    const rate = kbps(v.outbound.bytesSent, reset ? undefined : p?.bytesSent, dt);
    if (rate !== undefined) out.outbound.bitrateKbps = rate;
    frame(out.outbound, v.outbound);
  }
  const codec = v.inbound?.codec ?? v.outbound?.codec;
  if (codec) out.codec = codec;
  return out;
}

class Stat {
  private sum = 0;
  private n = 0;
  max: number | undefined;
  add(v: number | undefined): void {
    if (!isNum(v)) return;
    this.sum += v;
    this.n += 1;
    this.max = this.max === undefined ? v : Math.max(this.max, v);
  }
  get avg(): number | undefined {
    return this.n ? round(this.sum / this.n) : undefined;
  }
}

/** Accumulates samples into an end-of-call {@link CallQualitySummary}. */
export class QualitySummaryBuilder {
  private samples = 0;
  private readonly loss = new Stat();
  private readonly jitter = new Stat();
  private readonly rtt = new Stat();
  private readonly mos = new Stat();
  private minMos = Infinity;
  private worst: QualityLevel = 'good';
  private codec: string | undefined;

  add(q: CallQuality): void {
    this.samples += 1;
    this.loss.add(maxDefined(q.inbound.packetLossPct, q.outbound.packetLossPct));
    this.jitter.add(maxDefined(q.inbound.jitterMs, q.outbound.jitterMs));
    this.rtt.add(q.rttMs);
    this.mos.add(q.mos);
    this.minMos = Math.min(this.minMos, q.mos);
    this.worst = worseLevel(this.worst, q.level);
    this.codec = q.codec ?? this.codec;
  }

  /** The summary, or undefined when no sample was taken. */
  build(): CallQualitySummary | undefined {
    if (this.samples === 0) return undefined;
    const summary: CallQualitySummary = {
      samples: this.samples,
      avgMos: this.mos.avg ?? this.minMos,
      minMos: this.minMos,
      worstLevel: this.worst,
    };
    const set = <K extends keyof CallQualitySummary>(key: K, value: CallQualitySummary[K] | undefined) => {
      if (value !== undefined) summary[key] = value;
    };
    set('avgLossPct', this.loss.avg);
    set('maxLossPct', this.loss.max);
    set('avgJitterMs', this.jitter.avg);
    set('maxJitterMs', this.jitter.max);
    set('avgRttMs', this.rtt.avg);
    set('maxRttMs', this.rtt.max);
    set('codec', this.codec);
    return summary;
  }
}

/** Summarise a list of samples (convenience over {@link QualitySummaryBuilder}). */
export function summarizeQuality(samples: CallQuality[]): CallQualitySummary | undefined {
  const b = new QualitySummaryBuilder();
  samples.forEach((s) => b.add(s));
  return b.build();
}

/** Coarse 0 (worst) .. 5 (best) quality score from a MOS value (1..4.5), e.g. for signal bars. */
export function mosToQualityScore(mos: number): number {
  return Math.max(0, Math.min(5, Math.round(((mos - 1) / 3.5) * 5)));
}
