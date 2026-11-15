# Adding a feature

Most features fit one of three shapes. Pick the smallest that works:

| Shape | Use when | Where |
|---|---|---|
| **Plugin** (core) | New behaviour driven by softphone events: lookups, auto-answer rules, number rewriting, history, analytics | `packages/core/src/plugins/` (built in) or the host app (custom) |
| **UI extension** | New visual surface: a tab, an in-call button, a side panel, a slot in an existing screen | `sipkit-ui` `extensions` / `slots` props |
| **Engine** | New signalling/media stack (native SIP, a different WebRTC library) | `packages/core/src/engines/<name>/` or a new package |
| Core change | A capability every engine and UI needs (a new call state, a new command) | `packages/core/src/types.ts` + `softphone.ts`. Discuss in an issue or ADR first |

## Checklist (every feature)

1. **Issue / roadmap ID.** Link the task from [roadmap.md](roadmap.md), or open an issue with the acceptance criteria.
2. **Config.** If it needs settings, add them to `configSchema` in `packages/core/src/config.ts` with a safe default and a doc comment.
3. **Logic in core, rendering in UI.** Plugins must not import React. UI must not import `sip.js`.
4. **Feature flag.** If the feature can be hidden, check `isFeatureEnabled(config, 'MY_FEATURE')` so `disabledFeatures` turns it off.
5. **Tests.** Unit-test with `createTestSoftphone()` and `FakeEngine` from `sipkit-core/testing`. Add a Playwright test in `apps/playground` if there is UI.
6. **Docs.** Update the package README and, if the architecture changed, [architecture.md](architecture.md) or a new ADR.
7. **Changeset / conventional commit** (`feat(core): …`). See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Example 1: a "CRM caller lookup" plugin + UI slot

Goal: when a call comes in, call `GET {lookupUrl}?number=…` on the CRM and show the
customer name and a link under the caller on the incoming-call card and the call screen.

### 1. The plugin (logic)

```ts
// crm-lookup.ts (in the host app, or packages/core/src/plugins/ if it becomes built-in)
import { definePlugin, type CallId } from 'sipkit-core';

export interface CrmMatch {
  name: string;
  url: string;
  company?: string;
}

export interface CrmLookupApi {
  get(callId: CallId): CrmMatch | null | undefined; // undefined = still loading / not looked up
  subscribe(listener: () => void): () => void;
}

export interface CrmLookupOptions {
  lookupUrl: string; // e.g. https://crm.example.com/api/caller-lookup
  /** Returns headers for the request, e.g. the CRM session token. Never put SIP secrets here. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  timeoutMs?: number;
}

export const crmLookupPlugin = (opts: CrmLookupOptions) =>
  definePlugin<CrmLookupApi>({
    id: 'crm-lookup',
    setup(ctx) {
      const results = new Map<CallId, CrmMatch | null>();
      const listeners = new Set<() => void>();
      const notify = () => listeners.forEach((l) => l());
      const log = ctx.logger.child('crm-lookup');

      async function lookup(callId: CallId, number: string) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000);
        try {
          const url = new URL(opts.lookupUrl);
          url.searchParams.set('number', number); // a phone number, not a secret
          const res = await fetch(url, {
            headers: { Accept: 'application/json', ...(await opts.headers?.()) },
            signal: ctrl.signal,
            credentials: 'include',
          });
          results.set(callId, res.ok ? ((await res.json()) as CrmMatch | null) : null);
        } catch (err) {
          log.warn('lookup failed', { number, err: String(err) });
          results.set(callId, null); // fail open: the call still rings
        } finally {
          clearTimeout(timer);
          notify();
        }
      }

      const offCreated = ctx.api.on('call:created', ({ call }) => {
        if (call.direction === 'incoming') void lookup(call.id, call.remoteNumber);
      });
      const offEnded = ctx.api.on('call:ended', ({ call }) => {
        // keep results for a while so the post-call screen can still show them
        setTimeout(() => {
          results.delete(call.id);
          notify();
        }, 60_000);
      });

      return {
        api: {
          get: (id) => results.get(id),
          subscribe(l) {
            listeners.add(l);
            return () => listeners.delete(l);
          },
        },
        dispose() {
          offCreated();
          offEnded();
          listeners.clear();
        },
      };
    },
  });
```

Notes:
- **Never block ringing** on the network call. The plugin fails open.
- If you need to *decide* on a call (for example auto-reject blacklisted numbers), use `hooks.onIncomingCall` instead and return a decision. Keep it fast, because the call waits for it.
- CSP: the host must allow the CRM origin in `connect-src`.

### 2. The UI (rendering through the `callInfo` slot)

```tsx
import { useSyncExternalStore } from 'react';
import { usePlugin } from 'sipkit-react';
import type { Call } from 'sipkit-core';
import type { CrmLookupApi } from './crm-lookup';

function CrmCallInfo({ call }: { call: Call }) {
  const crm = usePlugin<CrmLookupApi>('crm-lookup');
  const match = useSyncExternalStore(
    (cb) => crm?.subscribe(cb) ?? (() => {}),
    () => crm?.get(call.id),
  );
  if (!crm || call.direction !== 'incoming') return null;
  if (match === undefined) return <span className="text-muted-foreground text-xs">Looking up…</span>;
  if (match === null) return <span className="text-muted-foreground text-xs">Unknown caller</span>;
  return (
    <a href={match.url} target="_blank" rel="noreferrer" className="text-xs underline">
      {match.name}
      {match.company ? ` · ${match.company}` : ''}
    </a>
  );
}
```

### 3. Wire it up

