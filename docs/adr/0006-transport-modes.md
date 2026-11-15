# 0006. Two transport modes: direct WebRTC and SIP gateway

- Status: Accepted
- Date: 2026-11-08

## Context

Many PBX deployments reach phones over **plain SIP/UDP**. Browsers cannot send UDP SIP. They
need SIP over WSS with DTLS-SRTP media. Some PBXs (e.g. Asterisk with `res_http_websocket`)
support WebRTC directly, but other deployments (or other PBXs) may not.

## Decision

Support two configurable modes in the same engine (`config.transportMode`):

| Mode | Path | Requirement |
|---|---|---|
| `webrtc` (default) | Browser → WSS → Asterisk (`webrtc=yes`) | Asterisk with `res_http_websocket`, TLS certificate, PJSIP WebRTC endpoints |
| `sip-gateway` | Browser → WSS → gateway → UDP/TCP/TLS → PBX | A gateway (reference: Asterisk B2BUA in `infra/asterisk` `gateway` profile; at scale Kamailio + rtpengine) |

Both modes support multiple `websocketUrls` for failover and explicit `iceServers`
(STUN/TURN). **There is no hidden fallback to any third-party gateway.**

## Consequences

- A PBX with WebRTC support can be reached directly, with no per-PC installer.
- Environments without WebRTC on the PBX still work through a gateway they operate.
- Two modes double part of the e2e matrix. CI runs both against `infra/asterisk`.
- How the gateway learns the upstream (`sipServer`) is gateway specific (see [architecture](../architecture.md#transport-modes-in-detail)).

## Alternatives considered

WebRTC only (excludes PBXs without WebRTC). A desktop-only native engine (reintroduces
installers; kept as a v2 option for the desktop app).
