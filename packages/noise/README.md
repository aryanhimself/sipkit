# sipkit-noise

A [`sipkit-core`](https://www.npmjs.com/package/sipkit-core) plugin that removes background noise
(fans, traffic, keyboards, chatter) from **your outgoing microphone** with a small neural network
running in the browser. The person you call hears your voice, not your room. Nothing leaves the
device: the model runs locally in an AudioWorklet.

```
microphone → MediaStreamSource → RNNoise (WebAssembly, AudioWorklet) → MediaStreamDestination → call
```

It is built on [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor)
(MIT), which packages [RNNoise](https://github.com/xiph/rnnoise) and the
[SpeexDSP](https://github.com/xiph/speexdsp) preprocessor as WebAssembly.

## Do you need it?

Browsers already apply their own noise suppression to the microphone. In sipkit that is on by
default and costs nothing extra (core config `audioProcessing.noiseSuppression`, plus
`voiceIsolation` where the OS supports it). Try that first. Add this plugin when built-in
suppression is not enough, for example in open offices, call centres or next to loud machines,
or when you want the same result in every browser.

## Install

```sh
npm install sipkit-noise sipkit-core
```

ESM only. `sipkit-core` is a peer dependency.

## Usage

```ts
import { createSoftphone } from 'sipkit-core';
import { noiseSuppression } from 'sipkit-noise';

const softphone = createSoftphone({
  config: {/* … */},
  plugins: [noiseSuppression()],
});
```

Every call (and every microphone switch during a call) now sends the cleaned-up audio. Muting
works as before.

### Turn it on and off during a call

```ts
import type { NoiseSuppressionApi } from 'sipkit-noise';

const noise = softphone.plugin<NoiseSuppressionApi>('noise-suppression')!;

noise.supported; // false when the browser lacks AudioWorklet or WebAssembly
noise.enabled; // true
noise.setEnabled(false); // takes effect at once on calls in progress, no renegotiation

const unsubscribe = noise.subscribe((state) => {
  // { enabled, supported, status: 'idle' | 'loading' | 'ready' | 'error', active, error, model }
  toggle.checked = state.enabled;
  toggle.disabled = !state.supported;
});
```

`noise.state` is an immutable snapshot that changes identity on every update, so it works with
React's `useSyncExternalStore(noise.subscribe, () => noise.state)`.

Switching is a short crossfade between the processed and the raw signal inside the audio graph.
While it is off the model is disconnected and uses no CPU.

### Options

```ts
noiseSuppression({
  enabled: true, // start on (default true)
  model: 'rnnoise', // 'rnnoise' (default) or 'speex'
  assetsBaseUrl: undefined, // folder with the worklet + wasm files (CDN, self-hosting)
  workletUrl: undefined, // or set each file explicitly
  wasmUrl: undefined,
  simdWasmUrl: undefined, // RNNoise only
  resumeTimeoutMs: 1000, // wait this long for a suspended AudioContext
});
```

| Model     | How it works                             | Good at                                                            | Download (gzip) |
| --------- | ---------------------------------------- | ------------------------------------------------------------------ | --------------- |
| `rnnoise` | Recurrent neural network on 10 ms frames | Non-stationary noise: keyboards, traffic, voices in the background | ~125 KB         |
| `speex`   | Classic spectral noise suppression       | Steady noise: fans, hum, hiss. Lighter on CPU                      | ~35 KB          |

## Assets: bundlers and CDNs

The model is not in your JavaScript bundle. Each model needs an AudioWorklet module and a wasm
binary, shipped in `sipkit-noise/dist/assets/`:

| File                                                      | Raw    | gzip   |
| --------------------------------------------------------- | ------ | ------ |
| `rnnoise-worklet.js`                                      | 64 KB  | 12 KB  |
| `rnnoise_simd.wasm` (used when the browser has wasm SIMD) | 157 KB | 115 KB |
| `rnnoise.wasm` (fallback)                                 | 153 KB | 113 KB |
| `speex-worklet.js`                                        | 11 KB  | 4 KB   |
| `speex.wasm`                                              | 56 KB  | 31 KB  |

The plugin code itself is about 3 KB gzip, plus a 0.7 KB chunk loaded with the model. Nothing is
fetched until the first call starts, and the files are fetched once per page.

**Bundlers (Vite, webpack 5, Rollup, Parcel).** The package refers to its files with
`new URL('./assets/…', import.meta.url)`, which bundlers pick up and copy to your build output.
No configuration is needed for production builds. For the Vite dev server, exclude the package
from dependency pre-bundling, otherwise the relative URLs point into Vite's cache:

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ['sipkit-noise'] },
});
```

Or import the URLs yourself, which works everywhere Vite runs:

```ts
import workletUrl from 'sipkit-noise/assets/rnnoise-worklet.js?url';
import wasmUrl from 'sipkit-noise/assets/rnnoise.wasm?url';
import simdWasmUrl from 'sipkit-noise/assets/rnnoise_simd.wasm?url';

