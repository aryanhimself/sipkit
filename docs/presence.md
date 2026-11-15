# Presence and busy lamp field (BLF)

Roadmap: **V2-PRES-01** (presence) and **V2-BLF-01** (BLF grid, pickup).

The softphone can watch colleagues' extensions and show a lamp per extension:

| State | Meaning | Lamp |
|---|---|---|
| `idle` | Registered, no call | green |
| `ringing` | An incoming call is ringing there. Pick it up with `pickup()` | amber, blinking (steady when the user prefers reduced motion) |
| `busy` | On a call or dialing out | red |
| `held` | Every call there is on hold (when the server reports it) | hollow red |
| `unavailable` | Offline (PIDF `closed`, needs the `presence` package) | hollow grey |
| `unknown` | Not subscribed yet, not registered, or the server refused the SUBSCRIBE | grey |

The UI never shows the state by colour alone. BLF tiles and contact rows print the state as text
("Busy", "Ringing · Jane"), and lamps carry a hidden label.

## How it works

For each watched extension, core sends one `SUBSCRIBE` per configured event package, using the
SIP.js `Subscriber` (the same way as MWI in `engines/sipjs/mwi.ts`):

- **`dialog`** (RFC 4235, `application/dialog-info+xml`, the default). Asterisk generates it from the
  extension's **hint**. `early` + `direction="recipient"` means ringing, and the `<remote>`
  identity names the caller. `early` + `initiator` means dialing out, shown as busy.
  `confirmed` means busy, and `confirmed` with `+sip.rendering="no"` on the local target means held.
  `terminated`, or no dialog at all, means idle. If there are several dialogs, ringing beats busy,
  so a ringing line can still be picked up.
- **`presence`** (RFC 3863 PIDF, optional). `closed` means unavailable. The RPID `on-the-phone`
  activity means busy, and the notes "Ringing" and "On hold" mean ringing and held. When both
  packages are on, call activity from `dialog` wins. PIDF adds `unavailable` and the note.

Parsing is regex-based and has no dependencies (no `DOMParser`), so it also works in workers and
Node. It accepts any namespace prefix and never throws. See `parseDialogInfo()` / `parsePidf()`
(exported from `sipkit-core`).

Lifecycle (`internal/presence.ts`):

- Subscriptions start when registration is established. They are dropped when registration is lost,
  and the lamps go `unknown`. Every target is subscribed again after re-registration.
- **Throttle.** Initial SUBSCRIBEs are queued and sent one every `subscribeIntervalMs`
  (default 20 ms), so 50 lamps take about 1 s. Each one updates as soon as its first NOTIFY arrives.
- **Refresh.** SIP.js re-SUBSCRIBEs at 90 % of the granted `Expires`. If the server ends a
  subscription with `deactivated` or `timeout`, SIP.js resubscribes on its own.
- **Failures.** A terminated or refused subscription sets the lamp to `unknown` and records
  `errorCode` (for example 403 or 404). Transient failures are retried with exponential backoff
  (5 s, 10 s, … up to 5 min). Hard failures (403, 404, 405, 488, 501, 603) are retried every 5 min.
  **489 Bad Event** (the package is not supported) is never retried.

## Config

```ts
createSoftphone({
  config: {
    // ...
    presence: {
      enabled: true,                 // opt-in (default false)
      watch: ['1001', '1002', '2001'], // initial watch list (user or SIP URI)
      events: ['dialog'],            // and/or 'presence'
      expires: 600,                  // SUBSCRIBE Expires (s)
      subscribeIntervalMs: 20,       // throttle between initial SUBSCRIBEs
      maxWatched: 200,
      pickupPrefix: '**',            // directed pickup feature code
    },
  },
});
```

`updateConfig({ presence: { ... } })` applies changes live. Watching starts or stops, targets
removed from `watch` are unsubscribed, and `enabled: false` clears everything.
`disabledFeatures: ['presence']` hides the UI. The core keeps working.

## API

```ts
softphone.watch(['1003', '1004']);   // runtime additions (needs presence.enabled)
softphone.unwatch('1003');
await softphone.pickup('1002');      // dials pickupPrefix + extension, e.g. **1002
softphone.getSnapshot().presence;    // Record<target, PresenceInfo>
softphone.on('presence:changed', ({ target, presence, previous }) => { /* presence undefined = unwatched */ });
```

