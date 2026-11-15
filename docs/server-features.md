# Server-side features: DND and ConfBridge conferences

Two features can run in the browser (the default) or on the Asterisk PBX:

| Feature | Local mode (default) | Server mode |
|---|---|---|
| Do Not Disturb (V2-FWD-01) | The browser rejects INVITEs with `dnd.rejectCode` | The softphone dials feature codes; the PBX stores DND in astdb and answers busy, **even when the tab is closed** |
| Conference (V2-CONF-01) | The browser mixes the calls (Web Audio) | `conference()` moves the parties into an Asterisk **ConfBridge** room; the room can outlive you |

Both server modes need dialplan on the PBX. The dev PBX (`infra/asterisk/config/pbx`) has it;
**A production Asterisk needs the equivalent snippets below** before the modes are switched on.

---

## Do Not Disturb

### Config

```ts
createSoftphone({
  config: {
    dnd: {
      mode: 'server',      // 'local' (default) | 'server' | 'both'
      serverOn: '*78',     // default
      serverOff: '*79',    // default
      serverQuery: '*76',  // optional, default '' (no query)
      syncOnRegister: true, // default
      serverTimeout: 10,   // seconds, default
    },
  },
});
```

| Mode | `setDnd(true)` | Incoming call while on |
|---|---|---|
| `local` | flips `snapshot.dnd` | browser rejects with `dnd.rejectCode` (486), `dnd` CDR + missed-call toast |
| `server` | flips `snapshot.dnd`, dials `serverOn` silently | PBX answers busy; the browser never sees an INVITE (no CDR, no toast) |
| `both` | as `server` | PBX answers busy; if an INVITE still arrives (e.g. dialplan missing), the browser rejects it too |

### How the client behaves

- **Silent service calls.** The feature code is dialled as a short-lived call that never enters the
  call list: no line, no call screen, no CDR, no plugin hooks, no ringtone. The PBX answering
  (200 OK) means "stored"; the client hangs up straight away.
- **Optimistic toggle, reverted on failure.** `snapshot.dnd` changes at once and
  `snapshot.dndPending` is `true` while the code runs (the header toggle shows busy). If the call
  is rejected (e.g. 404: the code is not in the dialplan), times out (`serverTimeout`) or cannot be
  placed, the toggle reverts, `dnd:changed` fires again, a `notification` with
  `code: 'dndServerFailed'` (`params: { state, reason }`) is emitted and the `setDnd()` promise
  rejects with a `SoftphoneError('ENGINE_ERROR')`. `useDnd().setDnd/toggle` swallow the rejection
  (the toast already tells the user).
- **Persistence and re-apply.** Server modes always remember the intended state in the softphone
  storage (`sipkit:core:dnd`). On every transition to `registered` (`syncOnRegister`):
  - with `serverQuery` set, the client dials it and **adopts the server's state** (so a DND set
    from another tab or a desk phone shows up), unless the user changed DND while unregistered;
  - without `serverQuery`, the client **pushes** its state (`serverOn` or `serverOff`), so the
    browser is the source of truth.
- Changes while unregistered are stored and applied on the next registration.
- `setDnd()` now returns `Promise<void>`. In local mode it resolves immediately and the snapshot is
  updated synchronously, as before.

### Dialplan (dev PBX, `extensions.conf`)

```asterisk
; Feature codes. The state is written BEFORE Answer(), so a 200 OK means it is stored.
; Keyed by the PJSIP endpoint, which a user cannot spoof (CALLERID(num) comes from the From header).
exten => *78,1,NoOp(DND on for ${CHANNEL(endpoint)})
 same => n,Set(DB(DND/${CHANNEL(endpoint)})=1)
 same => n,Set(DEVICE_STATE(Custom:DND${CHANNEL(endpoint)})=BUSY)
 same => n,Answer()
 same => n,Hangup()

exten => *79,1,NoOp(DND off for ${CHANNEL(endpoint)})
 same => n,Set(DBDEL_RESULT=${DB_DELETE(DND/${CHANNEL(endpoint)})})
 same => n,Set(DEVICE_STATE(Custom:DND${CHANNEL(endpoint)})=NOT_INUSE)
 same => n,Answer()
 same => n,Hangup()

; Optional query (dnd.serverQuery): 486 busy = DND on, answered = off.
exten => *76,1,NoOp(DND state for ${CHANNEL(endpoint)})
 same => n,GotoIf($["${DB(DND/${CHANNEL(endpoint)})}" = "1"]?on)
 same => n,Answer()
 same => n,Hangup()
 same => n(on),Busy(1)

; Every extension route checks the DB before dialling.
exten => _1XXX,1,NoOp(Call to WebRTC user ${EXTEN})
 same => n,GotoIf($["${DB(DND/${EXTEN})}" = "1"]?dnd)
 same => n,Dial(PJSIP/${EXTEN},30,tT)
 same => n,GotoIf($["${DIALSTATUS}" = "BUSY"]?busy)
 same => n,Hangup()
 same => n(busy),Busy(5)
 same => n(dnd),NoOp(${EXTEN} is on Do Not Disturb)
 same => n,Busy(5)
```

