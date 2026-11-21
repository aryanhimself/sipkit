# Browser extension (V2-EXT-01)

`apps/extension` is a Manifest V3 extension for Chrome and Firefox, built from one codebase.
When it is installed **the extension owns the browser's only softphone instance**. Web pages
(the CRM, the playground, any host app) become clients of it, so refreshing, navigating, or
closing and reopening a tab does not change the softphone: registration stays up, a live call
keeps going (audio plays in the extension), and DND / mute / hold stay as they were. Without the
extension, pages fall back to the leader-tab web host or a plain local instance, see
[shared-instance.md](shared-instance.md).

The extension also adds a popup, a toolbar badge, OS notifications with Answer / Decline,
click-to-call (links, context menu, omnibox), keyboard shortcuts and an options page.

## Architecture

```
 Web page (allow-listed origin)                Extension
 ┌──────────────────────────────┐              ┌───────────────────────────────────────────────┐
 │ <Softphone> / hooks / <sipkit-  │              │ Chrome: offscreen document                    │
 │ softphone>                   │              │ Firefox: background page                      │
 │   RemoteSoftphone (core)     │              │  ┌─────────────────────────────────────────┐  │
 │     ▲ MessagePort (private)  │              │  │ the ONE Softphone (SIP.js + WebRTC,     │  │
 └─────┼────────────────────────┘              │  │ audio, ringtone, call-history plugin)   │  │
       │ ext:hello / ext:ack (window, once)    │  │  serveSoftphone() per client            │  │
 ┌─────┴────────────────────────┐ runtime.Port │  └──────▲───────────────▲──────────────────┘  │
 │ content script (isolated     ├──────────────┼─────────┘               │ runtime.Port        │
 │ world, document_start):      │ 'sipkit-client' │                  popup (<Softphone> client)  │
 │ relay + click-to-call        │              │                                               │
 └──────────────────────────────┘              │ Chrome service worker / Firefox background:  │
                                               │ creates + configures the host, approvals,    │
                                               │ badge, notifications, hotkeys, menus, omnibox │
                                               └───────────────────────────────────────────────┘
```

- **Chrome.** MV3 service workers cannot do WebRTC or play audio, and they are stopped when
  idle. The instance therefore lives in an **offscreen document** (`chrome.offscreen`, reasons
  `WEB_RTC`, `USER_MEDIA`, `AUDIO_PLAYBACK`), which is independent of the worker's lifetime. The
  worker only creates it (`ensureHost()`: recreated whenever it is gone, then re-configured, which
  re-registers), passes it the configuration (offscreen documents only have `chrome.runtime`)
  and turns state updates from it into badge / notification changes. Clients connect their
  runtime ports straight to the offscreen document.
- **Firefox.** There are no offscreen documents, and MV3 background pages are event pages.
  The instance runs **in the background page** itself, next to the badge logic. Open client
  ports (content-script relays, the popup) and a live WebRTC session keep it alive in
  practice; when the page is unloaded while idle, the next client or event recreates it and it
  registers again. A call in progress keeps the page busy. If this proves unreliable for a
  deployment, open the popup as a pinned window (notification click does that) to hold it.
- **Pages** use `createSharedSoftphone()` or the web component with
  `instance: { mode: 'shared' }`. The handshake below finds the extension; if it answers, the
  page does **not** create its own UA.
- **The popup** is just another client: the standard `<Softphone>` widget on a
  `RemoteSoftphone` over a runtime port. Several tabs and the popup can be attached at once; all
  mirror the same state and commands from any of them act on the one instance.

### Handshake (page ↔ content script)

1. The page posts `{ ns: 'sipkit/extension', v: 1, type: 'ext:hello', clientId }` on
   its own window, transferring a fresh `MessagePort` (core `connectExtension()`).
2. The content script accepts it only if `event.source === window`, `event.origin` is the page's
   own origin, the shape matches, and the page URL matches the allow-list. It answers `ext:ack`
   (or `ext:refused`) **on the port**, so the page learns within ~10 ms whether the extension is
   there (default timeout 400 ms when it is not).
3. The content script asks the background to make sure the host runs (`sipkit:ensure-host`) and
   connects a runtime port named `sipkit-client`. The host checks the sender (below), and
   `serveSoftphone()` sends the protocol `welcome` with the current snapshot.
4. From then on everything flows over the private port: snapshots and events to the page,
   commands from it. Only messages with the `sipkit/remote` envelope pass the relay, in
   both directions. If the host is replaced (engine switched, offscreen document recreated) the
   relay reconnects and the new `welcome` resyncs the page; if the extension disappears it
   sends `host-bye` and the page detaches.
