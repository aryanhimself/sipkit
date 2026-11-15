# Voicemail

Two layers, both opt-in under `voicemail`:

| | Roadmap | What | Needs |
|---|---|---|---|
| **MWI** | V2-VM-01 | `message-summary` SUBSCRIBE, header badge with the new-message count, one click dials `*97` | Asterisk `mailboxes=` on the endpoint |
| **Voicemail list** | V2-VM-02 | Voicemail tab: list, play, mark heard, call back, delete | `services/voicemail-api` next to Asterisk |

MWI is described in [server-features.md](server-features.md) and the core README. This page covers the list.

## Why a backend service

Asterisk's ARI has no voicemail message API (ARI `/mailboxes` is for `res_mwi_external`
mailboxes and only stores counts), and AMI only reports counts. `app_voicemail` (file storage)
keeps messages on disk:

```
/var/spool/asterisk/voicemail/<context>/<mailbox>/{INBOX,Old,Urgent}/msgNNNN.{txt,wav,WAV,gsm}
```

`services/voicemail-api` is a small Node 22 HTTP service (no runtime dependencies) that reads and
changes that spool. It must share the spool volume with Asterisk and run as the same uid/gid
(`100:101` in the dev image).

## voicemail-api

### Routes

All JSON, `Cache-Control: no-store`. `:mailbox` is `1001` (context `VM_DEFAULT_CONTEXT`) or `1001@context`.

| Method | Path | Result |
|---|---|---|
| GET | `/healthz` | `{ ok: true }` (no auth) |
| GET | `/v1/mailboxes/:mailbox/messages` | `{ mailbox, context, counts: { new, old, urgentNew, urgentOld }, messages }`, newest first |
| GET | `/v1/mailboxes/:mailbox/messages/:id` | one message |
| GET, HEAD | `/v1/mailboxes/:mailbox/messages/:id/audio` | the recording: `audio/wav`, `Accept-Ranges: bytes`, `206` for `Range: bytes=…`, `416` when out of range |
| POST | `/v1/mailboxes/:mailbox/messages/:id/read` | moves INBOX/Urgent → Old, returns the message |
| DELETE | `/v1/mailboxes/:mailbox/messages/:id` | `204`, every file of the message removed |

A message:

```json
{
  "id": "1794207189-00000000", "mailbox": "1002", "context": "default",
  "folder": "new", "urgent": false,
  "callerId": "\"Agent 1001\" <1001>", "callerName": "Agent 1001", "callerNumber": "1001",
  "timestamp": 1794207189000, "date": "2026-11-09T06:53:09.000Z", "duration": 9, "hasAudio": true
}
```

`id` is Asterisk's `msg_id` from `msgNNNN.txt`, so it stays the same when files are renumbered
(fallback `<folder>-<NNNN>` for spools written by very old Asterisk). Audio prefers `msgNNNN.wav`
(PCM, plays in every browser); `.WAV` (wav49/GSM) and `.gsm` are served only when nothing better exists.
Keep `wav` in `voicemail.conf` `format=`.

### Spool safety

- **Locking** uses Asterisk's own `lockfile` scheme: a unique temp file hard-linked to `<folder>/.lock`
  (atomic across containers). The service waits up to 5 s for a lock held by `app_voicemail` and
  breaks locks older than 60 s. Requests on one mailbox are also serialised in-process.
- **Renumbering**: Asterisk finds the next free slot from the highest `msgNNNN`, so after a move or
  delete the service closes the gap (`msg0002` → `msg0001` …), like `app_voicemail` does when it
  closes a mailbox. A message moved to Old goes to the slot after Old's highest index.
- **Path traversal**: mailbox and context must match `[A-Za-z0-9][A-Za-z0-9_.+-]*` (no `..`), ids
  `[A-Za-z0-9_-]+`, and the resolved path must stay under `VM_SPOOL_DIR`. Checked before auth and
  before any filesystem access.
- Messages without `msgNNNN.txt` (still recording) are not listed.

### MWI refresh

After a mark-read or delete the service sends AMI **`VoicemailRefresh`** (`Context`, `Mailbox`), so
`app_voicemail` re-counts the mailbox and publishes MWI at once: the softphone badge drops within
a second. AMI is optional (`AMI_HOST`, `AMI_USERNAME`, `AMI_SECRET`); without it, the dev PBX's
`pollmailboxes=yes` / `pollfreq=2` (voicemail.conf) picks the change up within ~2 s. A failed AMI
call is logged and never fails the HTTP request.

The dev PBX ships `manager.conf.tmpl`: user `sipkit-voicemail`, secret = `DEV_SIP_PASSWORD`, only
`write=user` (enough for `VoicemailRefresh`), permitted from `LOCAL_NET`, port 5038 not published.

### Tokens

Every route except `/healthz` needs `Authorization: Bearer <token>`. Three kinds, checked in order:

| Kind | Env | Use |
|---|---|---|
| Dev token | `VM_DEV_TOKEN` | one token for **every** mailbox. Development only (logged as a warning) |
| Static | `VM_STATIC_TOKENS=1001=tokA,2001@desk=tokB` | one long-lived token per mailbox |
| HMAC | `VM_TOKEN_SECRET` (≥ 32 chars) | short-lived per-mailbox tokens minted by the CRM backend |

HMAC token format: `vm1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, "vm1." + payload))>`
with claims `{ "mbx": "1001", "ctx": "default", "exp": <epoch s>, "iat": <epoch s> }`. Expired
tokens, tokens for another mailbox/context (403) and tokens whose `exp` is more than
`VM_TOKEN_MAX_TTL` (default 24 h) away are rejected. Minting in a CRM backend (Python):

