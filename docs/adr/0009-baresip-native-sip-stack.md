# 0009. baresip as the native SIP stack, driven over IPC

- Status: Accepted
- Date: 2026-11-09

## Context

V2-DESK-02 needs a `SoftphoneEngine` that speaks plain SIP over UDP/TCP/TLS without a
WebRTC gateway, for the desktop app (Electron, V2-DESK-01). Browsers cannot send UDP SIP, so
the SIP and RTP stack must be native. Constraints:

- The engine must run wherever core runs (renderer, Node tests), so the native part has to sit
  behind a small, serializable IPC protocol rather than a Node addon loaded into the renderer.
- No Rust toolchain on the build machines; native addons (node-gyp against Electron's ABI)
  are a recurring maintenance cost.
- It must be testable headless in CI against the dev Asterisk (UDP endpoints 2001/2002).
- Licence must allow closed-source distribution.

## Decision

Use **baresip** (with libre) as a **sidecar process**, controlled through its `ctrl_tcp`
module (netstring-framed JSON over a loopback TCP socket). A TypeScript `BaresipSidecar`
translates our own versioned JSON protocol (`packages/engine-native/src/protocol.ts`) into
baresip commands and baresip events back into protocol events. `NativeSipEngine` only knows
the protocol and a `NativeSipTransport` (IPC bridge, stdio JSON lines, or in-memory).

Tests run baresip in a Docker image built from source (`packages/engine-native/sidecar/`),
next to the PBX on the `sipkit-dev_voip` network. Desktop builds bundle a native
baresip binary per OS (see docs/native-engine.md).

## Consequences

- The engine is host-agnostic and unit-testable with fake sidecars; the same contract suite
  runs against fakes and against real baresip + Asterisk.
- A crash in the SIP/media stack takes down the sidecar, not the app; the engine reports the
  transport as disconnected and ends calls.
- Media never reaches JavaScript: no `MediaStream`s, so browser features built on them (local
  conference mixing, `replaceOutgoingTrack`, WebRTC stats, video) are unavailable on this engine.
  Device selection must be mapped to baresip audio modules.
- baresip's control surface has quirks (current-call semantics, UA indexes, unregister
  reporting, free-text close reasons). They are contained in `baresip-sidecar.ts` and pinned by
  unit tests against a fake ctrl_tcp server.
- Attended transfer between two existing calls has no direct baresip command; it is
  reported as unsupported until implemented.
- We ship and sign a native binary per OS/arch, and track baresip releases.

## Alternatives considered

- **pjsua / PJSIP** (CLI or pjsua2 bindings): very complete, but GPL unless a commercial
  licence is bought; the CLI has no structured control protocol, and pjsua2 needs a native
  addon (node-gyp/SWIG) per Electron ABI.
- **A Node SIP stack (e.g. sip.js over UDP, drachtio, `sip` npm) plus native RTP**: SIP would
  be in JS, but RTP, jitter buffers, codecs and audio devices still need native code; this
  rebuilds a softphone media stack.
- **Rust stack under Tauri**: no Rust toolchain available and V2-DESK-01 picked Electron.
- **Linphone (liblinphone)**: capable, but GPL/commercial dual licence and a heavier SDK.
- **Keep a WebRTC gateway for desktop**: does not meet "no gateway"; already covered by the
  `sip-gateway` transport mode (ADR 0006).
