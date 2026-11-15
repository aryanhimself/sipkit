# One softphone per browser (V2-EXT-01)

A browser should hold exactly **one** SIP registration for an agent, no matter how many CRM
tabs are open, and reloading or navigating a tab must not drop the registration or a live call.
`sipkit-core` does this with a *remote client* that implements the full `SoftphoneApi`
over a message channel, plus three possible hosts for the real instance.

| Order | Host | Where the instance runs | Transport | When |
|---|---|---|---|---|
| 1 | **Extension host** | sipkit browser extension (Chrome offscreen document, Firefox background page) | `MessagePort` handed over by the content script, then `chrome.runtime` ports | Extension installed and this origin allowed. See [browser-extension.md](browser-extension.md) |
| 2 | **Web host (leader tab)** | One same-origin tab, elected with the Web Locks API | `BroadcastChannel` (other tabs), in-memory loopback (the leader's own UI) | No extension, `navigator.locks` and `BroadcastChannel` available |
| 3 | **Plain local instance** | This tab | none | `instance.mode: 'local'` (the default), or no Web Locks / BroadcastChannel |

```
           ┌──────────── extension installed ────────────┐      ┌──────── no extension ─────────┐
 CRM tab A ─ RemoteSoftphone ─┐                          │      │ tab A (leader, holds lock)    │
 CRM tab B ─ RemoteSoftphone ─┼─► content script ─► extension  │   Softphone (SIP.js, audio)   │
 popup ───── RemoteSoftphone ─┘   (relay)          host: the   │   ▲ loopback   ▲ Broadcast-  │
                                                   ONE instance │   │            │ Channel     │
                                                         │      │ tab A UI     tab B, tab C UI │
                                                         │      │ (RemoteSoftphone everywhere) │
           └─────────────────────────────────────────────┘      └──────────────────────────────┘
```

UIs never know which host they use: `sipkit-ui`, the React hooks and the
`<sipkit-phone>` web component take any `SoftphoneApi`.

## Turning it on

```ts
import { createSharedSoftphone, createSoftphone, callHistoryPlugin } from 'sipkit-core';

const softphone = await createSharedSoftphone({
  config: { ...credentials, instance: { mode: 'shared', preferExtension: true } },
  // Used only when this tab has to host the instance (leader or plain local).
  createLocal: (config) => createSoftphone({ config, plugins: [callHistoryPlugin()] }),
});
// softphone.role: 'extension' | 'leader' | 'client' | 'local'
<Softphone softphone={softphone} />;
```

The web component does the same by itself when `config.instance.mode` is `'shared'`
(default factory). Config (`instance`, all optional):

| Key | Default | Meaning |
|---|---|---|
| `mode` | `'local'` | `'shared'` enables hosts 1 and 2 |
| `preferExtension` | `true` | Try the extension first |
| `extensionTimeoutMs` | `400` | How long to wait for the content script's `ext:ack` (a missing extension costs at most this on page load) |
| `extensionWelcomeTimeoutMs` | `5000` | How long to wait for the extension instance once it answered |
| `channel` | `'sipkit'` | Lock / BroadcastChannel name. Change it to run two independent softphones on one origin |

## The remote client

`RemoteSoftphone` (core, `src/remote/remote-softphone.ts`):

- **Snapshot and events.** The host sends a `welcome` with the current snapshot, the public
  config and recent CDRs, then a `state` message on every change and the softphone events
  (`call:created`, `cdr`, `notification`, …; `log` stays local). `state:changed` is rebuilt
  locally. The first render after a reload already shows the live call: no flicker to
  "unregistered".
- **Commands** become `command` messages with an id; the promise settles with the host's
  `result`. `mute()` / `setActiveCall()` and the other `void` methods are fire-and-forget.
- **Lifecycle.** `start()` does nothing and `stop()` / `disconnect()` only detach: the host owns
  the instance. When the host goes away, pending commands reject with `HOST_UNAVAILABLE` and
  the last snapshot stays on screen until a new host welcomes the client.
- **What cannot cross a channel**: MediaStreams (`getVideoStreams()` returns `{}` except on the
  leader tab), voicemail audio blobs and Web Push. Plugins run where the instance runs;
  `plugin('call-history')` is served from the host's CDRs.

## The host side

`serveSoftphone(api, transport, options)` serves one client. It:

- executes only whitelisted commands (`REMOTE_COMMANDS` in `protocol.ts`: calls, answer,
  hold, mute, DTMF, transfers, conference, DND, chat, devices, voicemail list, …), checks every
  argument, refuses extra arguments and rate-limits (30 commands per second);
- never starts/stops the instance and never exposes `plugin()`;
- sends `publicConfig(config)`: passwords, tokens, TURN credentials, `registerHeaders`,
  `extraHeaders` and callbacks are removed at any depth;
- passes `updateConfig` through `pickProvisioning()` (credentials and transport keys only) and
  then to `options.onUpdateConfig`, so the host decides whether to apply it.

## Web host: leader election

`createSharedSoftphone` (`src/remote/shared.ts`) without an extension:

1. Every tab asks for the Web Lock `<channel>-host`. The first tab gets it and becomes the
   **leader**: it calls `createLocal(config)`, serves its own UI over a loopback transport and
   other tabs over the BroadcastChannel, pings every 2 s and announces itself (`leader` frame).
2. Every other tab stays queued for the lock and is a **client**: it sends `hello` to the
   leader and mirrors it. Frames are addressed by tab id, so each client has its own stream.
3. When the leader reloads or closes it posts `leave` (on `pagehide`) and the browser releases
   its lock. The next queued tab gets the lock, creates the instance and re-registers; clients
   see the `leader` frame (or miss 3 pings) and reattach with the same `RemoteSoftphone`, so
   their UI keeps its state. The reloaded tab comes back as a client.
4. **Credential handover.** Credentials the leader received through `updateConfig` (for
   example the login form) are replicated to the other tabs of the origin (`handover` frame,
   same-origin BroadcastChannel only) so the next leader can sign in again. They never go to
   the extension bridge or across origins.
5. **Reload continuity (V2-RESUME-01, [resume.md](resume.md)).** After creating the instance
   the new leader calls `instance.resume()` (falling back to `start()`). With `resume.enabled`
   the leader's instance always uses `resume.storage: 'local'` (forced by
   `createSharedSoftphone()`), so the anchored-call descriptor is visible to whichever tab
   leads next. When the leader reloads **or closes**, the next leader rejoins the call kept
   on the Asterisk side: same call id and start time, while the caller hears hold music for
   the 1–2 s gap. `registration:resuming` / `call:resumed` are forwarded to every client, so
   all tabs show "Reconnecting…". Descriptors older than `resume.rejoinTimeoutMs` are ignored,
   because by then the PBX has already run its fallback. Without `resume.enabled`, a call held
   by the old leader ends with it (both tabs agree on that).

With a single tab, a reload restores the same way from the stored descriptor. With the
extension, nothing is interrupted at all: the instance never reloads.

## Tests

- `packages/core/src/remote/remote.test.ts`: protocol validation, secret stripping, remote ↔
  host over a loopback (commands, provisioning filter, reattach mid-call keeps the call id,
  host loss), the extension handshake (ack, refusal, late announce, foreign-window messages
  ignored) and leader election with fake Web Locks / BroadcastChannel (one instance, answer
  from a client, takeover).
- `apps/playground/e2e/shared-instance.spec.ts` (mock engine, no extension): two tabs share one
  instance and only the leader creates it; answer in tab B while A leads; A reloads during a
  call, B takes over and A reattaches as a client.
- `apps/extension/e2e/extension.spec.ts`: the extension host, see
  [browser-extension.md](browser-extension.md#tests).

The playground has an **Instance** switch ("This tab" / "Shared") and shows the current role;
`/?instance=shared` selects shared mode from the URL.
