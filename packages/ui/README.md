# sipkit-ui

Ready-made softphone widget for [`sipkit-core`](https://www.npmjs.com/package/sipkit-core):
React 18/19 + Tailwind CSS v4 + shadcn/ui (Radix). It ships two ways:

- **React library** (`dist/index.js` + `dist/styles.css` + types). Use it in React hosts.
- **Web component** `<sipkit-phone>` (`dist/sipkit.iife.js`, React and core bundled in). Use it on any page with a `<script>` tag. It renders inside a Shadow DOM, so host CSS cannot leak in.

## Install

```sh
npm install sipkit-ui sipkit-core sipkit-react react react-dom
```

`react` and `react-dom` (18 or 19) are peer dependencies. For the web component alone you need no
install at all: load the self-contained bundle from your own server or a CDN, for example
`https://cdn.jsdelivr.net/npm/sipkit-ui@0.1.0/dist/sipkit.iife.js` (pin the version).

| Entry | What it is |
| --- | --- |
| `sipkit-ui` | React components (`Softphone`, screens) + re-exported `sipkit-react` hooks |
| `sipkit-ui/styles.css` | The widget stylesheet (tokens + utilities, scoped to `.sipkit-phone`). Import it once |
| `sipkit-ui/embed` | Registers `<sipkit-phone>` using your bundler's React copy (ESM) |
| `sipkit-ui/sipkit.iife.js` | Self-contained `<script>` bundle that registers `<sipkit-phone>` and `window.Sipkit` |
| `sipkit-ui/sipkit-push-sw.js` | Push service worker for incoming-call notifications (serve it from your origin) |

## React

```tsx
import { createSoftphone, callHistoryPlugin, contactsPlugin } from 'sipkit-core';
import { Softphone } from 'sipkit-ui';
import 'sipkit-ui/styles.css';

const phone = createSoftphone({
  config: { username: '1001', password: '…', websocketUrls: ['wss://pbx:8089/ws'], brandName: 'Acme' },
  plugins: [callHistoryPlugin(), contactsPlugin()],
});

<Softphone softphone={phone} layout="compact" theme="system" brandColor="#0f766e" />;
```

| Prop | Default | |
| --- | --- | --- |
| `softphone` | – | Any `SoftphoneApi`. Leave it out when you render inside `<SoftphoneProvider>`. |
| `layout` | `'compact'` | `'compact'` is a 320–420px widget, 640px tall (override with `--sipkit-height`). `'full'` fills its container and shows the phone, tabs and panels side by side. |
| `theme` | `'system'` | `'light'`, `'dark'` or `'system'` (follows `prefers-color-scheme` live). Users can switch it from the menu or Settings. |
| `brandColor` | – | Shorthand for `themeTokens={{ primary }}`. |
| `themeTokens` | – | Runtime token overrides, e.g. `{ primary: '#0a7', radius: '0.5rem', dark: { primary: '#3dd6a0' } }`. See [docs/theming.md](../../docs/theming.md). |
| `extensions` / `slots` | – | See [Extending](#extending). |
| `contacts` | `[]` | Extra contacts, merged with the `contacts` plugin. |
| `hotkeys` | `true` | `true` means shortcuts work while focus is in the widget. `'global'` means anywhere on the page. `false` turns them off. |
| `toaster` | `true` | Shows `notification` events as toasts. Also respects `config.showToasts`. |
| `showLogin` | `true` | Shows the sign-in form while unregistered or after a failed registration. |
| `persistHistory` | `true` | The built-in history recorder stores calls in localStorage. It is only used when no `call-history` plugin is installed. |
| `defaultTab`, `onTabChange` | – | Tab ids: `phone`, `history`, `contacts`, `settings`, or an extension tab id. |

Config the UI reads:

- `config.brandName`: shown in the header and used as the region label.
- `config.disabledFeatures`: case-insensitive. Accepted keys are `history`, `contacts`, `settings`, `conference` (hides Add call and Merge) and `transfer`.
- `config.defaultTransferType`, `config.maxLines`, `config.autoAnswer`, `config.rejectOnBusy` and `config.showToasts`.

**Keyboard:**

| Key | Action |
| --- | --- |
| Enter | Call the typed number, or answer a ringing call |
| Esc | Reject a ringing call, or hang up |
| `0-9 * #` | Dial, or send DTMF during a call |
| Backspace | Delete the last digit |

On the dialpad, a long press on 0 types `+`. Pasted numbers have their formatting removed.

### Compose your own layout

Every screen is exported on its own. Render them inside `<SoftphoneProvider>`:

- `StatusBar`, `RegistrationPill`, `LoginForm`, `Dialpad`
- `CallScreen`, `IncomingCallCard`, `LineSwitcher`, `TransferDialog`
- `CallHistory`, `ContactsList`, `Settings`, `SoftphoneToaster`

All hooks from `sipkit-react` are re-exported.

## Extending

Hosts can add features without forking the package. A CRM tab is a typical example.

```tsx
<Softphone
  softphone={phone}
  extensions={{
    // Extra tabs. Built-in order: phone 0, history 10, contacts 20, settings 100. Default order is 50.
    tabs: [{ id: 'crm', label: 'CRM', icon: <BuildingIcon />, order: 25, render: (ctx) => <Crm number={ctx.activeCall?.remoteNumber} /> }],
    // Extra buttons in the in-call action grid.
    callActions: [{ id: 'ticket', label: 'Ticket', icon: <TicketIcon />, onSelect: (call, ctx) => openTicket(call.remoteNumber) }],
    // Panels: a right-hand column in the full layout, below the phone in compact (when showInCompact is set).
    panels: [{ id: 'customer', title: 'Customer', when: 'in-call', showInCompact: false, render: (ctx) => <Customer call={ctx.activeCall} /> }],
  }}
  slots={{
    callInfo: (call) => <CrmBadge number={call.remoteNumber} />, // under the caller name (call screen + incoming card)
    headerActions: () => <HelpButton />,                         // status bar, before the menu
    idleBanner: () => <QueueStats />,                            // above the dialpad
    loginFooter: () => <a href="/help">Need help?</a>,
    footer: () => <AgentStatus />,                               // bottom of the widget
  }}
/>
```

Every render function receives a `SoftphoneRenderContext` with these fields:

| Field | |
| --- | --- |
| `api` | The softphone instance |
| `snapshot` | The current softphone state |
| `activeCall` | The call the user is interacting with, or `null` |
| `dial(number)` | Places a call |
| `openTab(id)` | Switches tabs |

`callActions[].isVisible`, `isActive` (sets `aria-pressed`) and `isDisabled` each receive the call.

### Plugins

- History is read from the core plugin with id `call-history`, through `list()`, `onChange()` and `clear()`.
- Contacts are read from the plugin with id `contacts`, through `list()` and `onChange()`.
- If no history plugin is installed, the UI records `cdr` events itself.

## Theming

Design tokens are CSS variables declared on `:where(.sipkit-phone)`, so they have zero specificity. Override them from anywhere with the `--sipkit-*` hooks. The hooks are inherited, so they also reach into the Shadow DOM:

```css
.my-crm, sipkit-phone {
  --sipkit-primary: #0f766e;
  --sipkit-primary-foreground: #fff;
  --sipkit-radius: 0.5rem;
  --sipkit-font-sans: 'Roboto', sans-serif;
  --sipkit-height: 600px; /* compact widget height */
}
```

`--sipkit-<token>` applies to both themes; `--sipkit-dark-<token>` to the dark theme only. The full token
table, the `themeTokens` prop / `theme-tokens` attribute and the contrast rules are in
[docs/theming.md](../../docs/theming.md). Token values live in `src/theme/tokens.ts`; after editing it run
`pnpm --filter sipkit-ui gen:tokens` to regenerate the block in `styles.css`.

**Isolation from the host page:**

- **Web component:** fully isolated by the Shadow DOM.
- **React library:**
  - Tailwind's global preflight is not shipped. A reset scoped to `.sipkit-phone` replaces it.
  - The emitted `styles.css` has its `@layer` wrappers removed. Unlayered host rules such as `button {}` would otherwise beat the widget's utilities.
  - Utility class names are not prefixed.

**Popups:** dialogs, menus and tooltips portal into the widget root. This keeps them inside the theme scope and inside the shadow root.

## Web component

```html
<script src="sipkit.iife.js"></script>
<sipkit-phone
  username="1001" password="secret"
  ws-url="wss://pbx.example.com:8089/ws" domain="pbx.example.com"
  tech-prefix="9" brand-name="Acme Phone"
  theme="system" layout="compact" brand-color="#0f766e"
  disabled-features="contacts,conference"></sipkit-phone>
<script>
  const el = document.querySelector('sipkit-phone');
  el.addEventListener('sipkit:registration', (e) => console.log(e.detail.state));
  el.addEventListener('sipkit:call', (e) => console.log(e.detail.type, e.detail.call));  // created | updated | ended
  el.addEventListener('sipkit:cdr', (e) => saveCdr(e.detail));
  // el.softphone is the SoftphoneApi: el.softphone.call('1002')
</script>
```

**Attributes:**

- Config: `username`, `password`, `auth-username`, `display-name`, `ws-url` (comma-separated for failover), `domain`, `tech-prefix`, `brand-name`, `auto-register`, `auto-answer`, `max-lines`, `disabled-features`, `log-level`.
- UI: `theme`, `layout`, `brand-color`, `theme-tokens` (JSON, see [docs/theming.md](../../docs/theming.md)), `hotkeys`.

Changing a config attribute calls `updateConfig`.

**Properties:**

| Property | |
| --- | --- |
| `config` | A full config object, merged over the attributes |
| `factory` | Creates the softphone for this element |
| `softphone` | Pass an existing instance, or read the current one |
| `extensions`, `slots`, `contacts` | Same as the React props |
| `themeTokens` | Same as the React prop, merged over the `theme-tokens` attribute |

**Events:** `sipkit:ready`, `sipkit:registration`, `sipkit:call`, `sipkit:cdr`, `sipkit:notification`, `sipkit:error`. They bubble and are composed, so they cross the shadow boundary.

**Factory resolution**, in this order:

1. The element's `factory` property.
2. `window.Sipkit.setFactory(fn)`. You can also set `window.Sipkit = { factory }` before the script loads.
3. Core `createSoftphone({ config, plugins: [callHistoryPlugin(), contactsPlugin(), ringtonePlugin()] })`.

For demos without a PBX, use `Sipkit.setFactory(Sipkit.createMockSoftphone)`.

ESM hosts can `import 'sipkit-ui/embed'` to register the element and use their own React copy.

## Push service worker

`dist/sipkit-push-sw.js` (`sipkit-ui/sipkit-push-sw.js`) shows call notifications while the softphone tab is
closed. Serve it from your app's origin (default `/sipkit-push-sw.js`) and set `push` in the core config. See
[docs/push.md](../../docs/push.md).

## Development

```sh
pnpm typecheck && pnpm test && pnpm build   # build = library ESM + IIFE + push service worker
```

## License

MIT