5. A content script that loads after the page posted its hello announces itself
   (`ext:announce`) and the page retries.

The remote protocol itself (`welcome` / `state` / `event` / `command` / `result`) is described
in [shared-instance.md](shared-instance.md#the-remote-client) and defined in
`packages/core/src/remote/protocol.ts`.

## Credentials and configuration

| What | Where | Readable by |
|---|---|---|
| Engine, server URLs, username, domain, display name, allowed and approved sites, toggles | `chrome.storage.local` (`settings`) | Extension contexts, content script (allow-list / click-to-call only) |
| Password, `registerHeaders` (token auth) | `chrome.storage.session` (`secrets`), access level `TRUSTED_CONTEXTS` | Background, options page. **Not** content scripts, never pages |

Session storage lives in memory and is cleared when the browser closes, so long-term secrets
are never written to disk. Two ways to set the account:

- **Options page** (manual): server, extension, password.
- **Provisioned by the CRM** (recommended): the page calls `updateConfig()` on its remote
  softphone (the login form does this) or `createSharedSoftphone()` re-sends the credentials
  from its config when the extension is not signed in with them. Only `pickProvisioning()` keys
  pass (servers, username, password, `authUsername`, display name, domain, `registerHeaders`,
  transport). The first time an origin provisions, the extension opens a **"Connect this
  site?"** window; until the user allows it the request fails with `APPROVAL_REQUIRED`.
  Approved origins are listed (and removable) in Options. Prefer short-lived tokens through
  `registerHeaders: ['Authorization: Bearer <token>']` (core `registerHeaders`, see
  [architecture.md](architecture.md#security-model)) so the CRM can hand over a fresh token on
  every page load and no password is stored at all.

The snapshot and config sent to clients never contain secrets (`publicConfig()` strips
passwords, tokens, TURN credentials, register / extra headers and callbacks).

### Microphone permission

Offscreen documents and background pages cannot show the permission prompt. The options page
has **Allow microphone**, which asks once for the extension's origin; the instance then uses the
same grant. Do this before the first real call (the mock engine needs no microphone).

## Security and threat model

| Threat | Mitigation |
|---|---|
| A random website attaches and controls or watches the softphone | Content script only on allow-listed match patterns (build-time defaults + user-added, each needing an optional host permission). The host re-checks the **browser-reported** sender origin / tab URL of every runtime port (`isAllowedClient`). Unknown origins get `ext:refused` |
| A website plants credentials (account takeover, toll fraud through our PBX account, or redirecting the agent to a hostile PBX) | Provisioning needs the per-origin "Connect this site" approval; only credential/transport keys are accepted |
| Other frames / windows (iframes, openers) spoof the handshake | `event.source === window` and same-origin checks; traffic then uses a private `MessagePort` instead of window broadcasts |
| Scripts on an allowed page | They run in the same realm as the page's own softphone code and could drive a local instance anyway, so they are inside the trust boundary of that origin. They still cannot read secrets (not in snapshot/config), call non-whitelisted methods, start/stop the instance or flood it (30 commands/s) |
| Other extensions | Their content scripts can see the page's `ext:hello` like any page script; same answer as above. They cannot connect to our runtime ports (`sender.id` check) or read our storage |
| Malformed or hostile messages (from a page or a compromised content-script world) | Every hop validates envelope, type and arguments (`parseClientMessage`, `validateCommand`, `parseHostMessage`); extra arguments are refused; strings are length-limited |
| Click-to-call abuse (a page auto-dials premium numbers) | Only **trusted** (`event.isTrusted`) primary clicks on real `tel:` / `sip:` / `callto:` links are intercepted; numbers are normalised and restricted to digits, `+*#` or a `sip:` address; the setting is off by default |
| Secret leakage to disk or pages | Secrets only in `storage.session` (trusted contexts); config sent to clients stripped; core logger already redacts passwords and auth headers |
| Over-broad permissions | See below; all-site access is optional and requested only when the user turns on click-to-call for every site |

The Firefox build declares `data_collection_permissions: none`: nothing leaves the browser
except SIP/WebRTC traffic to the user's own PBX.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings (`local`) and secrets / badge state (`session`) |
| `offscreen` (Chrome only) | The offscreen document that runs the softphone (WebRTC, getUserMedia, audio) |
| `notifications` | Incoming-call (Answer / Decline on Chrome) and missed-call notifications |
| `contextMenus` | "Call “selection”" on selected numbers and dial links |
| `scripting` | Register the content script on sites the user adds later (and on all sites for click-to-call) instead of asking for every site at install |
| `host_permissions`: build-time `SIPKIT_EXT_ORIGINS` (default `http://localhost/*`, `http://127.0.0.1/*`) | Static content script on the CRM origins so pages can attach at `document_start` |
| `optional_host_permissions`: `*://*/*` | Requested from the options page only for extra CRM origins or for click-to-call on every site |
| `commands` (manifest key) | Answer (`Alt+Shift+A`) and hang up / decline (`Alt+Shift+H`); change them in the browser's shortcut settings |
| `omnibox` (manifest key) | Type `call 5550100` in the address bar |

No `tabs`, `<all_urls>` at install, `webRequest`, `cookies` or remote code. CSP for extension
pages is `script-src 'self'`.

## Features

- **Popup**: the full widget on the extension instance (registration, calls with timer,
  answer / hang up / mute / hold / DTMF / transfer, dialpad, DND, recent calls from the host's
  CDRs, login form for the trusted popup), plus "Open CRM" (`softphoneUrl`) and Options.
  Theme follows the system; language follows the browser (en / ne).
- **Badge**: `RING` (amber) while a call rings, `CALL` (green) in a call, `OFF` (grey) when
  configured but not registered, the missed-call count (red; reset when the popup opens),
  `DND`; empty when not set up. Localised (`_locales`), with a tooltip.
- **Notifications**: incoming call with **Answer / Decline** buttons on Chrome
  (`requireInteraction`); Firefox has no notification buttons, so clicking opens the softphone
  (CRM URL, else the popup in a window). Cleared when the call stops ringing. Missed-call
  notifications from CDRs. Toggle in Options.
- **Click-to-call**: `tel:`, `sip:`, `sips:`, `callto:` links (opt-in), context menu on a
  selection or link, omnibox keyword `call`. All dial on the extension instance; when it is not
  registered yet the number is queued for 60 s and dialled once it is (Options open if nothing
  is configured).
- **Options**: account, engine (SIP over WebRTC, or the mock engine for demos / tests), allowed
  sites, approved sites, CRM URL, click-to-call, notifications, AI noise removal, microphone.
- **Microphone**: the mic belongs to the extension (its offscreen document / background page),
  so permission is granted once on the Options page ("Allow microphone"); it asks only while
  Chrome has not decided. The popup reads the state without prompting; when blocked it says so
  and its "Fix microphone access" / "Allow microphone" buttons open Options
  (`<Softphone microphoneHelp>`).
- **Noise and echo** ([audio.md](audio.md)): the switches in the widget's Settings → Audio
  (noise suppression, voice isolation, echo cancellation, automatic volume) and the dial prefix
  work from the popup and from attached pages. They reach the host as preferences
  (`pickPreferences`, no site approval needed), are saved in the extension settings and survive
  restarts. **AI noise removal** (`sipkit-noise`) runs in the host; switch it in Options. Its
  worklet and wasm ship under `noise/`, and the CSP allows `'wasm-unsafe-eval'` for them.
- **i18n**: extension strings in `public/_locales/{en,ne}`; the widget uses the UI catalogue.

## Building

```sh
pnpm install
pnpm -r --filter "./packages/*" build
pnpm --filter sipkit-extension build:chrome    # dist/chrome + dist/sipkit-chrome-<version>.zip
pnpm --filter sipkit-extension build:firefox   # dist/firefox + dist/sipkit-firefox-<version>.zip
pnpm --filter sipkit-extension lint:firefox    # web-ext lint (0 errors; React's innerHTML warnings remain)
pnpm --filter sipkit-extension test            # unit tests
E2E_PORT=5197 pnpm --filter sipkit-extension test:e2e   # Playwright with the unpacked Chrome extension
```

Build-time environment: `SIPKIT_EXT_ORIGINS` (comma-separated match patterns of the CRM, e.g.
`https://crm.example.com/*`), `SIPKIT_EXT_SOFTPHONE_URL` (the "Open CRM" page),
`SIPKIT_EXT_GECKO_ID` (Firefox add-on id, default `sipkit@sipkit.dev`). CI
(`.github/workflows/extension.yml`) reads them from repository variables and uploads both
zips.

Load unpacked: Chrome → `chrome://extensions` → Developer mode → *Load unpacked* →
`apps/extension/dist/chrome`. Firefox → `about:debugging#/runtime/this-firefox` → *Load
Temporary Add-on* → `apps/extension/dist/firefox/manifest.json`.

## Tests

- Unit (`apps/extension/src/extension.test.ts`): phone-number parsing, match patterns,
  settings sanitising, badge priority, missed-call rule, and the extension host with the mock
  engine over fake runtime ports (welcome, debug helpers, commands, provisioning routing,
  secrets not exposed). Core protocol / remote client / handshake tests are listed in
  [shared-instance.md](shared-instance.md#tests).
- E2E (`apps/extension/e2e/extension.spec.ts`, Chromium new headless with `--load-extension`,
  playground on `E2E_PORT` as the CRM, mock engine **inside the extension**):
  the page attaches (`role = extension`, no local instance); the popup mirrors registration;
  an incoming call shows on the page, in the popup and as the `RING` badge; it is answered from
  the page (`CALL` badge); **the page reloads during the call and the call is still up with the
  same call id and a running timer**; navigating away and back leaves it unchanged; a second
  tab mirrors it and mute there shows everywhere; hang-up syncs page ↔ popup in both
  directions; a `tel:` link on another page dials on the extension instance; and without the
  extension the page falls back to its own instance.

### Firefox: manual test

Automated Firefox coverage is build + `web-ext lint`. Before a release:

1. Load `dist/firefox/manifest.json` as a temporary add-on. Grant the site permission for
   `localhost` when Firefox asks (MV3 host permissions are opt-in in Firefox).
2. Options → engine "Demo (mock engine)", username `1001`, password `secret`, Save.
3. Run the playground (`pnpm dev`), open `http://localhost:5173/?instance=shared`: the role
   chip says `extension` and the pill is Online.
4. Simulate an incoming call: the badge shows `RING`, a notification appears (click opens the
   softphone), answer on the page, reload: the call is still connected with the same timer.
5. Open the popup: it shows the same call; hang up there.
6. Enable click-to-call, open `/click-to-call-demo.html`, click the `tel:` link: the page dials.
7. With a real PBX: switch to SIP over WebRTC, click **Allow microphone**, place a call and
   reload the CRM tab during it.

## Publishing

**Chrome Web Store**

1. Build with production variables (`SIPKIT_EXT_ORIGINS=https://crm.example.com/*`, …):
   `pnpm --filter sipkit-extension build:chrome`. Bump `version` in `apps/extension/package.json` for
   every upload.
2. Developer dashboard → *New item* → upload `dist/sipkit-chrome-<version>.zip`.
3. Listing: name / description from `_locales` (en, ne), screenshots of the popup, privacy
   policy URL. Privacy practices: single purpose "softphone for your CRM"; justify each
   permission with the table above (offscreen: WebRTC + audio for calls; host permissions:
   CRM origins only; optional all-sites: click-to-call). No remote code, no data collection.
4. Prefer *Unlisted* or a private (Google Workspace domain) listing for agents; publish after
   review. Updates: upload a new zip with a higher version.

**Firefox Add-ons (AMO)**

1. `pnpm --filter sipkit-extension build:firefox` (set `SIPKIT_EXT_GECKO_ID` to the id registered on
   AMO, it must never change), then `pnpm --filter sipkit-extension lint:firefox`.
2. Either list it on AMO (developer hub → *Submit a New Add-on* → upload
   `dist/sipkit-firefox-<version>.zip`) or self-distribute: *On your own* channel, AMO
   signs it and returns an `.xpi` for internal deployment (enterprise policies can force-install
   it).
3. AMO asks for source code when bundles are minified: submit the repository archive with
   these build instructions (`pnpm install`, `pnpm -r --filter "./packages/*" build`,
   `pnpm --filter sipkit-extension build:firefox`).
4. Data collection: none (declared in the manifest).

## Limitations

- Video calls are not mirrored to pages (MediaStreams cannot cross a message port); the
  extension instance is audio-first. Voicemail audio playback and Web Push are not available
  to remote clients.
- Page plugins (`hooks.beforeDial`, `onIncomingCall`, custom plugin APIs) do not run on a
  remote client; the extension instance runs `callHistory` (+ ringtone for SIP).
- When the extension is reloaded or updated, open pages lose their host (`host-bye`) and need
  a reload to attach again.
- Firefox background-page lifetime is managed by the browser; see the Firefox note above.
- The default build allows `localhost` only; production builds must set `SIPKIT_EXT_ORIGINS`.
