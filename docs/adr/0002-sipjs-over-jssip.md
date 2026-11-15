# 0002. SIP.js as the SIP/WebRTC stack

- Status: Accepted
- Date: 2026-11-08

## Context

We need a browser SIP stack (SIP over WebSocket, RFC 7118) with WebRTC media that works with
Asterisk PJSIP and common gateways. The mature open-source options are **SIP.js** and **JsSIP**.

## Decision

Use **SIP.js** (`sip.js@^0.21`), wrapped behind our own `SoftphoneEngine` interface.

| Criterion | SIP.js | JsSIP |
|---|---|---|
| Language / types | Written in TypeScript, ships types | JS with community/bundled typings |
| API style | Layered: low-level `UserAgent`/`Session` + optional `SimpleUser` | Single high-level `UA`/`RTCSession` |
| Media handling | Pluggable `SessionDescriptionHandler` (easy to customise ICE timeouts, track replacement, conference mixing) | Built in, less pluggable |
| Licence | MIT | MIT |
| Asterisk usage | Widely used with Asterisk/FreeSWITCH | Widely used with Kamailio/Asterisk |
| Maintenance | Slower release cadence in recent years (**risk**) | Active |

## Consequences

- Strong typing and a pluggable media layer suit our engine abstraction.
- **Risk:** SIP.js release cadence. Mitigation: everything SIP.js-specific stays in `packages/core/src/engines/sipjs/`. A JsSIP engine can be added behind the same interface if we need it, and the engine contract tests (roadmap V1-TEST-02) would catch any behavioural differences.
- We pin a minor version range and upgrade deliberately, with real-Asterisk e2e in CI.

## Alternatives considered

JsSIP (above). Writing our own SIP stack: rejected, because it adds high risk for no benefit.
