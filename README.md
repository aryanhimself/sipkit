# sipkit

**An embeddable SIP softphone for the web.** Drop a full phone (calls, transfers, conferences,
voicemail, presence, chat, video) into any web app: as a React component, as a
`<sipkit-phone>` web component with one script tag, or headless through a typed TypeScript API.
Built on [SIP.js](https://sipjs.com) and WebRTC. MIT licensed.

- **Core:** TypeScript, framework-agnostic orchestrator with typed state, events and plugins.
- **UI:** React + Tailwind + shadcn/ui widget, themeable with CSS variables, localised (English, Nepali), also shipped as a `<sipkit-phone>` web component.
- **Transports:** WebRTC straight to a WebRTC-enabled PBX such as Asterisk (`wss://…/ws`), or through a WebRTC↔SIP gateway for plain-SIP PBXs. A native (baresip) engine covers desktop apps.
- **No hidden third parties:** no vendor services, no telemetry. You bring the PBX.

> Status: **0.x, under active development.** APIs may change between minor versions until 1.0.
> See the [roadmap](docs/roadmap.md).

## Packages

| Package | What it is | Use it when |
|---|---|---|
| [`sipkit-core`](packages/core) | Engine-agnostic orchestrator: config (zod), call/line state, snapshot + typed events, plugins, SIP.js WebRTC engine, test utilities (`sipkit-core/testing`) | You need the phone without our UI, or are building integrations |
| [`sipkit-react`](packages/react) | `SoftphoneProvider` + hooks (`useRegistration`, `useCalls`, `useActiveCall`, `useDevices`, …) | You build your own React UI |
| [`sipkit-ui`](packages/ui) | Ready-made widget (`Softphone` component), extension points, `<sipkit-phone>` web component, push service worker | You want a finished softphone |
| [`sipkit-engine-native`](packages/engine-native) | Native SIP engine (baresip sidecar over IPC): plain SIP over UDP/TCP/TLS | Desktop shells (Electron) and Node |

## Install

```sh
npm install sipkit-core sipkit-react sipkit-ui react react-dom
```

## Usage

**React component**

```tsx
import { createSoftphone } from 'sipkit-core';
import { Softphone } from 'sipkit-ui';
import 'sipkit-ui/styles.css';

const softphone = createSoftphone({
  config: {
    websocketUrls: ['wss://pbx.example.com:8089/ws'],
    username: '1001',
    password: await getSipCredential(), // from your backend; never from a DOM input
  },
});

export const Phone = () => <Softphone softphone={softphone} layout="compact" />;
```

**Web component (any page, one script tag)**

```html
<script src="https://cdn.jsdelivr.net/npm/sipkit-ui@0.1.0/dist/sipkit.iife.js"></script>
<sipkit-phone ws-url="wss://pbx.example.com:8089/ws" username="1001" brand-name="Acme Phone"></sipkit-phone>
<script>
  const el = document.querySelector('sipkit-phone');
  el.config = { password: sipCredentialFromBackend }; // property, not an attribute
  el.addEventListener('sipkit:call', (e) => console.log('call', e.detail));
</script>
```

Self-host the bundle (`node_modules/sipkit-ui/dist/sipkit.iife.js`) under a versioned path in
production. ESM hosts can `import 'sipkit-ui/embed'` instead to reuse their own React.

**Headless**

```ts
import { createSoftphone } from 'sipkit-core';

const softphone = createSoftphone({ config: { websocketUrls: ['wss://pbx.example.com:8089/ws'], username: '1001', password } });
softphone.on('call:created', ({ call }) => console.log(call.remoteNumber));
await softphone.start();
await softphone.call('1002');
```

## Develop

Requirements: Node ≥ 22, pnpm (version pinned in `package.json` → `corepack enable`), Docker
(only for the dev PBX).

```bash
pnpm i                      # install the workspace
pnpm dev                    # playground at http://localhost:5173 (mock mode works without a PBX)

# optional: a real Asterisk to register against
cd infra/asterisk
./scripts/gen-certs.sh      # dev TLS certs for WSS
docker compose up -d --build
# trust the dev cert (infra/asterisk/README.md), then in the playground use:
#   wss://localhost:8089/ws   user 1001 / sipkitdev123   → dial 600 for the echo test
```

Other scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check` (all four).

| Folder | What it is |
|---|---|
| [`apps/playground`](apps/playground) | Dev/demo app, mock mode for e2e |
| [`apps/desktop`](apps/desktop) | Electron desktop app around the widget ([docs](docs/desktop.md)) |
| [`apps/extension`](apps/extension) | Chrome/Firefox extension hosting one softphone for all tabs ([docs](docs/browser-extension.md)) |
| [`services/push`](services/push) | Self-hosted Web Push (VAPID) service for incoming calls ([docs](docs/push.md)) |
| [`services/voicemail-api`](services/voicemail-api) | Voicemail list/playback API over the Asterisk spool ([docs](docs/voicemail.md)) |
| [`infra/asterisk`](infra/asterisk) | Docker dev PBX (WebRTC + UDP endpoints), gateway profile, coturn |

## Documentation

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Package diagram, engines and transport modes, state flow, plugins, security model |
| [docs/adding-a-feature.md](docs/adding-a-feature.md) | Step-by-step guide with an example plugin (CRM caller lookup) and an example engine |
| [docs/theming.md](docs/theming.md) | Design tokens, dark mode, CSS variables (`--sipkit-*`) |
| [docs/i18n.md](docs/i18n.md) | Message catalogue, locales (English, Nepali), adding a language, RTL |
| Feature guides | [presence](docs/presence.md), [chat](docs/chat.md), [video](docs/video.md), [call quality](docs/call-quality.md), [voicemail](docs/voicemail.md), [push](docs/push.md), [server features](docs/server-features.md), [reload-safe calls](docs/resume.md), [shared instance](docs/shared-instance.md), [native engine](docs/native-engine.md) |
| [docs/roadmap.md](docs/roadmap.md) | v1/v2 task breakdown, test strategy |
| [docs/adr/](docs/adr) | Architecture decision records |
| [infra/asterisk/README.md](infra/asterisk/README.md) | Dev PBX, gateway mode, TURN, production Asterisk checklist |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Conventions, tests, releasing |

## License

[MIT](LICENSE) © 2026 sipkit contributors
