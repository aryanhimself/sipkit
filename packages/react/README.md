# sipkit-react

React bindings for [`sipkit-core`](https://www.npmjs.com/package/sipkit-core), the embeddable
SIP/WebRTC softphone: a provider plus hooks built on `useSyncExternalStore`. Use it to build your
own phone UI. For a finished widget, see [`sipkit-ui`](https://www.npmjs.com/package/sipkit-ui).

## Install

```sh
npm install sipkit-react sipkit-core react
```

`react` 18 or 19 is a peer dependency. ESM only.

## Quick start

```tsx
import { createSoftphone } from 'sipkit-core';
import { SoftphoneProvider, useRegistration, useActiveCall, useSoftphone } from 'sipkit-react';

const softphone = createSoftphone({
  config: { websocketUrls: ['wss://pbx.example.com:8089/ws'], username: '1001', password: '…' },
});

function Phone() {
  const api = useSoftphone();
  const { state, isRegistered } = useRegistration();
  const call = useActiveCall();
  return (
    <div>
      <p>Registration: {state}</p>
      {call ? (
        <button onClick={() => api.hangup(call.id)}>Hang up {call.remoteNumber}</button>
      ) : (
        <button disabled={!isRegistered} onClick={() => api.call('1002')}>Call 1002</button>
      )}
    </div>
  );
}

export const App = () => (
  <SoftphoneProvider softphone={softphone}>
    <Phone />
  </SoftphoneProvider>
);
```

`SoftphoneProvider` takes either an existing `softphone` (you own its lifecycle) or
`config` + `factory` (for example `factory={createSoftphone}`; the provider creates, starts and
stops it).

## Hooks

| Hook | Returns |
| --- | --- |
| `useSoftphone()` / `useOptionalSoftphone()` | The `SoftphoneApi` from the provider |
| `useSoftphoneSnapshot(selector, equal?)` | Any slice of the snapshot, re-rendering only when it changes |
| `useRegistration()` | Registration status + `isRegistered` / `isPending` |
| `useCalls()`, `useIncomingCalls()`, `useActiveCall()`, `useCallTimer()` | Calls and timers |
| `useDevices()` | Audio/video devices and selection |
| `useDnd()`, `useVoicemail()`, `useVoicemailList()`, `useVoicemailPlayer()` | DND, MWI, voicemail list and playback |
| `usePresence()`, `usePresenceOf()`, `useChat()`, `useConversation()` | Presence / BLF and SIP MESSAGE chat |
| `useConference()`, `useCallQuality()`, `useCallVideo()`, `usePush()` | Conferences, MOS quality, video streams, Web Push |
| `useSoftphoneEvent(name, handler)`, `usePlugin(id)` | Typed events and plugin APIs |

## Testing utilities

`sipkit-react/testing` exports **`MockSoftphone` / `createMockSoftphone()`**, a scripted, in-memory
`SoftphoneApi` for demos, Storybook and tests (no PBX, no WebRTC). It is not meant for production
code.

```tsx
import { createMockSoftphone } from 'sipkit-react/testing';

const mock = createMockSoftphone({ username: '1001' });
await mock.start();                 // "registers" in memory
mock.simulateIncomingCall('1002', 'Jane Doe');
```

## License

MIT
