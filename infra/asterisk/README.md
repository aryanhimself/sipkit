# Dev PBX (Asterisk 20 + PJSIP) for sipkit

A local Asterisk you can register the browser softphone to, plus an optional
WebRTC↔SIP gateway and a TURN server. **Development only.** See the
[production checklist](#production-checklist) for real deployments.

| Profile | Services | Use it to test |
|---|---|---|
| *(default)* | `asterisk` | `transportMode: 'webrtc'`: browser → WSS → Asterisk |
| `gateway` | `asterisk` + `asterisk-gateway` + `coturn` | `transportMode: 'sip-gateway'`: browser → WSS → gateway → UDP → "upstream PBX" (the dev PBX by default) |
| `turn` | `asterisk` + `coturn` | Forced-relay / NAT scenarios |

## What's inside

| Item | Value |
|---|---|
| Image | `ubuntu:24.04` + distro `asterisk` package (**Asterisk 20.6 LTS**), built locally from `docker/Dockerfile` |
| WSS (dev PBX) | `wss://localhost:8089/ws` (TLS on Asterisk's HTTP server, `http.conf`) |
| WSS (gateway) | `wss://localhost:8189/ws` |
| SIP UDP | dev PBX `5060/udp`, gateway `5070/udp` |
| RTP | dev PBX `10000-10049/udp`, gateway `10100-10149/udp` (narrow on purpose so Docker can publish them) |
| TURN | `turn:127.0.0.1:3478` (udp/tcp), relay ports `49160-49200/udp`, user `sipkit` / `TURN_PASSWORD` |
| Docker network | `172.28.0.0/24`: dev PBX `.10`, gateway `.11`, coturn `.20`, push service `.30` (`--profile push`) |
| Push (V2-PUSH-01) | `SIPKIT_PUSH_URL` / `SIPKIT_PUSH_SECRET` on the PBX: an offline `1XXX` gets a Web Push notification and keeps ringing up to `SIPKIT_PUSH_WAIT` s (see [docs/push.md](../../docs/push.md)) |

### Accounts (password = `DEV_SIP_PASSWORD`, default `sipkitdev123`)

| Ext | Type | Transport | For |
|---|---|---|---|
| 1001, 1002 | WebRTC (`webrtc=yes`: DTLS-SRTP, ICE, AVPF, rtcp-mux) | WSS | Browser softphone |
| 1003 | WebRTC (no mailbox) | WSS | Third party in BLF / pickup tests |
| 2001, 2002 | Plain SIP | UDP 5060 | Zoiper / desk phone / native engine contract suite ([docs/native-engine.md](../../docs/native-engine.md); baresip sidecars in the `native` profile) |
| 2099 | Plain SIP | UDP 5060 | Used by the gateway profile as its upstream account |

### Dialplan (`config/pbx/extensions.conf`)

| Dial | Result |
|---|---|
| `600` | Echo test (hear yourself) |
| `601` | Music on hold for 60 s |
| `602` | **Early media** test: 183 + audio before answer (exercises `earlyMedia`) |
| `700` | Queue `support` (ringall 1001 + 1002, MOH while waiting) |
| `1XXX` | Rings that WebRTC user |
| `2XXX` | Rings that SIP user (2099 = whoever the gateway rings) |
| `*97` | Voicemail menu for the caller's own mailbox (`VoiceMailMain`, no PIN) |
| `8XXXX` | Leave a voicemail in mailbox `XXXX` (e.g. `81002`): greeting, beep, records until hang-up |
| `**XXXX` | Directed call pickup of the call ringing at extension `XXXX` (`PickupChan(PJSIP/XXXX-,p)`), used by BLF `pickup()` |
| `*99XXXX` | **Dev only**: delete every message in mailbox `XXXX` (used by the e2e tests to start from 0) |
| `6000` | Echo test behind a Local channel: a bridged party that can be transferred into a conference (hangs up after 2 min) |
| `*78` / `*79` | Server-side DND on / off for the calling endpoint (astdb `DND/<ext>`, `Custom:DND<ext>`); `1XXX` / `2XXX` then answer 486 |
| `*76` | DND query: 486 when on, answered when off |
| `7XXXX` | ConfBridge room `XXXX` (`71001` = room of 1001), profiles in `confbridge.conf`. See [docs/server-features.md](../../docs/server-features.md) |

### Chat (SIP MESSAGE, `[messages]` in `config/pbx/extensions.conf`)

- Every user endpoint has `message_context=messages`, so `res_pjsip_messaging` hands out-of-dialog MESSAGEs to `[messages]`, which forwards them with `MessageSend(pjsip:${EXTEN})` to the target's registered contacts.
- A To user that matches no extension in `[messages]` (e.g. `9999`) is answered **404** at once. Matching messages are answered **202 Accepted** before the dialplan runs; if the target has no registered contact (`PJSIP_DIAL_CONTACTS` empty) the PBX sends the sender a **delivery report** MESSAGE with `X-Sipkit-Delivery: failed;to=<ext>;id=<X-Sipkit-Message-Id>`, which the softphone turns into a failed message (see [docs/chat.md](../../docs/chat.md)).
- Check from the CLI: `asterisk -rx "dialplan show messages"`; set `core set verbose 3` to watch the routing.

### Voicemail and MWI (`config/pbx/voicemail.conf`)

- Mailboxes `1001`, `1002`, `2001`, `2002` in context `default` (PIN = extension). File storage in the named volume `voicemail-spool` (`/var/spool/asterisk/voicemail`), shared with the voicemail list API.
- Voicemail list (V2-VM-02): `docker compose --profile voicemail up -d --build` adds `services/voicemail-api` on `http://localhost:8090` (dev token `sipkit-dev-voicemail`). After a mark-read/delete it sends AMI `VoicemailRefresh` as user `sipkit-voicemail` (`config/pbx/manager.conf.tmpl`, secret = `DEV_SIP_PASSWORD`, port 5038 not published). See [docs/voicemail.md](../../docs/voicemail.md).
- PJSIP: endpoint `mailboxes=<ext>@default` sends **unsolicited** MWI NOTIFYs; AOR `mailboxes` allows a **SUBSCRIBE** to `message-summary`; `mwi_subscribe_replaces_unsolicited=yes` lets the subscription take over. `voicemail_extension=*97` puts `Message-Account: sip:*97@…` in every NOTIFY, so the softphone can find the voicemail number without config.
- `pollmailboxes=yes`, `pollfreq=2`: changes made outside `app_voicemail` (the `*99XXXX` purge) are published within about 2 s.
- The compose file pins `hostname: sipkit-dev-pbx` / `sipkit-dev-gateway`. Asterisk uses the hostname as the From domain of qualify OPTIONS and unsolicited NOTIFYs; a random container id that starts with a digit is not a valid SIP host for SIP.js, so the contact goes Unreachable and calls to it fail.
- Check from the CLI: `docker compose exec asterisk asterisk -rx "voicemail show users"` and `asterisk -rx "pjsip show subscriptions inbound"`.

### BLF and presence

- Pattern hints `_1XXX` / `_2XXX` → `PJSIP/${EXTEN}` in `from-internal`, so any extension can be watched with `SUBSCRIBE` (`dialog` or `presence`). Endpoints have `allow_subscribe=yes`, `subscribe_context=from-internal`.
- `1003` is a third WebRTC user for three-party BLF / pickup tests (no mailbox).
- Check: `asterisk -rx "core show hints"` (watchers per hint). See [docs/presence.md](../../docs/presence.md).

## Quick start

Prerequisites: Docker with Compose v2, `openssl`, `bash`.

```bash
cd infra/asterisk
cp .env.example .env            # optional: change passwords / EXTERNAL_IP
./scripts/gen-certs.sh          # dev CA + server cert in ./certs (git-ignored)
docker compose up -d --build    # first build takes ~1-2 min
docker compose ps               # asterisk should be "healthy"
```

1. **Trust the certificate** (next section). Browsers refuse WSS to an untrusted certificate, and they fail silently (the softphone just reports a WebSocket error).
2. Start the playground (`pnpm dev` at repo root) and configure:

   ```ts
   {
     transportMode: 'webrtc',
     websocketUrls: ['wss://localhost:8089/ws'],
     domain: 'localhost',
     username: '1001',
     password: 'sipkitdev123',
   }
   ```

3. Dial `600`. You should hear the echo prompt.
4. Open a second browser profile as `1002` and call between them, or register **Zoiper** as `2001` (server `127.0.0.1:5060`, UDP) and call `1001` ↔ `2001`.

Useful commands:

```bash
docker compose exec asterisk asterisk -rvvv                        # Asterisk CLI
docker compose exec asterisk asterisk -rx "pjsip show contacts"    # who is registered
docker compose exec asterisk asterisk -rx "pjsip set logger on"    # SIP trace to the logs
docker compose logs -f asterisk
docker compose down                                                # stop everything
```

## Real-call e2e tests

`apps/playground/e2e/sip/**` has 14 Playwright tests that make real calls through this PBX. Each test opens two browser contexts with fake microphones and registers them as 1001 and 1002. The tests check RTP byte counters, so they fail if audio does not actually flow. They cover:

- echo test, early media (183)
- two-way call, decline (486 → `busy`), cancel
- hold/resume, mute, DTMF
- blind and attended transfer, 3-way local conference, call waiting
- `sip-gateway` mode end to end
- voicemail MWI badge (`8XXXX` leaves a message, `*99XXXX` resets the mailbox) and Do Not Disturb (486 without ringing)
- BLF: 1002 watches 1001 (idle → busy → idle on an echo call; ringing with caller when 1003 calls 1001) and picks the call up with `**1001`
- chat: 1001 ↔ 1002 messages with unread counts, 404 for an unknown extension, delivery report for an unregistered one

```bash
docker compose --profile gateway up -d --build --wait   # gateway test needs the profile
pnpm --filter sipkit-playground test:e2e:sip                   # or: apps/playground/scripts/e2e-sip-docker.sh -g "DTMF"
```

The script runs Chromium in the official Playwright **Linux** image on the `voip` network, against the playground dev server on the host. It does not run Chromium on macOS: there, Chromium's fake *audio* capture never returns from `getUserMedia` (fake video works). On a Linux host or in CI, `E2E_MODE=sip pnpm --filter sipkit-playground test:e2e` also works directly.

## Trusting the certificate

`gen-certs.sh` creates a **dev CA** (`certs/ca.crt`) and a server cert for `localhost`,
`127.0.0.1`, `::1`, `asterisk`, `asterisk-gateway` (+ any names/IPs you pass as arguments,
e.g. `./scripts/gen-certs.sh 192.168.1.50 pbx.lan`). Pick one option:

| Option | Steps | Notes |
|---|---|---|
| **A. Accept the exception (quickest)** | Open `https://localhost:8089/httpstatus` (and `https://localhost:8189/httpstatus` for the gateway), click *Advanced → Proceed* | Chrome/Edge remember it for the session. Firefox stores a permanent exception. Repeat after regenerating certs |
| **B. Trust the dev CA, macOS** | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certs/ca.crt` | Chrome, Edge and Safari use the system keychain |
| **B. Trust the dev CA, Windows** | `certutil -addstore -f Root certs\ca.crt` (admin) | Chrome/Edge use the Windows store |
| **B. Trust the dev CA, Linux** | `sudo cp certs/ca.crt /usr/local/share/ca-certificates/sipkit-dev.crt && sudo update-ca-certificates`; for Chrome also `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n sipkit-dev -i certs/ca.crt` | Chrome on Linux uses NSS |
| **B. Firefox (any OS)** | Settings → Privacy & Security → Certificates → View → Authorities → Import `ca.crt`, tick "trust for websites" | Or set `security.enterprise_roots.enabled=true` to use the OS store |
| **C. mkcert** | `mkcert -install && mkcert -cert-file certs/server.crt -key-file certs/server.key localhost 127.0.0.1 ::1` | Same effect as B, if you already use mkcert |

Remove the CA again when you're done if you installed it system-wide. **The CA key in
`certs/ca.key` can sign certificates for any domain your machine will trust: keep it local.**

## Gateway mode

```bash
docker compose --profile gateway up -d --build
docker compose exec asterisk-gateway asterisk -rx "pjsip show registrations"   # upstream should be "Registered"
```

Flow with the defaults (everything local):

```text
browser 1001 --WSS :8189--> asterisk-gateway --UDP, account 2099--> asterisk (dev PBX) --> Zoiper 2001
```

- Softphone config: `transportMode: 'sip-gateway'`, `websocketUrls: ['wss://localhost:8189/ws']`, `username: '1001'`, `password: GW_BROWSER_PASSWORD`, `sipServer: '172.28.0.10:5060'` (informational for this gateway).
- From the browser dial `2001` (Zoiper). From Zoiper dial `2099` to ring the browser through the gateway.
- **Point it at a real plain-SIP PBX**: set `UPSTREAM_HOST`, `UPSTREAM_PORT`, `UPSTREAM_DOMAIN`, `UPSTREAM_USER`, `UPSTREAM_PASSWORD`, `UPSTREAM_CODECS` in `.env`, then `docker compose --profile gateway up -d asterisk-gateway coturn` (the dev PBX is optional). The upstream must be able to reach the gateway's SIP/RTP (the published 5070/udp and 10100-10149/udp, or run the gateway on a host with a public IP).
- The template (`config/gateway/pjsip.conf.tmpl`, `extensions.conf.tmpl`) maps **one browser user to one upstream account**. For many agents, generate a block per agent or use a SIP proxy (Kamailio + rtpengine) instead of a B2BUA. See `docs/architecture.md`.
- Config templating: `docker/entrypoint.sh` renders `*.tmpl` with `envsubst`, restricted to a whitelist of variables, so dialplan variables like `${EXTEN}` are left alone.

## TURN (coturn)

Enabled in the `gateway` and `turn` profiles. Softphone `iceServers` example:

```ts
iceServers: [
  { urls: 'stun:127.0.0.1:3478' },
  { urls: ['turn:127.0.0.1:3478?transport=udp', 'turn:127.0.0.1:3478?transport=tcp'],
    username: 'sipkit', credential: 'sipkitturn-dev' },
]
```

To prove TURN works, set `iceTransportPolicy: 'relay'` in the engine (when exposed) or block UDP to the RTP range.

## Networking notes and caveats

- **Docker Desktop (macOS/Windows):** container IPs are not reachable from the host, so Asterisk advertises `EXTERNAL_IP` (default `127.0.0.1`) as its ICE host candidate (`rtp.conf [ice_host_candidates]`) and as `external_media_address` for UDP. That works for a browser/Zoiper **on the same machine**. To test from a phone or another PC, set `EXTERNAL_IP` to your LAN IP, regenerate certs with that IP, and `docker compose up -d --force-recreate`.
- **Linux:** the bridge IPs are reachable from the host, and the defaults work. For LAN testing set `EXTERNAL_IP` as above. `network_mode: host` is an alternative if you remove the static IPs and port mappings.
- **Codecs:** the Ubuntu package has no `codec_opus` transcoder, so calls negotiate **G.711 (PCMU/PCMA)**. That is fine for testing. Opus needs Sangoma's binary `codec_opus` or a source build.
- **Asterisk 22:** to test 22 LTS, replace the Dockerfile with a source build (`./configure --with-pjproject-bundled --with-jansson-bundled && make menuselect.makeopts && make && make install`). The config files here are compatible with 20 and 22.
- Startup logs contain a few harmless messages from distro modules (e.g. "No configured users for ARI", deprecated `app_macro`).
- The RTP range is tiny (about 25 concurrent WebRTC calls with rtcp-mux). Enlarge it in `rtp.conf.tmpl` **and** the compose port mapping together.

## Production checklist

Use this for a real (production) Asterisk (roadmap V1-INFRA-03, V1-SEC-06). The dev configs here are a starting point, not a production config.

| Area | Do |
|---|---|
| **TLS certificates** | A real certificate (e.g. Let's Encrypt) for the PBX FQDN in `http.conf` `tlscertfile`/`tlsprivatekey`. Automate renewal + `module reload http`. Never ship the dev CA. Optionally terminate TLS on a reverse proxy (nginx/HAProxy) that proxies `wss://pbx/ws` → `ws://127.0.0.1:8088/ws`, with WebSocket upgrade headers and long timeouts |
| **Bind addresses** | Keep plain HTTP (`bindaddr`) on `127.0.0.1`. Expose only `8089/tcp` (or 443 via proxy). Disable `enable_status` |
| **Firewall** | Allow inbound: `8089/tcp` (WSS) from agent networks, the RTP range `rtpstart-rtpend/udp` (default 10000-20000, narrow it), TURN `3478/udp+tcp` and `443/tcp` (TURN-TLS) and the TURN relay range. Restrict `5060/udp` to trunks/phones that need it. **Close it to agent PCs that only use WebRTC** |
| **NAT** | On each PJSIP transport: `external_media_address` and `external_signaling_address` = public IP, `local_net` = internal ranges. For WebRTC also set `rtp.conf` `stunaddr` or `[ice_host_candidates]` mappings so ICE advertises the public address |
| **TURN** | coturn on a public IP, `use-auth-secret` + `static-auth-secret` (backend mints time-limited credentials; never a static user in the bundle), TLS on 443, `denied-peer-ip` for private ranges except your media servers, `no-multicast-peers`, quotas (`user-quota`, `total-quota`) |
| **Endpoints** | `webrtc=yes` for browser agents, `max_contacts` 1–2 with `remove_existing=yes`, strong per-agent passwords or ephemeral credentials (V1-SEC-01), `allow` = `opus,ulaw,alaw` (install `codec_opus` if you transcode) |
| **Dialplan / toll fraud** | Separate contexts for WebRTC agents. Only allow the destinations agents need. Rate limits (`GROUP_COUNT`) on outbound trunks. No `_X.` to trunks from unauthenticated contexts. `allowguest`-style anonymous endpoint **not** defined |
| **Brute force** | fail2ban (or equivalent) on Asterisk security events (`security` log channel). `pjsip.conf` ACLs (`type=acl`) for trunks |
| **Logging** | `logger.conf`: enable the `security` channel and a full log with rotation. PJSIP logger off by default (on only for debugging). Correlate with `X-Sipkit-*` headers (V1-OBS-04) |
| **Media** | `strictrtp=yes`, `icesupport=yes`, narrow `rtpstart/rtpend` matching the firewall. Keep `direct_media=no` for WebRTC↔SIP bridges |
| **Recording/CDR** | If recording later (V2-REC-01), store recordings off-box with retention, and restrict access |
| **Monitoring** | Alert on registrations dropping, `pjsip show contacts` count, WSS handshake errors, RTP timeouts (`rtp_timeout` on endpoints), certificate expiry |
| **Upgrades** | Track an Asterisk LTS (20 or 22), apply security releases, and re-run the real-SIP e2e suite against staging before upgrading production |
