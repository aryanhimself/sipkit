# sipkit-engine-native

A `SoftphoneEngine` for [`sipkit-core`](https://www.npmjs.com/package/sipkit-core) that speaks
**plain SIP over UDP, TCP or TLS** through a native SIP stack ([baresip](https://github.com/baresip/baresip))
running as a sidecar. No WebRTC, no WebSocket, no gateway. It is meant for desktop shells
(Electron) and Node, where the browser's WebRTC-only transport is not enough.

```
Softphone (sipkit-core) → NativeSipEngine → transport (IPC / stdio / TCP) → BaresipSidecar → baresip → SIP PBX
```

## Install

```sh
npm install sipkit-engine-native sipkit-core
```

ESM only. You also need a baresip binary (4.x with the `ctrl_tcp` module). The package ships a
reference Docker build in `sidecar/` (headless baresip 4.12 with `menu`, `ctrl_tcp`, `g711`).

## Quick start

```ts
import { createSoftphone } from 'sipkit-core';
import { nativeSipEngine, createBridgeTransport } from 'sipkit-engine-native';

const softphone = createSoftphone({
  config: {
    transportMode: 'native',
    sipServer: 'pbx.example.com:5060',
    sipTransport: 'udp', // 'udp' | 'tcp' | 'tls'
    username: '2001',
    password: '…',
  },
  // A factory: the orchestrator restarts engines on config changes.
  engine: nativeSipEngine({ transport: () => createBridgeTransport(window.sipkitNativeSip) }),
});
```

On the other side of the bridge (Electron main process, a utility process or plain Node), drive
baresip with the Node half of the package:

```ts
import { BaresipSidecar } from 'sipkit-engine-native/node';

// `transport` implements NativeSipTransport over your IPC channel (see TransportBase).
new BaresipSidecar(transport, { host: '127.0.0.1', port: 4444 });
```

Or run it out of process: `sipkit-native-sidecar --baresip 127.0.0.1:4444` speaks JSON lines on
stdio (`spawnSidecarTransport()`), or `--listen <port>` for TCP.

## Entry points

| Import | Runs in | What it is |
| --- | --- | --- |
| `sipkit-engine-native` | Anywhere core runs (browser-safe, no Node imports) | `NativeSipEngine` / `nativeSipEngine()`, the IPC protocol, transports (`createBridgeTransport`, `createMemoryTransportPair`), `FakeSidecarNetwork` for tests |
| `sipkit-engine-native/node` | Node / Electron main only | `BaresipSidecar`, `BaresipControl` (ctrl_tcp client), `JsonLinesTransport`, `spawnSidecarTransport`, `connectTcpTransport` |
| `sipkit-native-sidecar` (bin) | Node | Stand-alone sidecar process |

## Supported

Register / unregister, outgoing and incoming calls, early media, answer / reject / cancel,
hold, local mute, DTMF (RFC 4733 or SIP INFO), blind transfer, extra INVITE headers.
Not supported (yet): attended transfer, browser-side media streams (so no local conference
mixing; use server conferences), presence, MWI, chat and video.

The engine passes the same engine contract suite (`sipkit-core/testing`) as the other engines,
against `FakeSidecarNetwork` and against a real Asterisk.

## License

MIT. baresip itself is BSD-licensed and is not bundled in this package.
