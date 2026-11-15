# 0005. Plugin architecture with an engine interface

- Status: Accepted
- Date: 2026-11-08

## Context

All-in-one softphone libraries bundle every feature (chat, contacts, presence, file transfer…)
into one library and let hosts switch them off. Most hosts use a small subset but pay for all of
it in size and complexity. Many useful features (CRM lookup, recording controls, quality stats)
are host specific.

## Decision

- Core is a small **orchestrator** (`Softphone`) that owns state and exposes a typed API, snapshot and events.
- Optional behaviour is implemented as **plugins** (`SoftphonePlugin`: `setup(ctx)` → `{ api, hooks, dispose }`) with hooks `beforeDial` and `onIncomingCall`.
- Signalling and media are behind a **`SoftphoneEngine`** interface. Engines report facts, and the orchestrator decides.
- UI features use **extension points** (tabs, call actions, panels, slots) in `sipkit-ui`.

## Consequences

- Hosts include only what they use. Built-ins (history, contacts, ringtone) are plugins too, so the API is proven by our own code.
- New engines (native desktop, JsSIP) reuse all call logic.
- Plugin API stability matters: changes to `plugin.ts` / `types.ts` follow semver and need a changeset.

## Alternatives considered

Monolithic feature flags (the all-in-one model). Middleware/event-bus only (no typed plugin APIs).
Both are harder to test and to keep small.
