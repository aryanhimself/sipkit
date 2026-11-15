import { describe, expect, it } from 'vitest';
import { parseRtcStats } from './stats';

const report = (entries: unknown[]) => new Map(entries.map((e, i) => [String(i), e]));

describe('parseRtcStats', () => {
  it('maps inbound/outbound/remote-inbound/candidate-pair audio stats', () => {
    const stats = parseRtcStats(
      report([
        { id: 'c1', type: 'codec', mimeType: 'audio/opus' },
        { id: 'c2', type: 'codec', mimeType: 'audio/PCMU' },
        { id: 'in', type: 'inbound-rtp', kind: 'audio', packetsReceived: 500, packetsLost: 5, bytesReceived: 40_000, jitter: 0.012, codecId: 'c1' },
        { id: 'vin', type: 'inbound-rtp', kind: 'video', packetsReceived: 9999, packetsLost: 999 },
        { id: 'out', type: 'outbound-rtp', kind: 'audio', packetsSent: 510, bytesSent: 41_000, codecId: 'c2' },
        { id: 'rin', type: 'remote-inbound-rtp', kind: 'audio', packetsLost: 3, jitter: 0.004, fractionLost: 0.01, roundTripTime: 0.045 },
        { id: 't', type: 'transport', selectedCandidatePairId: 'cp2' },
        { id: 'cp1', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.5 },
        { id: 'cp2', type: 'candidate-pair', currentRoundTripTime: 0.03 },
      ]),
      1234,
    );
    expect(stats).toEqual({
      timestamp: 1234,
      inbound: { packetsReceived: 500, packetsLost: 5, bytesReceived: 40_000, jitterMs: 12, codec: 'opus' },
      outbound: { packetsSent: 510, bytesSent: 41_000, codec: 'pcmu' },
      remoteInbound: { packetsLost: 3, jitterMs: 4, fractionLost: 0.01, rttMs: 45 },
      rttMs: 30,
      // Video counters are reported separately and never mixed into the audio figures.
      video: { inbound: { packetsReceived: 9999, packetsLost: 999 } },
    });
  });

  it('falls back to the nominated pair and tolerates missing fields', () => {
    const stats = parseRtcStats(
      report([
        { id: 'in', type: 'inbound-rtp', mediaType: 'audio' },
        { id: 'cp', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.02 },
      ]),
      1,
    );
    expect(stats?.inbound).toMatchObject({ packetsReceived: 0, packetsLost: 0 });
    expect(stats?.outbound).toBeUndefined();
    expect(stats?.remoteInbound).toBeUndefined();
    expect(stats?.rttMs).toBe(20);
  });

  it('returns undefined when there is no audio RTP yet', () => {
    expect(parseRtcStats(report([{ type: 'candidate-pair' }, null, 'x']))).toBeUndefined();
  });
});