`Custom:DND<ext>` can be used in BLF hints (`exten => 1002,hint,PJSIP/1002&Custom:DND1002`) so
desk phones and queue members see the agent as busy. To send DND callers to voicemail instead of
busy, replace the `(dnd)` branch with `VoiceMail(${EXTEN}@default,b)`.

### What a PBX admin must add

1. The three feature codes (`*78`, `*79`, optionally `*76`) in the context the agents' endpoints
   use. If those codes are taken, pick others and set `dnd.serverOn` / `serverOff` /
   `serverQuery` in the softphone config.
2. The `GotoIf($["${DB(DND/${EXTEN})}" = "1"]?dnd)` check at the top of **every** route that rings
   an agent: the extension pattern, and the queue member path if agents are queue members (use
   a member `state_interface=Custom:DND<ext>` or a hint so queues skip DND agents).
3. If the endpoint name is not the extension number (e.g. `agent-1002`), key the DB with the
   extension instead: map it with a dialplan function (`${CUT(CHANNEL(endpoint),-,2)}`) or use
   `${CALLERID(num)}` if the From user is trustworthy on that PBX. The incoming check must use the
   same key.
4. `func_db` and `func_devstate` must be loaded (they are by default).

---

## ConfBridge conference

### Config

```ts
createSoftphone({
  config: {
    conference: {
      mode: 'server',        // 'local' (default) | 'server'
      serverRoomPrefix: '7', // default: room extension = prefix + room
      serverRoom: '',        // default: your own username -> 71001 for agent 1001
      serverEndOnLeave: false, // default: parties stay connected after you leave
      serverJoinTimeout: 15, // seconds, default
    },
  },
});
```

### What `conference()` does in server mode

1. Holds every party and dials the room (`71001`) as an extra line (allowed beyond `maxLines`,
   the parties free theirs next) with `X-Sipkit-Conference: owner` (and
   `X-Sipkit-Conference-End: yes` when `serverEndOnLeave`). It waits for the room to answer.
2. Blind transfers (REFER) each party to the room. Each transferred call ends with reason
   `transferred` (normal CDR) and is added to the roster on the room call.
3. A party whose REFER fails stays on its own held line and a `conferenceTransferFailed`
   notification (`params: { name }`) is emitted. If no party could be moved, the room call is hung
   up and `conference()` rejects.
4. Calling `conference()` again with new calls (e.g. after Add call) transfers them into the same
   room.

The room leg is a normal call with `inConference: true` and
`call.conference = { room, participants, capabilities }`. The roster is what this client knows
(the parties it transferred); people who join or leave the room by other means are not seen.
Room numbers bypass `techPrefix` (the room lives on the same PBX).

### Capabilities, not modes

UIs never check `conference.mode`. `getConferenceView(calls)` (core) / `useConference()` (React)
return `{ calls, parties, capabilities, room? }` for either mode:

| Capability | Local | Server |
|---|---|---|
| `partyMute` (`setPartyMuted`) | yes | no |
| `removeParty` (`removeFromConference`) | yes | no |
| `hangupParty` | yes | no |
| `split` (`splitConference`) | yes | no |
| `survivesLeave` | no | yes, unless `serverEndOnLeave` |

`ConferencePanel` shows the room number, lists the parties with a timer since they joined, hides
per-party buttons and Split, and its end button reads **Leave conference** when `survivesLeave`.
`removeFromConference`, `splitConference` and `setPartyMuted` throw `NOT_SUPPORTED` for a server
room. Per-party control would need AMI/ARI on the PBX (a backend, not the browser); the owner's
ConfBridge DTMF menu (below) offers room-wide admin actions by sending DTMF on the room call.