```tsx
// React host
import { createSoftphone } from 'sipkit-core';
import { SoftphoneProvider } from 'sipkit-react';
import { Softphone } from 'sipkit-ui';

const softphone = createSoftphone({
  config,
  plugins: [crmLookupPlugin({ lookupUrl: '/api/caller-lookup' })],
});

<SoftphoneProvider softphone={softphone}>
  <Softphone slots={{ callInfo: (call) => <CrmCallInfo call={call} /> }} />
</SoftphoneProvider>;
```

For the `<sipkit-phone>` web component, set the element's `slots` property and give it a
factory that registers the plugin (`element.factory = (config) => createSoftphone({ config, plugins: [...] })`).
See the `sipkit-ui` README for details.

### 4. Test it

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTestSoftphone } from 'sipkit-core/testing';
import { crmLookupPlugin, type CrmLookupApi } from './crm-lookup';

describe('crm-lookup', () => {
  it('looks up incoming callers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'Ada', url: '/c/1' }))));
    const { softphone, engine } = await createTestSoftphone({
      plugins: [crmLookupPlugin({ lookupUrl: 'https://crm.test/lookup' })],
    });
    engine.simulateIncomingCall({ remoteNumber: '+15551234' });
    await vi.waitFor(() => {
      const call = softphone.getSnapshot().calls[0]!;
      expect(softphone.plugin<CrmLookupApi>('crm-lookup')!.get(call.id)?.name).toBe('Ada');
    });
  });
});
```

---

## Example 2: a new engine

Use this when you need a different signalling or media stack. The worked example is the
planned **desktop engine**, which talks to a native SIP stack in an Electron/Tauri host through IPC, so
the desktop app can speak plain SIP/UDP without a gateway. The real implementation is `packages/engine-native` (baresip sidecar, [native-engine.md](native-engine.md)); the sketch below shows the shape.

### 1. Implement `SoftphoneEngine`

```ts
// packages/engine-native/src/native-engine.ts (new package, v2)
import type {
  EngineListener, EngineStartOptions, SoftphoneEngine,
} from 'sipkit-core';

/** Minimal IPC contract the desktop shell implements (Electron preload / Tauri commands). */
export interface NativeSipBridge {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  onEvent(handler: (evt: { type: string; [k: string]: unknown }) => void): () => void;
}

export class NativeSipEngine implements SoftphoneEngine {
  readonly name = 'native-sip';
  private listener!: EngineListener;
  private off?: () => void;

  constructor(private readonly bridge: NativeSipBridge) {}

  async start({ config, listener }: EngineStartOptions) {
    this.listener = listener;
    this.off = this.bridge.onEvent((e) => this.handle(e));
    await this.bridge.invoke('start', {
      server: config.sipServer, transport: config.sipTransport,
      username: config.username, password: config.password, expires: config.registerExpires,
    });
  }

  private handle(e: { type: string; [k: string]: unknown }) {
    switch (e.type) {
      case 'registration':
        return this.listener.onRegistration({ state: e.state as 'registered' | 'failed', code: e.code as number });
      case 'incoming':
        return this.listener.onIncomingCall(e.id as string, { remoteNumber: e.from as string });
      case 'progress':
        return this.listener.onCallProgress(e.id as string, e.progress as never);
      case 'dtmf':
        return this.listener.onDtmf(e.id as string, e.digit as string);
    }
  }

  async stop() { this.off?.(); await this.bridge.invoke('stop'); }
  register() { return this.bridge.invoke('register').then(() => {}); }
  unregister() { return this.bridge.invoke('unregister').then(() => {}); }
  call(id: string, target: string, o?: { extraHeaders?: string[] }) { return this.bridge.invoke('call', { id, target, headers: o?.extraHeaders }).then(() => {}); }
  answer(id: string) { return this.bridge.invoke('answer', { id }).then(() => {}); }
  reject(id: string, statusCode = 486) { return this.bridge.invoke('reject', { id, statusCode }).then(() => {}); }
  hangup(id: string) { return this.bridge.invoke('hangup', { id }).then(() => {}); }
  setHold(id: string, hold: boolean) { return this.bridge.invoke('hold', { id, hold }).then(() => {}); }
  setMuted(id: string, muted: boolean) { void this.bridge.invoke('mute', { id, muted }); }
  sendDtmf(id: string, tones: string) { return this.bridge.invoke('dtmf', { id, tones }).then(() => {}); }
  blindTransfer(id: string, target: string) { return this.bridge.invoke('refer', { id, target }).then(() => {}); }
  attendedTransfer(id: string, to: string) { return this.bridge.invoke('referReplaces', { id, to }).then(() => {}); }
  getMediaStreams() { return {}; } // media stays native; no browser MediaStreams
}
```

### 2. Rules for engines

| Rule | Why |
|---|---|
| Report facts and never keep UI state. Call `listener.*` only | The orchestrator owns lines, timers, auto-answer and CDRs |
| `engineCallId` is assigned by the orchestrator for outgoing calls and by the engine for incoming ones | Keeps ids stable across layers |
| Map failures to `DisconnectReason` + SIP `code` | The UI and CDRs depend on it |
| Optional capabilities (`forward`, `replaceOutgoingTrack`, `setOutputDevice`) may be left undefined | The orchestrator feature-detects them |
| No `console.*`. Use the injected `logger` | Redaction and log routing |

### 3. Use and test it

```ts
const softphone = createSoftphone({ config, engine: () => new NativeSipEngine(window.nativeSip) });
```

- Unit-test the engine against a fake bridge.
- Run the shared **engine contract tests** (roadmap V1-TEST-02) to prove it behaves like `sipjs-webrtc` for register / call / hold / transfer / DTMF: `runEngineContract({ describe, it, afterEach }, harness)` from `sipkit-core/testing` (see `packages/core/src/testing/engine-contract.ts`).
- Add an e2e job against `infra/asterisk` (UDP endpoints 2001/2002 exist for exactly this).