```python
import base64, hashlib, hmac, json, time
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def voicemail_token(secret: str, mailbox: str, context="default", ttl=900) -> str:
    now = int(time.time())
    payload = b64(json.dumps({"mbx": mailbox, "ctx": context, "iat": now, "exp": now + ttl}).encode())
    sig = hmac.new(secret.encode(), f"vm1.{payload}".encode(), hashlib.sha256).digest()
    return f"vm1.{payload}.{b64(sig)}"
```

Node: `import { mintToken } from 'sipkit-voicemail-api'` (or `VM_TOKEN_SECRET=… node dist/mint-token.js 1001 900`).

The audio route also accepts `?access_token=` so a plain `<audio src>` can stream; only use it with
short-lived tokens (URLs end up in logs). The softphone UI never does: it downloads the recording
with the bearer header and plays an object URL.

### CORS

`VM_CORS_ORIGINS` is an exact-match allow-list (`https://crm.example.com,http://localhost:5179`).
Preflights allow `Authorization`, `Range`; `Content-Range` / `Accept-Ranges` are exposed. `*` works
but is logged as a warning. Alternatively serve the API under the CRM's own origin via a reverse proxy.

### Running it

```bash
# dev PBX + voicemail-api (http://localhost:8090, dev token "sipkit-dev-voicemail")
cd infra/asterisk && docker compose --profile voicemail up -d --build
curl -H 'Authorization: Bearer sipkit-dev-voicemail' http://localhost:8090/v1/mailboxes/1002/messages
```

The compose service shares the named volume `voicemail-spool` with the `asterisk` service and talks
AMI to `172.28.0.10`. Environment variables: [services/voicemail-api/.env.example](../services/voicemail-api/.env.example).
Standalone: `docker build -t sipkit/voicemail-api services/voicemail-api`, then run it with the
spool mounted read-write and `--user <asterisk uid>:<gid>`.

## Softphone side

### Config

```ts
createSoftphone({
  config: {
    voicemail: {
      enabled: true,
      number: '*97',
      api: {
        baseUrl: 'https://pbx.example.com/voicemail', // empty = no list (default)
        mailbox: '',              // default: username; "1001@sales" for another context
        getToken: () => crm.fetchVoicemailToken(), // called on first use and after a 401
        // token: 'static-token', // alternative for simple setups
        autoRefresh: true,        // reload after registering and on every MWI change
        timeout: 15000,
      },
    },
  },
});
```

The tab appears when `voicemail.enabled`, `voicemail.api.baseUrl` and a mailbox are set and
`'voicemail'` is not in `disabledFeatures`.

### Core API

| | |
|---|---|
| `snapshot.voicemailList` | `{ status: 'disabled' \| 'idle' \| 'loading' \| 'ready' \| 'error', messages, counts: { new, old }, error?, updatedAt?, pending }` |
| `voicemail:list` event | `{ list }` on every change |
| `refreshVoicemails()` | reload; rejects with `VoicemailApiError` (`code`: unauthorized, forbidden, not_found, network, timeout, http) |
| `markVoicemailRead(id)` | move to Old; the badge follows the PBX's MWI NOTIFY |
| `deleteVoicemail(id)` | delete (already gone counts as deleted) |
| `getVoicemailAudio(id)` | `Blob` of the recording |

`snapshot.voicemail` (MWI) stays the PBX's truth: the list never edits it. The list reloads on its
own whenever the MWI counts change, so a new message shows up without polling, and a message
handled on a desk phone or through `*97` disappears from the list.

`VoicemailClient` is the framework-free client underneath (`getSnapshot` / `subscribe`, `list`,
`markRead`, `delete`, `fetchAudio`, `audioUrl(id, { withToken })`); use it directly without a
Softphone if needed.

### React / UI

- `useVoicemailList()`: the state above plus `enabled`, `refresh`, `markRead`, `remove`, `getAudio`, `isPending(id)`.
- `useVoicemailPlayer()`: `load(id)` downloads into an object URL (revoked on replace / stop / unmount), `url`, `status`.
- `<VoicemailPanel onCall />` (the Voicemail tab) and `<VoicemailTabBadge />` in `sipkit-ui`: play
  in an `<audio>` element, mark heard, call back, delete with an inline confirmation. English and Nepali.

### Testing

- `createMockVoicemailBackend(seed)` (core, also in `sipkit-core/testing`): an in-memory
  voicemail-api for `fetch` (`createTestSoftphone({ voicemailFetch })`, `new VoicemailClient({ fetch })`),
  with `add()`, `failNext(status)`, `requests`.
- `MockSoftphone` uses it automatically when `voicemail.api.baseUrl` is set (options `voicemailMessages`,
  `voicemailFetch`); `simulateVoicemailMessage()` leaves a message and bumps MWI, mark read / delete
  update MWI like Asterisk. The playground mock mode has "New voicemail" and "Voicemail API error".
- Real PBX: `e2e/sip/voicemail-list.spec.ts` (needs `E2E_VOICEMAIL_API_URL` and a token, see the spec header).

## Limitations

- File storage only (no ODBC/IMAP voicemail). Greetings and folders other than INBOX/Old/Urgent are not exposed.
- No "mark unheard" or move-to-folder.
- The list is fetched whole (fine for `maxmsg=100`); no paging.
- One mailbox per softphone.
