# Reload-safe softphone (V2-RESUME-01)

A page reload, a navigation inside the CRM or a crashed renderer must not change the phone's
status: registration, DND, mute, hold and, above all, an **active call** come back by
themselves. This page covers the **single page** case inside `sipkit-core`. The
multi-tab side (extension host, leader tab over Web Locks + BroadcastChannel) is built on top of
it and calls the same `resume()` step (see [Leader-tab takeover](#leader-tab-takeover)).

## Why the server has to hold the call

The browser's `RTCPeerConnection` and WebSocket die with the page. Nothing in the browser can keep
a call alive across a reload, so the call is **anchored on the PBX**: instead of bridging the
caller straight to the agent, Asterisk puts both legs in a two-party ConfBridge room. When the
agent's leg disappears the caller stays in the room (music on hold), and the reloaded page dials
back into the same room.

| Option | Verdict |
|---|---|
| **Per-call ConfBridge room (chosen)** | Needs only dialplan (`app_confbridge`, already used by V2-CONF-01). The room does not care how many agent legs come and go, so a dead leg that Asterisk has not noticed yet is harmless: the new leg joins next to it and the caller hears the agent again at once. Costs a mixer per call (2 parties, 20 ms) and makes anchored calls audio-only |
| Park / retrieve | Parking needs a transfer from a live agent leg at the moment it drops. A page that is unloading cannot send one |
| `Dial` + `Bridge()` / `F()` tricks | The caller is stuck bridged to the dead leg until Asterisk notices it; moving it out needs exact channel names; fragile |
| ARI (Stasis app) | The most flexible and the right choice if you already run an ARI backend: a holding bridge per call, explicit rejoin/end REST calls, timers in code. Needs a service the browser does not have today. The dialplan below maps 1:1 onto it (holding bridge = room, `*85`/`*86` = REST calls) |

## What the client does

```ts
createSoftphone({
  config: {
    resume: {
      enabled: true,          // opt in (default false)
      rejoinTimeoutMs: 30000, // how long the PBX keeps the caller waiting (5 s .. 5 min)
      rejoinPrefix: '*85',    // dev dialplan feature codes
      endPrefix: '*86',
      rejoinCallTimeout: 10,  // s to wait for the *85 call to answer
      storage: 'session',     // 'session' (this tab) | 'local' (shared by the profile's tabs)
    },
  },
});
```

### Registration continuity

- **Stable instance.** A UUID per browser profile is kept in the softphone storage
  (`sipkit:core:instanceId`, localStorage). The SIP.js engine sends it as
  `+sip.instance="<urn:uuid:…>"` on every Contact (RFC 5626), so registrars that honour it replace
  the old contact instead of adding one.
- **Asterisk contacts.** Asterisk 20 does not match on `+sip.instance`, but it deletes a contact
  as soon as the WebSocket it was registered over closes (the registrar's transport monitor), and
  the dev AORs use `max_contacts=5` + `remove_existing=yes`, so the oldest contact is replaced
  when the limit is reached (no stale contact was left behind in the real-SIP runs). No dev
  config change was needed; keep `remove_existing=yes` on production AORs.
- **No unregister on `pagehide`.** Core never unregisters or hangs up on `pagehide` (it only
  refreshes the stored descriptor). An explicit `stop()` / `unregister()` is a real sign-out:
  calls are hung up for real and the descriptor is deleted.
- **On load** `start()` reads the descriptor, puts `snapshot.resume = { state: 'resuming' }`,
  emits `registration:resuming` and registers at once. The UI shows **Reconnecting…** in the
  registration pill instead of Offline/Connecting until registration is back.
- **DND** is persisted while resume is on (as with `dnd.persist`). Devices and volumes were
  already persisted. Mute and hold are per call and come back with the call.

### Call continuity

1. Resume on, the Contact also carries `;sipkit-resume=<rejoinTimeoutMs / 1000>`. The PBX anchors
   every call it rings to that contact and sends the room id to the browser as
   `X-Sipkit-Anchor: <digits>` on the INVITE. Outgoing calls carry `X-Sipkit-Anchor: <16 random digits>`
   and `X-Sipkit-Anchor-Timeout: <s>`. The id lands on `call.anchorId`.
2. Every call change rewrites the descriptor (`sipkit:resume` in sessionStorage):
   `{ version, savedAt, username, activeCallId, calls: [{ id, anchorId, line, direction,
   remoteNumber, remoteDisplayName, createdAt, connectedAt, muted, held, … }] }`.
3. After a reload, `start()` recreates each call in the snapshot **with the same `id`, line,
   `createdAt` and `connectedAt`** (so the call timer simply continues), `resuming: true`, its
   mute and hold state. The call screen shows a **Reconnecting call…** banner (en + ne).
4. Once registered, core dials `*85<anchor>` on the engine id of that call. When it answers,
   `resuming` is cleared, mute and hold are re-applied to the new media and `call:resumed`
   fires. The caller heard silence (dead leg still in the room) or music on hold for the
   1–2 s gap, never a hangup.
5. If the anchor is gone (`*85` answered 404: the caller hung up or the fallback ran), the rejoin
   times out, or the descriptor is older than `rejoinTimeoutMs`, the call ends with reason
   `failed` and a `callResumeFailed` notification.
6. A **real hangup** (`hangup()`, `hangupAll()`, `stop()`, also while still reconnecting) sends
   the BYE and dials `*86<anchor>` silently (a service call, like server DND), which ends the
   room and the caller's leg. A remote hangup ends the room from the PBX side.

While a call is reconnecting `hold()` throws `INVALID_STATE` (no media yet); `mute()` is
remembered and applied on rejoin. **Transfers and server-conference merges of anchored calls
throw `NOT_SUPPORTED`** (a REFER from a ConfBridge member would leave the caller waiting for an
agent that is not coming back). The local conference mixer still works but is not restored after
a reload: each call comes back on its own line. Anchored calls are audio-only.

### API, events, snapshot

| | |
|---|---|
| `softphone.resume(state?)` | Start if needed (so it can replace `start()`, which restores this page's descriptor), then restore `state` if given. Without `resume.enabled` it is just `start()` |
| `softphone.exportResumeState()` | The descriptor a reload would restore, or `null` |
| `snapshot.resume` | `{ state: 'idle' \| 'resuming', pendingCalls }` |
| `call.anchorId`, `call.resuming` | Anchor room id; true while rejoining |
| `registration:resuming` | `{ calls: CallId[] }`, once per restore |
| `call:resumed` | `{ call }`, the call is talking again |
| notification `callResumeFailed` | `params: { name }` |

`MockSoftphone` implements the same behaviour (its session, including the fake credentials, lives
in sessionStorage `sipkit-mock:resume`). The playground has a **Survive reload** toggle in
the mock controls and the real connect form; in real mode it also keeps the connect settings in
sessionStorage so a reload reconnects by itself (dev only: that includes the SIP password, a host
app would get a fresh credential from its own session instead).

### Leader-tab takeover

The sibling multi-tab host runs one softphone in a leader tab. When the leader goes away and
another tab takes over, it should:

1. call `softphone.resume()` **instead of** `start()`: `resume(): Promise<void>` starts the
   softphone when it is not started yet (and `start()` restores this page's own descriptor), so
   it is safe on any Softphone; with `resume.enabled` off it is exactly `start()`;
2. to carry calls over from the old leader, use `resume.storage: 'local'` (shared by the
   profile's tabs) or ship the leader's `exportResumeState()` over the BroadcastChannel and pass
   it: `softphone.resume(state)`. Calls appear at once with `resuming: true` and rejoin as soon as
   the new leader is registered. Calls whose id or anchor is already live are skipped, so calling
   it twice is harmless.

The descriptor is validated (`parseResumeSnapshot()`): unknown versions, another `username`, bad
anchor ids are dropped.

## Server side

### Dev PBX (`infra/asterisk/config/pbx`)

- `extensions.conf`: `Gosub(sipkit-anchor,setup,1(${EXTEN}))` before the `Dial` of `_1XXX` / `_2XXX`
  sets `ANCHOR_OPTS` to `G(sipkit-anchor-in^<id>^1)` (callee has an `sipkit-resume` contact) or
  `G(sipkit-anchor-out^<id>^1)` (caller sent `X-Sipkit-Anchor`), else nothing. After the answer
  `G()` sends the caller and the callee into `[sipkit-anchor-party]` / `[sipkit-anchor-agent]`, i.e.
  ConfBridge `sipkit-<id>`. astdb `ANCHOR/<id>/{agent,party,agentchan,timeout,ended}` holds the state.
- `[sipkit-anchor-party]`: the customer joins with `sipkit_anchor_party` (`end_marked=yes`), so it
  leaves the room when the last agent leg (`sipkit_anchor_agent`, `marked=yes`) is gone. It then
  waits with music on hold, polling every 0.5 s: agent back (`CONFBRIDGE_INFO(parties)`) → join
  again; `ended` → hang up; timeout → **fallback**.
- **Fallback: the agent's voicemail if the mailbox exists, else hang up.** Voicemail keeps the
  caller's message instead of dropping them; extensions without a mailbox (1003) hang up. For a
  contact centre, replace the two lines after `(fallback)` with e.g. `Queue(support)`.
- `*85<id>`: only the endpoint that owns the anchor (`CHANNEL(endpoint)`) and only while it is not
  ended; otherwise `Hangup(1)` (404). `*86<id>`: marks it ended and `ChannelRedirect`s the
  customer to a hangup.
- The customer's hangup handler (`[sipkit-anchor-hangup]`) soft-hangs-up the agent's latest leg and
  deletes the astdb tree, so a remote hangup is a BYE to the browser.
- **Dead-leg watcher** `[sipkit-anchor-watch]`. Asterisk does **not** hang up a call when the
  browser's WebSocket closes (measured on 20.6: the leg stayed up indefinitely), but the
  registrar drops the contact of that WebSocket at once. Every agent leg starts a small
  Local-channel watcher (`Originate(...,a)`) that polls once a second whether the leg's
  WebSocket address (inbound legs: `CHANNEL(pjsip,remote_addr)`; outbound legs: the URI of
  `CHANNEL(contact)`) is still among `PJSIP_DIAL_CONTACTS(<agent>)`. When it is gone the leg is
  soft-hung-up, the customer leaves the room (`end_marked`) and the rejoin timeout starts, so
  the fallback runs about `1-2 s + rejoinTimeoutMs` after the tab vanished. A newer leg (rejoin)
  or the end of the anchor stops the watcher. `rtp_timeout` was tried first and rejected: it
  also applies to idle **video** streams (camera off, the echo test's prompt) and hung up
  healthy video calls.
- `confbridge.conf`: profiles `sipkit_anchor_agent`, `sipkit_anchor_party`.

### Gateway (`infra/asterisk/config/gateway`)

In `sip-gateway` mode the leg that drops is the browser ↔ gateway leg, so the room lives on the
gateway: the same `[sipkit-anchor*]` contexts, `*85` / `*86` in `[from-browser]`, the setup Gosub in
front of both `Dial`s, an `X-Sipkit-Anchor` pre-dial handler towards the browser, the watcher and a
`confbridge.conf` with the anchor profiles. There is no voicemail on
the gateway, so its fallback hangs up and the upstream PBX sees a normal hangup.

### Production snippet for your Asterisk

1. Copy `[sipkit-anchor]`, `[sipkit-anchor-in]`, `[sipkit-anchor-out]`, `[sipkit-anchor-agent]`,
   `[sipkit-anchor-watch]`, `[sipkit-anchor-party]`, `[sipkit-anchor-bye]`, `[sipkit-anchor-hangup]` from
   `infra/asterisk/config/pbx/extensions.conf`, and the two profiles (plus `sipkit_bridge`) from
   `confbridge.conf`.
2. In every route that rings an agent, and in the agents' outbound route:

   ```asterisk
   same => n,Gosub(sipkit-anchor,setup,1(${EXTEN}))          ; before Dial
   same => n,Dial(PJSIP/${EXTEN},30,tT${ANCHOR_OPTS})      ; append ${ANCHOR_OPTS}
   ```

   and a pre-dial handler on the agent leg that adds the room id:

   ```asterisk
   ; Dial(...,b(sipkit-anchor-header^s^1)...)
   [sipkit-anchor-header]
   exten => s,1,ExecIf($["${SIPKIT_ANCHOR_IN}" != ""]?Set(PJSIP_HEADER(add,X-Sipkit-Anchor)=${SIPKIT_ANCHOR_IN}))
    same => n,Return()
   ```

   Queues: the `Dial` `G()` option does not exist for `Queue()`, so queue calls are not anchored
   by this snippet (they behave as today). Anchoring them needs ARI or a follow-up dialplan
   (e.g. a Local-channel member that runs the same setup); tracked as a limitation.
3. The `*85X.` / `*86X.` extensions in the agents' context (rename the codes if they clash and
   set `resume.rejoinPrefix` / `endPrefix`).
4. Nothing on the endpoints: keep `remove_existing=yes` on the AORs (the watcher relies on the
   registrar dropping a closed WebSocket's contact, which Asterisk does for WS/TCP/TLS).
5. Endpoint names: the dialplan keys anchors by `CHANNEL(endpoint)`; if the endpoint is not the
   extension (e.g. `agent-1002`) pass the endpoint name to the setup Gosub instead of `${EXTEN}`.
6. `func_db`, `func_strings` (`STRREPLACE`), `app_confbridge`, `func_confbridge`
   (`CONFBRIDGE_INFO`) and `res_musiconhold` must be loaded (default).

## Tests

- Unit: `packages/core/src/__tests__/softphone.resume.test.ts` (instance id, opt-in, anchor
  headers, persistence, restore with same id/times, rejoin after registration, `*86` on a real
  hangup only, 404 / timeout / stale / foreign descriptors, takeover `resume(state)`), and
  `packages/react/src/testing/mock-softphone.test.ts`.
- Mock e2e: `apps/playground/e2e/resume.spec.ts` (reload during a call → same id, banner, timer
  continues; Nepali banner).
- Real SIP: `apps/playground/e2e/sip/resume.spec.ts` on the dev PBX: 1001 → 1002, 1002 reloads,
  the call comes back with two-way RTP and no BYE/CDR on 1001, hangup ends both; caller hangup;
  outgoing anchor; agent never returns → music on hold, then the fallback hangs up (1003, 5 s
  timeout); `sip-gateway` mode through the gateway.

## Limits

- Anchored calls are audio-only and cannot be transferred or merged into a server conference.
- During the gap the caller hears silence until the watcher notices the dead leg (1-2 s), then
  music on hold. With a quick reload the agent is often back before that.
- The watcher costs one Local channel polling once a second per anchored call; at contact-centre
  scale an ARI service is the better home for this logic (see the options table).
- `+sip.instance` does not dedupe contacts on Asterisk 20 (it relies on the transport monitor).
- The descriptor is per tab by default (`sessionStorage`): a reload keeps the call, closing the
  tab and opening a new one does not (use `storage: 'local'` or the leader-tab host for that).