noiseSuppression({ workletUrl, wasmUrl, simdWasmUrl });
```

**CDN or self-hosted files.** Loaded as a plain ES module from a CDN (with an import map entry for
`sipkit-core`), the default URLs resolve next to the module and just work. If your CDN rewrites modules (for example `+esm` builds), or
you copy the files to your own server, point the plugin at the folder:

```ts
noiseSuppression({ assetsBaseUrl: 'https://cdn.jsdelivr.net/npm/sipkit-noise@0.3.0/dist/assets/' });
// or, self-hosted: copy node_modules/sipkit-noise/dist/assets/* to /static/noise/
noiseSuppression({ assetsBaseUrl: '/static/noise/' });
```

Cross-origin files must be served with CORS headers (public npm CDNs do this).

## Content Security Policy

With a strict CSP, allow:

- `script-src`: the origin of the worklet file (AudioWorklet modules are scripts), and
  `'wasm-unsafe-eval'` (needed to compile WebAssembly).
- `connect-src`: the origin of the wasm files (they are fetched).

For example, self-hosted: `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' wss://pbx.example.com`.

The plugin compiles the wasm once on the main thread before using it, so a blocked compile is
detected and the call goes out with the raw microphone instead of silence.

## Cost

- **Latency:** about 10 ms added to your outgoing audio (RNNoise works on 10 ms frames, plus the
  AudioWorklet's 128-sample render quantum).
- **CPU:** RNNoise takes a few percent of one core per call on a typical laptop (less with wasm
  SIMD); Speex is lighter. It runs on the audio thread, not the main thread.
- **Download:** ~125 KB gzip for RNNoise, on the first call only. See the asset table above.
- **Memory:** a few MB for the wasm instance per call.

## Browser support

Needs `AudioWorklet` and WebAssembly, so a secure context (HTTPS or localhost): Chrome / Edge 66+,
Firefox 76+, Safari 14.1+, and Electron. Where they are missing, `supported` is `false` and calls
use the raw microphone (still with the browser's own processing).

The plugin runs one shared `AudioContext` at 48 kHz, the rate RNNoise is trained for. Older
Firefox versions cannot connect a microphone captured at a different rate; the plugin then falls
back to the raw microphone for that call and logs why.

## What happens when something fails

Noise removal must never cost you a call. If anything goes wrong (no AudioWorklet, wasm blocked,
a network error loading the files, an `AudioContext` the browser keeps suspended, the worklet
crashing mid-call) the plugin logs a warning through the softphone logger, sets `state.status`
to `'error'` with the reason in `state.error`, and the call uses the raw microphone. The next
call tries again.

## Lifecycle

- One `AudioContext` is shared by all calls. It is suspended when no call uses it and closed when
  the softphone is destroyed.
- Each call gets its own small graph and model instance, released when the call stops using the
  stream.

## License

MIT. The bundled worklet and wasm files come from `@sapphi-red/web-noise-suppressor` (MIT),
RNNoise (BSD-3-Clause), rnnoise-wasm (Apache-2.0) and SpeexDSP (BSD-3-Clause); see
`dist/assets/THIRD_PARTY_LICENSES.md`.
