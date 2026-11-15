# Roadmap

How to read this: every task is small enough to ship on its own (one PR or a few). Estimates:
**S** ≤ 2 days, **M** 3–5 days, **L** 1–2 weeks (one engineer). "Deps" lists task IDs that
must land first. Estimates are planning guesses, not commitments. Re-estimate when a task is picked up.

| Phase | Goal | Exit criteria |
|---|---|---|
| **v1: Core + production** | A production-ready embeddable softphone: registration, calls, transfers, multi-line, UI, web component, security, tests and packaging | All v1 tasks done; packages published on npm |
| **v2: Beyond the core** | Presence, chat, video, voicemail, push, desktop, browser extension and other features | Per-feature |
| **Later** | Nice-to-haves, no committed date | n/a |

Milestones inside v1: **M1 alpha** (CORE, UI core tasks + TEST-03) →
**M2 beta** (+ OBS, SEC-01..04, TEST-04, INFRA-03) → **M3 1.0** (everything else in v1).

---

## v1: Core + production

### Core engine (`packages/core`)

| ID | Title | Description | Acceptance criteria | Est | Deps |
|---|---|---|---|---|---|
| V1-CORE-01 | WSS registration | SIP.js `UserAgent` + `Registerer` over WSS. `registerExpires`, `autoRegister`, `register()/unregister()` | Registers to `infra/asterisk` 1001. 401/403/408 map to `registration.state='failed'` with `code`. Re-registers before expiry | M | none |
| V1-CORE-02 | Call lifecycle | Outgoing/incoming INVITE, ringing, early media (183), connect, hangup/cancel, ring timeout, `rejectOnBusy`, `autoAnswer` + header auto-answer | All `CallState` transitions covered by unit tests. Calls to 600 (echo) and 602 (early media) work against Asterisk. CDR emitted once per call | L | CORE-01 |
| V1-CORE-03 | sip-gateway mode | Finalise how `sipServer`/`sipTransport` reach a gateway (config-only for the Asterisk B2BUA, optional `X-Upstream` header for Kamailio). Document the contract | Browser 1001 → gateway → dev PBX 2001 call works (`infra` gateway profile). Contract documented in architecture.md | M | CORE-02, INFRA-02 |
| V1-CORE-04 | Hold, mute, DTMF | re-INVITE hold/resume (sendonly/inactive), remote-hold detection, mic mute, DTMF RFC 4733 / INFO / auto | Hold plays MOH from Asterisk. DTMF navigates an IVR on Asterisk. Mute stops outgoing audio (verified via getStats bytesSent) | M | CORE-02 |
| V1-CORE-05 | Transfers | Blind (REFER) and attended (REFER with Replaces). `defaultTransferType` | Blind and attended transfer between 1001/1002/2001 succeed in e2e. Failure NOTIFY maps to a notification | M | CORE-02 |
| V1-CORE-06 | Multi-line | Up to `maxLines` (default 2), `setActiveCall`, `autoHoldOtherLines` | Second incoming call while connected rings (or is rejected with `rejectOnBusy`). Switching lines holds/resumes correctly | M | CORE-04 |
| V1-CORE-07 | Reconnect & recovery | WS failover across `websocketUrls`, backoff with jitter, `online`/`offline` events, re-register after reconnect, ICE restart for live calls on network change | Killing Asterisk's WS (or toggling network) recovers registration within the configured delay. Live call survives a Wi-Fi blip ≤ 10 s where the server allows | L | CORE-01 |
| V1-CORE-08 | Audio devices | Enumerate and select mic/speaker/ringer, `setSinkId`, hot-plug handling, persistence | Device change mid-call switches tracks without dropping the call. Unplugged device falls back to default with a notification | M | CORE-02 |
| V1-CORE-09 | Error taxonomy | Stable error codes (e.g. `REG_AUTH_FAILED`, `WS_UNREACHABLE`, `MIC_DENIED`, `ICE_FAILED`, `CALL_REJECTED_486`) on `notification` events | Every failure path in CORE-01..08 emits a coded notification. Table documented in core README | S | CORE-02 |
| V1-CORE-10 | Dialling rules | `normalizeNumbers`, `techPrefix`, `"123,456"` post-dial DTMF, SIP URI passthrough | Unit tests for common prefix cases | S | CORE-02 |
| V1-CORE-11 | Browser policies | Mic permission pre-flight, autoplay unlock for ringtone (user gesture), insecure-context detection | Clear notification when mic is denied or the page is not HTTPS. Ringtone plays after the first click | S | CORE-02 |

