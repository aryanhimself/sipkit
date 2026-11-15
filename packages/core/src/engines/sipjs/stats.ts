import type { EngineCallStats } from '../../types';

/** The subset of RTCStatsReport we read (also satisfied by a Map in tests). */
export interface StatsReportLike {
  forEach(callback: (value: unknown) => void): void;
}

type Stat = Record<string, unknown> & { id?: string; type?: string };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const sec2ms = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : n * 1000;
};
const isAudio = (s: Stat) => (s.kind ?? s.mediaType) === 'audio';
const isVideo = (s: Stat) => (s.kind ?? s.mediaType) === 'video';

function codecName(byId: Map<string, Stat>, codecId: unknown): string | undefined {
  const codec = typeof codecId === 'string' ? byId.get(codecId) : undefined;
  const mime = typeof codec?.mimeType === 'string' ? codec.mimeType : undefined;
  return mime ? (mime.split('/')[1] ?? mime).toLowerCase() : undefined;
}

/**
 * Translate a WebRTC `getStats()` report into engine-agnostic
 * {@link EngineCallStats} (audio, plus video counters for video calls). Missing entries are left out, so
 * early or partial reports are fine.
 */
export function parseRtcStats(report: StatsReportLike, now: number = Date.now()): EngineCallStats | undefined {
  const byId = new Map<string, Stat>();
  const all: Stat[] = [];
  report.forEach((value) => {
    if (!value || typeof value !== 'object') return;
    const s = value as Stat;
    all.push(s);
    if (typeof s.id === 'string') byId.set(s.id, s);
  });
  const inbound = all.find((s) => s.type === 'inbound-rtp' && isAudio(s));
  const outbound = all.find((s) => s.type === 'outbound-rtp' && isAudio(s));
  const remote = all.find((s) => s.type === 'remote-inbound-rtp' && isAudio(s));
  if (!inbound && !outbound) return undefined;

  const transport = all.find((s) => s.type === 'transport' && typeof s.selectedCandidatePairId === 'string');
  const pair =
    (transport ? byId.get(transport.selectedCandidatePairId as string) : undefined) ??
    all.find(
      (s) => s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded')),
    );

  const stats: EngineCallStats = { timestamp: now };
  if (inbound) {
    stats.inbound = {
      packetsReceived: num(inbound.packetsReceived) ?? 0,
      packetsLost: num(inbound.packetsLost) ?? 0,
      bytesReceived: num(inbound.bytesReceived),
      jitterMs: sec2ms(inbound.jitter),
      codec: codecName(byId, inbound.codecId),
    };
  }
  if (outbound) {
    stats.outbound = {
      packetsSent: num(outbound.packetsSent) ?? 0,
      bytesSent: num(outbound.bytesSent),
      codec: codecName(byId, outbound.codecId),
    };
  }
  if (remote) {
    stats.remoteInbound = {
      packetsLost: num(remote.packetsLost),
      jitterMs: sec2ms(remote.jitter),
      fractionLost: num(remote.fractionLost),
      rttMs: sec2ms(remote.roundTripTime),
    };
  }
  const rtt = sec2ms(pair?.currentRoundTripTime);
  if (rtt !== undefined) stats.rttMs = rtt;

  // Video (V2-VID-01): the largest stream per direction (simulcast-safe enough for 1:1).
  const bytes = (s: Stat, key: string) => num(s[key]) ?? 0;
  const vIn = all.filter((s) => s.type === 'inbound-rtp' && isVideo(s)).sort((a, b) => bytes(b, 'bytesReceived') - bytes(a, 'bytesReceived'))[0];
  const vOut = all.filter((s) => s.type === 'outbound-rtp' && isVideo(s)).sort((a, b) => bytes(b, 'bytesSent') - bytes(a, 'bytesSent'))[0];
  if (vIn || vOut) {
    stats.video = {};
    if (vIn) {
      stats.video.inbound = {
        packetsReceived: num(vIn.packetsReceived) ?? 0,
        packetsLost: num(vIn.packetsLost) ?? 0,
        bytesReceived: num(vIn.bytesReceived),
        framesPerSecond: num(vIn.framesPerSecond),
        frameWidth: num(vIn.frameWidth),
        frameHeight: num(vIn.frameHeight),
        codec: codecName(byId, vIn.codecId),
      };
    }
    if (vOut) {
      stats.video.outbound = {
        packetsSent: num(vOut.packetsSent) ?? 0,
        bytesSent: num(vOut.bytesSent),
        framesPerSecond: num(vOut.framesPerSecond),
        frameWidth: num(vOut.frameWidth),
        frameHeight: num(vOut.frameHeight),
        codec: codecName(byId, vOut.codecId),
      };
    }
  }
  return stats;
}
