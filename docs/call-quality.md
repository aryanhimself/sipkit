# Call quality (V2-QOS-01)

The core samples RTP statistics for each connected call, estimates a MOS score, and publishes
the result as an event, on the call snapshot, and as an end-of-call summary on the CDR.

## Config

| Option | Default | Meaning |
|---|---|---|
| `callQualityInterval` | `2` | Seconds between samples (0–60). `0` turns monitoring off: no event, no `call.quality`, no CDR summary, no UI indicator |

Sampling runs only while `call.state === 'connected'` and `call.hold === 'none'`. On hold it
pauses. On resume the first stats read only resets the baseline, so the hold period does not
count in the next interval. A config change takes effect at the next connect/resume.

## API

| Surface | Shape |
|---|---|
| Event `call:quality` | `{ callId, quality: CallQuality }`, once per sample |
| `call.quality` | Latest `CallQuality` (snapshot; each sample also emits `call:updated`) |
| `cdr.quality` | `CallQualitySummary`, optional. Absent when no sample was taken (short or unanswered calls, monitoring off, engine without stats) |
| React | `useCallQuality(callId?)` returns `CallQuality \| null` (default: active call) |
| UI | `<CallQualityIndicator call={call} />` (in the call screen): signal bars, `data-testid="call-quality"`, `data-level`, `aria-label="Call quality: Good"`, numbers in a tooltip |

`CallQuality` (types in `packages/core/src/types.ts`):

| Field | Meaning |
|---|---|
| `level` | `good` / `fair` / `poor` after hysteresis (see below) |
| `mos` | E-model MOS estimate for this interval, 1–4.5. Uses the worse direction for loss and jitter |
| `rttMs` | RTCP round-trip time (remote-inbound-rtp). Falls back to the ICE candidate pair |
| `codec` | e.g. `opus`, `pcmu` |
| `inbound` / `outbound` | `packetLossPct` (this interval), `jitterMs`, `bitrateKbps`. Outbound loss and jitter come from the remote end's RTCP receiver report |
| `totals` | Cumulative `packetsSent`, `packetsReceived`, `packetsLost` |

`CallQualitySummary`: `samples`, `avgLossPct`/`maxLossPct`, `avgJitterMs`/`maxJitterMs`,
`avgRttMs`/`maxRttMs`, `avgMos`/`minMos`, `worstLevel`, `codec`. Loss and jitter use the worse
direction of each sample. Host CRMs can store it from the `cdr` event (or `onCdr` /
`sipkit:cdr`), without any extra call.

## How it is computed

`packages/core/src/quality/quality.ts` holds the pure code and is unit tested.

- **Loss** is delta-based per interval: `Δlost / (Δreceived + Δlost)` inbound, and
  `Δremote packetsLost / Δsent` outbound (RTCP `fractionLost` as a fallback). A counter that
  goes backwards (SSRC change, renegotiation) counts as a restart from 0. A shrinking
  `packetsLost` (late packets) is clamped to 0. An interval with no packets gives no loss value.
- **MOS**, simplified ITU-T G.107 E-model:
  - `d = rtt/2 + 2·jitter + 10 ms`
  - `Id = 0.024·d + 0.11·(d − 177.3)` (the second term only when d > 177.3)
  - `Ie,eff = Ie + (95 − Ie)·loss/(loss + Bpl)`
  - `R = 93.2 − Id − Ie,eff`
  - `MOS = 1 + 0.035R + 7·10⁻⁶·R(R − 60)(100 − R)`

  Codec values come from G.113: G.711 Ie 0 / Bpl 25.1, G.729 11 / 19. Opus and unknown codecs
  use the G.711 values. This is conservative, because Opus FEC/PLC handles loss better. A perfect
  network gives MOS 4.40.
- **Level**: MOS ≥ 4.0 is good, ≥ 3.6 is fair, below that is poor. A worse level applies at once.
  A better level needs 2 consecutive samples that clear the threshold by 0.1 MOS, so the indicator
  does not flicker.

## Engines

The optional engine capability is `getCallStats(engineCallId): Promise<EngineCallStats | undefined>`,
with cumulative engine-agnostic counters.

| Engine | Source |
|---|---|
| SIP.js | `RTCPeerConnection.getStats()` → `parseRtcStats()` (`engines/sipjs/stats.ts`): audio `inbound-rtp`, `outbound-rtp`, `remote-inbound-rtp`, selected candidate pair, codec |
| `FakeEngine` (tests) | `engine.simulateNetwork(engineCallId, 'good' \| 'fair' \| 'poor' \| {lossPct, jitterMs, rttMs})`, or set `engine.callStats` |
| `MockSoftphone` (playground, demos) | `mock.simulateNetwork(preset)`. The playground "Mock controls" panel has Good / Fair / Poor buttons |

Engines without `getCallStats` skip monitoring silently.

## Tests

| Level | Where |
|---|---|
| Math, delta handling, resets, missing fields, hysteresis, summary | `packages/core/src/quality/quality.test.ts` |
| Monitor (fake timers, FakeEngine): sampling, degrade/recover, hold, CDR, off, failures | `packages/core/src/quality/monitor.test.ts` |
| getStats parsing | `packages/core/src/engines/sipjs/stats.test.ts` |
| Hook, mock | `packages/react/src/hooks/use-call-quality.test.tsx` |
| Indicator levels, tooltip, call screen | `packages/ui/src/features/call-quality.test.tsx` |
| Mock e2e (indicator degrades with "Poor" network) | `apps/playground/e2e/call-quality.spec.ts` |
| Real Asterisk echo (600) is `good` with plausible numbers | `apps/playground/e2e/sip/quality.spec.ts` |
| Real packet loss with tc/netem (opt-in) | same file. Run `E2E_NETEM=1 E2E_PORT=5182 pnpm --filter sipkit-playground test:e2e:sip -g "call quality"` |

The netem test gives `NET_ADMIN` only to the throwaway Playwright container, installs
`iproute2` in it, and adds 30% egress loss on its `eth0`. The shared Asterisk containers are not
changed. Egress loss shows up as outbound loss through Asterisk's RTCP receiver reports. To try it
by hand without the script, run `tc qdisc replace dev eth0 root netem loss 30%` inside any
container that runs the browser with `--cap-add NET_ADMIN`, and run
`tc qdisc del dev eth0 root` to undo it.
