# sipkit-core

Framework-agnostic, embeddable SIP softphone for the browser. It speaks SIP over WebSocket
(WSS) with WebRTC media through [SIP.js](https://sipjs.com), and gives you a typed API, an
immutable state snapshot, typed events and a plugin system. No UI and no React: use it on its
own, with [`sipkit-react`](https://www.npmjs.com/package/sipkit-react) hooks, or with the
ready-made [`sipkit-ui`](https://www.npmjs.com/package/sipkit-ui) widget.

## Install

```sh
npm install sipkit-core
```

ESM only. Runs in modern browsers (WebRTC, WebSocket); the `testing` utilities also run in Node.

## Quick start

```ts
import { createSoftphone } from 'sipkit-core';

const softphone = createSoftphone({
  config: {
    websocketUrls: ['wss://pbx.example.com:8089/ws'],
    username: '1001',
    password: await getSipCredential(), // from your backend, never from a DOM input
  },
});

softphone.on('registration:state', (s) => console.log('registration', s.state));
softphone.on('call:created', ({ call }) => console.log('call', call.direction, call.remoteNumber));
softphone.on('cdr', (cdr) => saveCdr(cdr));

await softphone.start();             // registers (autoRegister defaults to true)
const call = await softphone.call('1002');
// later: softphone.hold(true, call.id), softphone.sendDtmf('1', call.id), softphone.hangup(call.id)

const snapshot = softphone.getSnapshot(); // registration, calls, devices, dnd, …
```

Every config field has a safe default. The config is validated with zod; see `configSchema`
and the doc comments in `config.ts` (shipped in the type declarations).

## What's inside

- **Calls:** outgoing / incoming, early media, hold, mute, DTMF (RFC 4733 / INFO), blind and
  attended transfer, multi-line, local or server (ConfBridge) conferences, forward, DND.
- **Transports:** `webrtc` (WSS straight to a WebRTC-enabled PBX such as Asterisk) or
  `sip-gateway` (WSS to a WebRTC↔SIP gateway in front of a plain-SIP PBX), with failover across
  several `websocketUrls` and explicit `iceServers`.
- **Opt-in features:** presence / BLF, MWI and voicemail list, SIP MESSAGE chat, video, call
  quality (MOS) sampling, Web Push for incoming calls, reload-safe calls, one shared instance
  across tabs.
- **Plugins:** `definePlugin()` with `beforeDial` / `onIncomingCall` hooks and a typed API.
  Built in: call history, contacts, ringtones.
- **Engines:** the orchestrator owns all state; engines only do signalling and media. The SIP.js
  engine is the default; [`sipkit-engine-native`](https://www.npmjs.com/package/sipkit-engine-native)
  adds a native (baresip) engine for desktop shells.

## Entry points

| Import | What it is |
| --- | --- |
| `sipkit-core` | `createSoftphone`, `Softphone`, config schema, types, plugins, SIP.js engine |
| `sipkit-core/remote` | `RemoteSoftphone`, `serveSoftphone()`, `createSharedSoftphone()`: one instance shared across tabs or hosted by a browser extension |
| `sipkit-core/testing` | **Test utilities** (not for production code): `FakeEngine`, `createTestSoftphone()`, the shared engine contract suite (`runEngineContract`), loopback engine, fake push platform, mock voicemail backend |

```ts
import { createTestSoftphone } from 'sipkit-core/testing';

const { softphone, engine } = await createTestSoftphone();
engine.simulateIncomingCall({ remoteNumber: '1002' });
```

## Documentation

Architecture, feature guides (presence, chat, video, push, voicemail, resume, theming…) and the
Asterisk dev setup live in the `docs/` folder of the sipkit repository.

## License

MIT