`PresenceInfo`: `{ target, state, remoteNumber?, remoteDisplayName?, direction?, note?, errorCode?, updatedAt }`.

Engines opt in through `subscribePresence(target, event, expires)` / `unsubscribePresence()` and
report results with `EngineListener.onPresence()`. If an engine has neither method, every lamp
stays `unknown`.

## React and UI

- `usePresence()` returns `{ enabled, presence, list, own, watch, unwatch, pickup }`.
  `usePresenceOf(target)` returns one extension and re-renders only when it changes.
- `<Softphone>` adds a **Lamps** tab (`BlfPanel`) when presence is enabled: a two-column grid,
  click a tile to call, and a **Pick up** button on ringing tiles. Contacts whose number is watched
  get a lamp and the state text in the contacts list.
- `PresenceLamp`, `BlfPanel`, `presenceDescription()`, `presenceStateLabel()` are exported for
  hosts. Strings are in the i18n catalogue (`presence.*`, `blf.*`, `tab.blf`, en and ne). Colours
  come from the theme tokens `success`, `warning`, `destructive` and `muted-foreground`.

Mock engine: `MockSoftphone` reports watched extensions as `idle` once registered, and
`simulatePresence('1002', 'ringing', { remoteNumber })` drives a lamp. In the playground's mock
controls, the "BLF 1002" buttons drive the lamp for 1002. `FakeEngine.simulatePresence(target, xmlOrReport)` /
`simulatePresenceTerminated(target, code)` are for core tests.

## Own status

Asterisk does **not** accept presence `PUBLISH` from endpoints. `res_pjsip_publish_asterisk` only
does Asterisk-to-Asterisk publishing. So the client cannot publish "away" or "busy". Own status is
therefore **DND-based only**: `usePresence().own` is `'dnd' | 'available'`, from `setDnd()`.

What colleagues see for you comes from your **device state** (registered, ringing, in use). That
is server side. If you need a real "away / DND" lamp for others, set it in the dialplan with
`CustomPresence:<ext>` / `PRESENCE_STATE()` or a `Custom:` device in the hint
(`exten => 1001,hint,PJSIP/1001&Custom:DND1001`), toggled by a feature code such as `*76`.
`PRESENCE_STATE` is then reported in PIDF / dialog. This is not implemented in the dev PBX.

## Asterisk setup (dev PBX)

`infra/asterisk/config/pbx`:

- `extensions.conf`: pattern hints `exten => _1XXX,hint,PJSIP/${EXTEN}` and `_2XXX` in
  `from-internal`, so any extension can be watched (dynamic hints are created on SUBSCRIBE).
  Production systems usually list explicit hints per extension.
- Directed pickup: `exten => _**X.,1,PickupChan(PJSIP/${EXTEN:2}-,p)` picks up the channel ringing
  at that extension. FreePBX uses `**` too. Change `presence.pickupPrefix` if your PBX uses something
  else (for example `*8` for group pickup with `namedpickupgroup`).
- `pjsip.conf.tmpl`: `allow_subscribe=yes`, `subscribe_context=from-internal` on both endpoint
  templates. There is a third WebRTC user, **1003**, for three-party BLF and pickup tests.
- The modules `res_pjsip_exten_state`, `res_pjsip_dialog_info_body_generator` and
  `res_pjsip_pidf_body_generator` are autoloaded.

Checks: `asterisk -rx "core show hints"` lists watchers, and `pjsip show subscriptions inbound` lists the subscriptions.

## Tests

- Core: `packages/core/src/__tests__/softphone.presence.test.ts` (parsers with Asterisk bodies,
  throttling of 50 targets, backoff and 489, re-register, config changes, pickup) and
  `engines/sipjs/presence.test.ts`.
- React and UI: `hooks/presence.test.tsx`, `features/presence/presence.test.tsx`.
- Mock e2e: `apps/playground/e2e/presence.spec.ts`.
- Real SIP: `apps/playground/e2e/sip/presence.spec.ts`. 1002 watches 1001. In the first test, 1001
  calls 600 (busy), then hangs up (idle). In the second, 1003 calls 1001 (ringing with the caller),
  and 1002 picks it up with `**1001`.