### Limits

- Only **bridged** parties can be transferred. A call that ends in a dialplan application on your
  own channel (e.g. `600` → `Echo()`, an IVR) has no other channel to move, so its REFER fails and
  it stays on its own line. Calls to people, queues and trunks are bridged and work. The dev PBX
  has `6000`, the echo test behind a Local channel, for exactly this.
- The roster is client-side only (see above).

### confbridge.conf (dev PBX)

```ini
[sipkit_bridge]
type=bridge
max_members=20
mixing_interval=20
internal_sample_rate=auto

[sipkit_owner]            ; the softphone user who built the conference
type=user
admin=yes
marked=yes
quiet=yes
announce_user_count=no
announce_only_user=no
dsp_drop_silence=yes

[sipkit_party]            ; transferred parties; stay after the owner leaves
type=user
quiet=yes
announce_only_user=no
music_on_hold_when_empty=yes
dsp_drop_silence=yes

[sipkit_party_end]        ; parties of an end-on-leave room
type=user
quiet=yes
announce_only_user=no
music_on_hold_when_empty=yes
dsp_drop_silence=yes
end_marked=yes

[sipkit_owner_menu]       ; DTMF on the owner's room call
type=menu
*1=toggle_mute
*2=admin_kick_last
*3=admin_toggle_mute_participants
*4=admin_toggle_conference_lock
```

### Dialplan (dev PBX, `extensions.conf`)

```asterisk
; 7 + room. The owner joins first (marked admin) and decides whether the room ends with them;
; the parties the owner REFERs here read that decision from astdb.
exten => _7XXXX,1,NoOp(ConfBridge room ${EXTEN:1})
 same => n,Set(ROOM=${EXTEN:1})
 same => n,GotoIf($["${PJSIP_HEADER(read,X-Sipkit-Conference)}" = "owner"]?owner)
 same => n,Answer()
 same => n,GotoIf($["${DB(CONF/${ROOM}/end)}" = "1"]?endmarked)
 same => n,ConfBridge(${ROOM},sipkit_bridge,sipkit_party)
 same => n,Hangup()
 same => n(endmarked),ConfBridge(${ROOM},sipkit_bridge,sipkit_party_end)
 same => n,Hangup()
 same => n(owner),Set(DB(CONF/${ROOM}/end)=${IF($["${PJSIP_HEADER(read,X-Sipkit-Conference-End)}" = "yes"]?1:0)})
 same => n,Answer()
 same => n,ConfBridge(${ROOM},sipkit_bridge,sipkit_owner,sipkit_owner_menu)
 same => n,Hangup()
```

### What a PBX admin must add

1. `confbridge.conf` with the profiles above (`app_confbridge` is loaded by default).
2. The room pattern in the agents' context. Adjust `_7XXXX` to the extension length (`_7XXX` for
   3-digit extensions) or pick another prefix that does not clash with existing numbers and set
   `conference.serverRoomPrefix`.
3. REFER must be allowed for the agents' endpoints (`allow_transfer=yes`, the PJSIP default), and
   the transfer must land in a context that contains the room pattern (PJSIP uses the
   transferer's context, or `TRANSFER_CONTEXT` if set on the channel).
4. The `X-Sipkit-Conference` header only grants the owner's admin menu and the end-on-leave choice
   for that room. If agents must not be able to take over each other's rooms, additionally check
   `${CHANNEL(endpoint)}` against `${ROOM}` in the `owner` branch.

---

## Testing

- Unit: `packages/core/src/__tests__/softphone.server-features.test.ts` (FakeEngine: service calls,
  revert, timeout, query/push on register, room join + REFER, failed REFER, room timeout).
- Mock e2e: `apps/playground/e2e/server-features.spec.ts` (playground "Server features" controls,
  `MockSoftphone.failNextServerDnd()`).
- Real Asterisk: `apps/playground/e2e/sip/server-features.spec.ts`: 1002 enables server DND →
  1001 gets busy and 1002's browser sees nothing → still busy with 1002's tab closed → a fresh
  1002 tab adopts "on" via `*76` and turns it off → it rings again. 1001 merges 1002 and `6000`
  → all three in ConfBridge `1001` (`asterisk -rx "confbridge list"` shows 3 users, 1 marked) →
  1001 leaves → 1002 stays in the room with media flowing.
- Playground real mode: pick **DND mode** / **Conference mode** in the connect form.
