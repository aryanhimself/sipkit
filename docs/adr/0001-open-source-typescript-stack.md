# 0001. An open-source TypeScript softphone on SIP.js and React

- Status: Accepted
- Date: 2026-11-08

## Context

Embedding a phone in a web application (a CRM, a help desk, an internal tool) usually means
either a closed commercial SDK or a demo-quality open-source UI. Closed SDKs are hard to audit,
fix or extend, often ship obsolete engines and depend on vendor-hosted services. Many open-source
softphones are full applications rather than embeddable libraries, or carry copyleft licences
that do not suit a widget dropped into someone else's product.

## Decision

Build sipkit from scratch in TypeScript on permissively licensed open-source components
(SIP.js for SIP/WebRTC, React for the UI) and publish it under the MIT licence:

- a framework-free core (`sipkit-core`) with a typed API, snapshot and events,
- React bindings (`sipkit-react`) and a ready-made widget (`sipkit-ui`), also shipped as a
  `<sipkit-phone>` web component,
- an optional native engine (`sipkit-engine-native`) for desktop shells.

## Consequences

- The whole stack can be tested, audited and changed in one repository.
- No vendor services are contacted by default ([architecture](../architecture.md#security-model)).
- Browsers cannot speak plain SIP/UDP. WebRTC (direct or through a gateway,
  [ADR-0006](0006-transport-modes.md)) or a desktop engine ([ADR-0009](0009-baresip-native-sip-stack.md))
  covers that.

## Alternatives considered

| Option | Why not |
|---|---|
| A commercial softphone SDK | Closed source, licence lock-in, nothing can be fixed at the source |
| Fork an open-source softphone (e.g. a SIP.js demo UI, Browser-Phone) | Their UI, state model and licences (some GPL/AGPL) do not fit an embeddable, MIT-licensed widget. We reuse ideas, not code |
