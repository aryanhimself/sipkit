# Audio: noise, echo and microphone permission

How sipkit cleans up your microphone before it goes out on a call, and how it handles the
browser's microphone permission without asking more than once.

## Two levels of noise removal

| | Built-in (core) | AI noise removal (`sipkit-noise`) |
|---|---|---|
| What | The browser's own voice processing | RNNoise neural network in an AudioWorklet |
| Good for | Fans, hum, steady background noise, echo | Barking, traffic, keyboards, nearby voices |
| Cost | Nothing extra | ~127 KB gzip on the first call, ~10 ms delay, a little CPU |
| Default | On | Off until installed and switched on |

Start with the built-in level. Add the plugin when users still complain.

## Built-in voice processing

```ts
createSoftphone({
  config: {
    audioProcessing: {
      noiseSuppression: true, // default
      echoCancellation: true, // default
      autoGainControl: true,  // default
      voiceIsolation: false,  // default; Chrome + macOS Voice Isolation, ignored elsewhere
    },
  },
});
```

- Changes apply **live** on calls in progress: `api.updateConfig({ audioProcessing: { noiseSuppression: false } })`
  captures the mic again with the new settings and swaps the track. No re-INVITE, no prompt.
- The same settings apply when the user switches microphone mid-call.
- In sipkit-ui, **Settings → Audio** has switches for each, saved per account in `localStorage`
  (`sipkit:audio-prefs:<username>`). The user's choice wins over the host default on the next start.
- Turn echo cancellation off only for headsets that do their own.

## AI noise removal

```ts
import { noiseSuppression } from 'sipkit-noise';

createSoftphone({ config, plugins: [noiseSuppression()] });
```

- Lazy: the worklet and wasm load on the first call.
- `api.plugin('noise-suppression').setEnabled(false)` switches it off live (crossfade, no renegotiation).
- When installed, sipkit-ui shows an **AI noise removal** switch in Settings → Audio.
- If it cannot run (no AudioWorklet, wasm blocked by CSP), the call uses the raw mic and a warning is logged.
- Built-in suppression keeps running underneath; that is fine.

See [packages/noise/README.md](../packages/noise/README.md) for asset hosting, CSP and Vite notes.

### Writing your own microphone processor

Any plugin can transform the outgoing mic with `hooks.processMicrophone`:

```ts
definePlugin({
  id: 'my-filter',
  setup: () => ({
    hooks: {
      async processMicrophone(input) {
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(input).connect(/* your nodes */ dest);
        return { stream: dest.stream, dispose: () => void ctx.close() };
      },
    },
  }),
});
```

- Runs for every new call and every microphone switch, in plugin order; each hook gets the
  previous hook's output.
- Return `undefined` to pass the mic through. A throwing hook is skipped, so the call keeps audio.
- The engine stops the input tracks itself and calls `dispose()` once when the call stops using the stream.
- Keep `track.enabled` working on the stream you return: mute toggles it.

## Microphone permission

The browser decides whether to show a prompt; sipkit never asks when the answer is already known.

| `snapshot.devices.microphone` | What sipkit does |
|---|---|
| `granted` | Nothing. Calls start without a prompt. |
| `prompt` | Nothing until the first call (the browser asks then), or until the user clicks **Allow microphone** in Settings. |
| `denied` | Never calls `getUserMedia`. sipkit-ui shows "Microphone blocked" with how to unblock it. |
| `unknown` | The browser has no Permissions API for the mic. The first call asks. |

- The state is read with the Permissions API (no prompt) and follows changes the user makes in
  the site settings.
- `api.requestMicrophone()` prompts only in `prompt` / `unknown`, and concurrent callers share one prompt.
- A call that gets media marks the mic `granted`; a call that fails with a mic error re-reads the state.

### Why a browser may still ask every time

These are browser settings, not something a web page can change:

- **Chrome "Allow this time"**: the grant lasts until the tab closes. Pick "Allow on every visit".
- **Safari**: asks on each visit unless Settings → Websites → Microphone is set to **Allow** for the site.
- **Firefox**: tick **Remember this decision** in the prompt.
- **`file://` pages and plain `http://` hosts** other than localhost: grants are not kept. Serve the page over https.
- **Embedded webviews / in-app browsers**: the host app decides; many ask on every capture.