### UI (`packages/ui`)

| ID | Title | Description | Acceptance criteria | Est | Deps |
|---|---|---|---|---|---|
| V1-UI-01 | Status & login | Registration indicator, optional login form (for hosts that don't inject credentials) | Shows idle/connecting/registered/failed with reason | S | CORE-01 |
| V1-UI-02 | Dialpad & outgoing | Dialpad, paste/normalise, call button, outgoing call screen | Keyboard dialling works. Ringing/early states shown | M | CORE-02 |
| V1-UI-03 | Incoming call | Incoming card with answer/reject, ringtone, `callInfo` slot | Answer/reject by mouse and keyboard. Ringtone stops on answer, reject or cancel | M | CORE-02 |
| V1-UI-04 | In-call controls | Hold, mute, DTMF keypad, blind/attended transfer dialog, line switcher, timer | All actions reachable within 2 clicks. Matches CORE-04..06 | M | CORE-04, CORE-05, CORE-06 |
| V1-UI-05 | Error UX | Banners/toasts per error code, reconnect countdown, "copy diagnostics", respects `showToasts` | Each CORE-09 code has human text. With `showToasts=false` nothing pops up, but host events still fire | M | CORE-09 |
| V1-UI-06 | Default theme | One polished default theme, configurable brand name | Screenshot review in light and dark | S | UI-02 |
| V1-UI-07 | Accessibility | Keyboard nav, focus traps, ARIA live region for call state, contrast | axe-core has no serious violations in Playwright. Manual screen-reader smoke test | M | UI-04 |
| V1-UI-08 | Web component | `<sipkit-phone>` IIFE bundle, `config`/`slots`/`extensions` properties, attributes for non-secret config only (deprecate the `password` attribute), DOM events, Shadow DOM CSS | Works on a plain HTML page with one script tag. Host CSS does not leak in or out. Using the `password` attribute logs a deprecation warning | M | UI-04 |
| V1-UI-09 | Feature switches | Honour `disabledFeatures` (`PAGE_CONTACTS`, `RECENTS`, `CHAT`, `VIDEO`, `VOICEMAIL`…) | Each listed feature switch hides its surface | S | UI-02 |

### Observability

| ID | Title | Description | Acceptance criteria | Est | Deps |
|---|---|---|---|---|---|
| V1-OBS-01 | Logger + log export | Ring buffer of recent logs, `getLogs()` / "download logs", redaction (see SEC-02) | Support can get the last 30 minutes of logs from an agent in one click. No secrets in the output (test) | M | none |
| V1-OBS-02 | Telemetry events | `telemetry` events: registration latency, call setup time, failure codes, end-of-call quality summary (`getStats`). Host chooses the sink. No PII by default | Dashboard-ready JSON schema documented. Unit tested | M | CORE-02, CORE-09 |
| V1-OBS-03 | Error reporting | Optional adapter for Sentry-compatible reporters (uncaught errors, failed commands) | Disabled by default. Enabling it sends a test event in staging | S | OBS-01 |
| V1-OBS-04 | Server correlation | Send `X-Sipkit-Session-Id` / `X-Sipkit-Call-Id` on REGISTER/INVITE. Document how to find them in Asterisk logs/CEL | One ID traces a call across browser logs and Asterisk | S | CORE-02 |

### Security

| ID | Title | Description | Acceptance criteria | Est | Deps |
|---|---|---|---|---|---|
| V1-SEC-01 | Ephemeral credentials | `credentialsProvider()` in core, re-invoked on 401/expiry. Reference backend snippet (HMAC time-limited password or ARI-created auth) | Works with a 10-minute credential across re-registrations. Long-term password never reaches the browser in the reference flow | M | CORE-01 |
| V1-SEC-02 | Secret redaction | Redact `password`, `Authorization`, digest `response` in logs, events and errors. `traceSip` gated | Unit test: secrets never appear in log sink output, even with `traceSip` | S | OBS-01 |
| V1-SEC-04 | Transport & CSP | Reject `ws://` except localhost. CSP guide. CI check for `eval`/`new Function` in bundles. No secrets via HTML attributes | Config validation test. CSP example works with the web component | S | CORE-01 |
| V1-SEC-05 | Security review | Threat model (credential theft, toll fraud, XSS in host, malicious SIP headers), dependency audit, review of the production WSS endpoint | Findings triaged. All high/critical fixed before 1.0 | M | SEC-01..04, INFRA-03 |
| V1-SEC-06 | Asterisk hardening | Apply the production checklist in `infra/asterisk/README.md` to a production PBX | Checklist signed off. Restricted dialplan context for WebRTC users | M | INFRA-03 |

### Testing

| ID | Title | Description | Acceptance criteria | Est | Deps |
|---|---|---|---|---|---|
| V1-TEST-01 | Core unit coverage | Orchestrator, config, plugins, reducers | ≥ 80% line coverage on `packages/core/src` (excluding the SIP.js adapter), enforced in CI | M | CORE-02 |
| V1-TEST-02 | Engine contract suite | One shared suite run against `FakeEngine` and the SIP.js engine (with Asterisk) | Same suite green on both. Required for any new engine. **Status:** `runEngineContract` in `sipkit-core/testing`; green on `FakeEngine` (loopback network) and on the native engine vs Asterisk (V2-DESK-02). SIP.js run needs a browser runner (open) | M | CORE-05 |
| V1-TEST-03 | Playwright mock e2e | Playground in mock mode: dial, answer, hold, transfer, errors | Runs in CI on every PR in < 5 minutes | M | UI-04 |
| V1-TEST-04 | Real-Asterisk e2e | CI boots `infra/asterisk`. Two browser contexts with fake media register as 1001/1002. Echo, early media, hold, transfer. Both transport modes | Nightly + on demand green. Flake rate < 2% over 2 weeks, then made required. **Status:** 12 specs in `apps/playground/e2e/sip` pass locally (direct and gateway); CI run and flake tracking still open | L | INFRA-02, CORE-05, TEST-03 |
| V1-TEST-05 | Interop matrix | Manual checklist: Chrome, Edge, Firefox, Safari (latest 2) × webrtc/gateway; Zoiper on 2001 | Checklist run and recorded before beta and 1.0 | S | UI-04 |
| V1-TEST-06 | Soak test | 8 h registered with a call every 5 min against Asterisk. Watch memory and listener leaks | Heap growth < 10%. No missed re-registrations | M | TEST-04 |

### Packaging & release

| ID | Title | Description | Acceptance criteria | Est | Deps |
|---|---|---|---|---|---|
| V1-PKG-01 | Versioning | Changesets, semver policy (types.ts/plugin.ts = public API), changelogs | `pnpm changeset` in CONTRIBUTING. Version PR automation. **Status: done** (Changesets + `.github/workflows/release.yml`) | S | none |
| V1-PKG-02 | Size budgets | `size-limit` (or similar) budgets per bundle, checked in CI | Core < 120 KB gz (SIP.js included), web component < 300 KB gz | S | UI-08 |
| V1-PKG-03 | Self-hosted builds | Versioned, immutable paths for the web component (`/softphone/1.2.3/…`), SRI hashes | A host can pin a version. Rollback by changing one path | S | UI-08 |
| V1-PKG-04 | Release pipeline | Changesets version PR → build → test → publish to npm with provenance | One-command release, reproducible from tag | M | PKG-01 |

### Infrastructure

| ID | Title | Description | Acceptance criteria | Est | Deps |
|---|---|---|---|---|---|
| V1-INFRA-01 | Dev PBX | `infra/asterisk` compose: WSS + UDP endpoints, echo, MOH, queue | **Done** (this repo): `docker compose up` registers 1001 over WSS | S | none |
| V1-INFRA-02 | Gateway profile verified | End-to-end call browser → gateway → dev PBX → Zoiper and back | Documented and scripted smoke test | S | INFRA-01 |
| V1-INFRA-03 | Production WebRTC on Asterisk (reference setup) | Real certificate, `http.conf` TLS, `transport-wss`, agent endpoints `webrtc=yes`, firewall | A staging agent registers over WSS from the office network and from outside | M | none |
| V1-INFRA-04 | TURN service | coturn with `use-auth-secret`, TLS on 443 for strict networks, credential minting endpoint | Calls succeed with UDP blocked (forced relay test) | M | INFRA-03, SEC-01 |

### Documentation

| ID | Title | Description | Acceptance criteria | Est | Deps |
|---|---|---|---|---|---|
| V1-DOC-01 | Support runbook | Troubleshooting: certificate errors, mic permission, NAT/TURN, registration codes, how to collect logs | Support team walkthrough done | S | UI-05, OBS-01 |

---

## v2: Beyond the core

| ID | Title | Description | Acceptance criteria | Est | Deps |
|---|---|---|---|---|---|
| V2-HIST-01 | Call history | Recents UI on the existing `call-history` plugin, optional server sync from CDRs | Last 100 calls, redial, filter missed | M | v1 |
| V2-CONT-01 | Contacts | Contact provider interface (CRM-backed), search, click-to-dial | Contacts from a CRM endpoint searchable in < 200 ms | M | v1 |
| V2-PRES-01 | Presence | SUBSCRIBE/NOTIFY presence (Asterisk hints / `presence` package), own status | Status of 50 colleagues updates within 2 s. **Status: done.** Core `presence` config (opt-in, `watch`, `events` dialog/presence, throttled SUBSCRIBE queue: 50 targets in ~1 s), PIDF + dialog-info parsers, backoff (489 never retried, 403/404 slow), resubscribe on re-register, `snapshot.presence`, `presence:changed`, `watch()`/`unwatch()`, `usePresence()`. Own status is DND-based (Asterisk has no endpoint PUBLISH), see [presence.md](presence.md) | M | V2-CONT-01 |
| V2-BLF-01 | BLF | `dialog` event package subscriptions, BLF grid, pickup | Busy/ringing/idle lamps match Asterisk device state. **Status: done.** RFC 4235 dialog subscriptions via SIP.js `Subscriber`, ringing caller from `<remote>`, held via `+sip.rendering`, `pickup()` (`**<ext>` → `PickupChan`), Lamps tab (`BlfPanel`) + contact lamps, mock e2e, real-SIP spec `presence.spec.ts` (idle/busy/ringing + directed pickup), dev PBX pattern hints + 1003 | M | V2-PRES-01 |
| V2-VM-01 | MWI | `message-summary` subscription, voicemail badge, one-click dial to voicemail | Badge count matches Asterisk mailbox. **Status: done.** Core `voicemail` config, RFC 3842 parser, SIP.js `Subscriber` + unsolicited NOTIFY, `snapshot.voicemail`, `voicemail:updated`, `callVoicemail()`, `useVoicemail()`, header `VoicemailBadge`, dev PBX mailboxes (`*97`, `8XXXX`), real-SIP spec `voicemail-dnd.spec.ts` | S | v1 |
| V2-VM-02 | Voicemail list | List and play voicemails through a backend API (ARI/filesystem) | Play, delete, mark read. **Status: done**, see [voicemail.md](voicemail.md). `services/voicemail-api` (Node 22, no runtime deps) over the app_voicemail spool: list, audio with Range, mark read (INBOX→Old with Asterisk-compatible `.lock` + renumbering), delete, path-traversal safe, bearer auth (HMAC short-lived per-mailbox tokens for the CRM, static, dev), CORS allow-list, AMI `VoicemailRefresh` so MWI drops at once (pollmailboxes fallback), Dockerfile + compose profile `voicemail`. Core opt-in `voicemail.api` (`token` / `getToken`), `VoicemailClient`, `snapshot.voicemailList`, `voicemail:list`, auto reload on MWI change, `useVoicemailList()` / `useVoicemailPlayer()`, Voicemail tab (play, mark heard, call back, delete with confirm, en + ne), mock backend + mock e2e, real-SIP `voicemail-list.spec.ts` | M | V2-VM-01 |
| V2-REC-01 | Server-side recording | Start/stop recording through the backend (ARI/AMI `MixMonitor`), call action button, retention policy | Recording stored server side. Agent sees state. No audio stored in the browser | M | v1 |
| V2-VID-01 | Video calls | 1:1 video (VP8/H.264), camera selection, layout | Video between two browsers and to a video-capable SIP phone. **Status: done** for browser↔browser and echo, see [video.md](video.md): opt-in `video: { enabled, defaultOn, constraints }`, `call(n, { video })`, `answer(id, { video })`, `setVideo()` (camera on/off by track swap, audio→video upgrade by one re-INVITE), `getVideoStreams()` outside the snapshot, `call.hasVideo / cameraOn / remoteVideo`, `call:video`, camera kind in the device manager, `call.quality.video`, conferences audio-only, `useCallVideo()`, call-screen video view + camera toggle, dialpad Video call, incoming answer with video / audio only, camera picker, en+ne, mock synthetic canvas video + `video.spec.ts`, Asterisk `vp8,h264` + `bundle`, real-SIP `e2e/sip/video.spec.ts`. Desk-phone video not tested | L | v1 |
| V2-CHAT-01 | Chat (SIP MESSAGE) | 1:1 messaging, unread counts, history via plugin storage | Messages between 1001 and 1002 through Asterisk `res_pjsip_messaging`. **Status:** done, see [chat.md](chat.md). Opt-in `chat` config, SIP.js `Messager` + UserAgent `onMessage`, `text/plain`, delivery status `sending → sent/failed` from the final response plus PBX delivery reports (`X-Sipkit-Delivery`) for offline users, conversations by peer, unread + `markConversationRead()`, `snapshot.chat`, `message:received` / `message:status` / `conversation:read`, pluggable `ChatHistoryStorage` (memory default, localStorage with `chat.persist`), `useChat()` / `useConversation()`, Chat tab with unread badge + contact Message action (en + ne), mock engine + mock e2e, dev PBX `[messages]` context, real-SIP spec `chat.spec.ts`. No typing indicators, read receipts or server-side history | M | v1 |
| V2-QOS-01 | Call quality stats | Periodic `getStats` → quality event (jitter, loss, RTT, MOS estimate), UI quality indicator, telemetry | Indicator degrades under simulated loss (tc/netem in CI). **Status:** done, see [call-quality.md](call-quality.md). `call:quality` + `call.quality` + `cdr.quality` summary, `callQualityInterval` (default 2 s), signal-bars indicator. Unit + mock e2e cover degradation; `e2e/sip/quality.spec.ts` checks a real echo call is `good` and (opt-in `E2E_NETEM=1`) that tc/netem loss turns it `poor`, passing locally. Netem run not yet in CI | M | V1-OBS-02 |
| V2-PUSH-01 | Push for incoming calls | Self-hosted Web Push (VAPID) + backend hook on Asterisk incoming call to wake or notify a closed tab. No vendor Firebase project | Agent with the tab closed gets a notification and can answer after opening. **Status: done.** `services/push` (Node 22 + `web-push`: per-extension subscriptions in a JSON/pluggable store, HMAC agent tokens + dev token, `/notify/incoming` + `/notify/cancel`, 404/410 pruning, signed Decline, VAPID key endpoint, Dockerfile, compose profile `push`), dialplan `[sipkit-push]` (async notify, ring until the agent registers, `X-Sipkit-Push-Id`, decline = busy), core `push` config + `snapshot.push` + `subscribePush()` / `unsubscribePush()` + `push:changed` / `push:action` + deep-link auto-answer, service worker `sipkit-ui/sipkit-push-sw.js`, `usePush()`, settings switch + permission prompt (en/ne), mock + playground controls, e2e (real service worker + encrypted push via a fake push endpoint) and real-SIP spec. See [push.md](push.md) (FCM delivery itself is checked manually) | L | v1 |
| V2-DESK-01 | Desktop shell | Tauri (preferred) or Electron app embedding `sipkit-ui`, auto-update, tray | Signed installers for Windows/macOS. Auto-update works. **Status: done** (Electron, [ADR 0008](adr/0008-electron-desktop-shell.md)), see [desktop.md](desktop.md): `apps/desktop` (electron-vite), first-run setup with the password in the OS keychain (`safeStorage`), sandboxed renderer + strict CSP + validated IPC, tray status (registered / DND / ringing / in call), close-to-tray, single-instance lock, electron-updater on a generic feed (`SIPKIT_UPDATE_URL`, no-op in dev), electron-builder dmg+zip (hardened runtime, notarization from env) and NSIS, CI workflow `desktop.yml` building unsigned artifacts on macOS + Windows, `EngineBridge` / `registerNativeEngineHost()` hook for DESK-02, Playwright `_electron` e2e (mock engine, also against the packaged app; opt-in real-PBX spec). Signed release builds need the certificates and Apple credentials configured as CI secrets; auto-update not yet exercised against a live feed | L | v1 |
| V2-DESK-02 | Native SIP engine | `SoftphoneEngine` over a native SIP stack via IPC (plain SIP/UDP/TLS, no gateway) | Passes V1-TEST-02 contract suite against UDP endpoints 2001/2002. **Status: done.** `sipkit-engine-native` (baresip sidecar over IPC, [native-engine.md](native-engine.md), ADR 0009) passes the contract vs Asterisk 2001/2002 over UDP (`pnpm --filter sipkit-engine-native test:contract`). Per-OS baresip bundling in the desktop app and attended transfer are follow-ups | L | V2-DESK-01 |
| V2-DESK-03 | Desktop integrations | Global hotkeys (answer/hangup), OS notifications, `tel:`/`sip:` URL handler | Hotkeys work while the app is in the background. **Status: done**, see [desktop.md](desktop.md): configurable `globalShortcut` hotkeys (answer, hang up/decline, optional mute and DND) validated by `shared/hotkeys.ts`, incoming-call notifications with Answer/Decline (macOS action + close button, Windows toast buttons via `sipkit://` URLs) and missed-call notifications (from CDRs, incl. DND), `tel:` / `sip:` / `sips:` / `callto:` handler via `open-url` and `second-instance` argv (`shared/dial-url.ts`). Unit tests + e2e drive the hotkey path through IPC (a real key press cannot be synthesised headless) | M | V2-DESK-01 |
| V2-I18N-01 | i18n | Message catalogue, locale switch, RTL-safe layout. First extra language: Nepali | All UI strings externalised. Second locale complete. **Status:** done, see [i18n.md](i18n.md). Typed catalogue (`en.ts` source of truth, `ne.ts` complete, missing/extra keys fail typecheck), dependency-free ICU-lite formatter (`Intl.PluralRules`), `useT()`/`useI18n()`, Intl number/duration/date formatting, `locale` + `messages` props, reactive `locale` attribute, `registerLocale()`, fallback `ne-NP → ne → en`, Settings language picker, core end reasons / error codes / notification codes mapped. Logical (RTL-safe) classes, pseudo RTL locale, guard test against hard-coded strings, mock e2e. **Nepali strings await native-speaker review** | M | v1 |
| V2-THEME-01 | Theming | Documented token set, dark mode, host-provided themes at runtime | Host can restyle without rebuilding. Contrast checks pass. **Status:** done ([theming.md](theming.md)): token source of truth `ui/src/theme/tokens.ts` generating the `styles.css` block (light + dark for every token, new `call-accept` / `call-end` / `overlay`), `theme` light/dark/system (live `prefers-color-scheme`), runtime `themeTokens` prop / `theme-tokens` attribute / `--sipkit-*` + `--sipkit-dark-*` CSS variables, WCAG contrast unit test for both themes, playground switcher + custom brand, Playwright theming spec | S | v1 |
| V2-CONF-01 | Conference UI | UI for the core local conference mixer (or Asterisk ConfBridge) | 3-party call with mute/remove per party. **Status:** done for the local mixer: core `removeFromConference` / `splitConference` / `setPartyMuted`, `ConferencePanel` in `sipkit-ui` (roster, timers, per-party mute/remove/hang up, Split, End conference), real-Asterisk remove/split specs. **ConfBridge done** (server mode, see [server-features.md](server-features.md)): `conference.mode: 'server'` joins room `7<ext>` as owner and REFERs every party in, roster + `capabilities` on the room leg, `getConferenceView()` / `useConference()`, panel driven by capabilities (no per-party control in server mode), dev PBX `confbridge.conf` + `_7XXXX`, real-SIP spec (room survives the agent leaving) | M | v1 |
| V2-FWD-01 | Forward & DND | Redirect (302) unanswered calls, DND toggle (reject 486 or server-side) | Forwarded call reaches target. DND state visible. **Status:** forward (302, `forward()`) existed; **DND done**: `setDnd()`, `snapshot.dnd`, `dnd:changed`, auto-reject (`dnd.rejectCode`, default 486) with a `dnd` CDR, opt-in persistence, header `DndToggle` + settings switch, real-SIP spec. **Server-side DND done** ([server-features.md](server-features.md)): `dnd.mode` 'server' / 'both' dials `*78` / `*79` as silent service calls (no UI, no CDR), astdb `DND/<ext>` + `Custom:DND<ext>`, extension routes answer 486, revert + `dndServerFailed` on failure, `dndPending`, re-apply or `*76` query on register, real-SIP spec (busy with the tab closed) | S | v1 |
| V2-RESUME-01 | Reload-safe softphone | A reload / navigation keeps registration, DND, mute/hold and the active call (server-anchored) | Reload during a call: same call back with the same id and timer, caller never gets a BYE. **Status: done** (single page), see [resume.md](resume.md): opt-in `resume: { enabled, rejoinTimeoutMs, rejoinPrefix, endPrefix, rejoinCallTimeout, storage }`, stable `+sip.instance` per profile, Contact `;sipkit-resume=<s>` / `X-Sipkit-Anchor`, dev dialplan `[sipkit-anchor*]` (per-call ConfBridge room, music on hold while the agent is away, `*85` rejoin / `*86` end, voicemail-else-hangup fallback after the timeout) in PBX and gateway, a dead-leg watcher (contact gone → hang the leg up), descriptor in sessionStorage, `resume()` / `exportResumeState()` for the leader-tab host, `snapshot.resume`, `call.anchorId` / `resuming`, `registration:resuming` / `call:resumed`, "Reconnecting…" pill + "Reconnecting call…" banner (en + ne), MockSoftphone + playground toggle, unit + mock e2e + real-SIP spec (also via the gateway). Anchored calls are audio-only and not transferable; queue calls are not anchored yet | L | V2-CONF-01 |
| V2-EXT-01 | Browser extension + shared instance | One softphone per browser: the Chrome/Firefox extension hosts the instance (offscreen document / background page) and pages are remote clients; without the extension one leader tab hosts it for the others | Reloading, navigating or closing the CRM tab keeps registration, calls, DND and mute. Several tabs and the popup mirror one instance. Page falls back to a local instance without the extension. **Status: done** ([browser-extension.md](browser-extension.md), [shared-instance.md](shared-instance.md)): core `RemoteSoftphone` (full `SoftphoneApi` over a `RemoteTransport`), `serveSoftphone()` host with command whitelist + secret stripping, `connectExtension()` MessagePort handshake, web leader election (Web Locks + BroadcastChannel, credential handover, `resume()` hook), opt-in `instance: { mode: 'shared', preferExtension }`, `createSharedSoftphone()`, web component default factory; `apps/extension` (MV3, Chrome offscreen host, Firefox background host, popup = `<Softphone>` client, badge, Answer/Decline notifications, hotkeys, tel:/sip:/callto: + context menu + omnibox click-to-call, options, per-site "connect this site" approval, secrets in `storage.session`, en + ne `_locales`), zips for both browsers + `web-ext lint`, CI `extension.yml`, unit tests, Playwright e2e with the unpacked extension (reload mid-call keeps the call id) and without it (leader handover). Store submission, Firefox manual test pass and real-PBX run pending | L | v1 |

## Later (unscheduled)

Multi-account registration · screen sharing · file transfer · click-to-call / linkify widget ·
JsSIP engine (if SIP.js maintenance stalls) · mobile wrapper (Capacitor) · E2E media
encryption beyond DTLS-SRTP (insertable streams).

---

## Test strategy

| Level | Tooling | Scope | Runs |
|---|---|---|---|
| Static | `tsc --noEmit` (strict), ESLint, Prettier | All packages | Every PR |
| Unit | Vitest + `FakeEngine`, `createTestSoftphone()`, happy-dom/jsdom | Core orchestrator, config, plugins, React hooks, UI components (Testing Library) | Every PR |
| Contract | Shared engine suite (V1-TEST-02) | Engines behave the same | Every PR (fake), nightly (real) |
| E2E mock | Playwright against `apps/playground` in mock mode | User flows, error UX, accessibility (axe) | Every PR |
| E2E real SIP | Playwright + Chromium `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` against `infra/asterisk` (both profiles) | Register, call 600/602, browser↔browser, hold/MOH, transfer, reconnect | Nightly + manual dispatch; required after stabilisation |
| Interop | Manual checklist (V1-TEST-05): browsers × modes, Zoiper on UDP 2001 | Real devices, real headsets | Before each minor release |
| Soak / resilience | Long-running script (V1-TEST-06), network toggling, Asterisk restart | Leaks, re-registration, recovery | Before 1.0, then monthly |
| Security | `pnpm audit`, dependency review, secret-redaction tests, V1-SEC-05 review | Supply chain, credential handling | Every PR (audit), before 1.0 (review) |

Rules: every bug fix comes with a test that fails before the fix. Every new public API comes with
unit tests and a docs update. E2E tests use the dev PBX accounts only (never production
credentials).
