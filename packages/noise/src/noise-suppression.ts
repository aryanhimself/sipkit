import { definePlugin } from 'sipkit-core';
import type { Logger, ProcessedMicrophone, Unsubscribe } from 'sipkit-core';
import { resolveAssetUrls, type NoiseAssetUrls, type NoiseModel } from './assets';

export const NOISE_SUPPRESSION_PLUGIN_ID = 'noise-suppression';

/** RNNoise is trained for 48 kHz; Speex works at any rate. One shared context runs at 48 kHz. */
const SAMPLE_RATE = 48_000;
/** Time constant of the wet/dry crossfade on a live toggle, in seconds (~50 ms to settle). */
const CROSSFADE_SECONDS = 0.015;

export interface NoiseSuppressionOptions {
  /** Start with noise removal on. Default true. Change it live with `setEnabled()`. */
  enabled?: boolean;
  /**
   * `'rnnoise'` (default): recurrent neural network, best on fans, traffic, keyboards, crowds.
   * `'speex'`: classic spectral suppressor, lighter and smaller, weaker on non-stationary noise.
   */
  model?: NoiseModel;
  /**
   * Folder that holds the worklet and wasm files (`rnnoise-worklet.js`, `rnnoise.wasm`,
   * `rnnoise_simd.wasm`, `speex-worklet.js`, `speex.wasm`), for a CDN or self-hosting.
   * Default: the files shipped in `sipkit-noise/dist/assets/`, resolved by your bundler.
   */
  assetsBaseUrl?: string;
  /** URL of the AudioWorklet processor module. Overrides `assetsBaseUrl`. */
  workletUrl?: string;
  /** URL of the wasm binary. Overrides `assetsBaseUrl`. */
  wasmUrl?: string;
  /** URL of the SIMD wasm binary (RNNoise only). Overrides `assetsBaseUrl`. */
  simdWasmUrl?: string;
  /** How long to wait for a suspended AudioContext to resume before falling back. Default 1000 ms. */
  resumeTimeoutMs?: number;
}

export type NoiseSuppressionStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface NoiseSuppressionState {
  /** The user's choice. Processing only happens on calls when also `supported`. */
  enabled: boolean;
  /** AudioWorklet and WebAssembly are available in this browser. */
  supported: boolean;
  /** `idle` until the first call, `loading` while fetching the model, then `ready` or `error`. */
  status: NoiseSuppressionStatus;
  /** Number of microphone streams currently routed through the plugin. */
  active: number;
  /** Why the last load failed (calls then use the raw microphone). Cleared on the next success. */
  error: string | null;
  model: NoiseModel;
}

/** Public API: `softphone.plugin<NoiseSuppressionApi>('noise-suppression')`. */
export interface NoiseSuppressionApi {
  readonly enabled: boolean;
  readonly supported: boolean;
  /** Immutable snapshot; a new object on every change (safe for `useSyncExternalStore`). */
  readonly state: NoiseSuppressionState;
  /** Turn noise removal on or off. Applies immediately to calls in progress, without renegotiation. */
  setEnabled(on: boolean): void;
  /** Called with the new state on every change. */
  subscribe(listener: (state: NoiseSuppressionState) => void): Unsubscribe;
}

type WorkletNode = AudioWorkletNode & { destroy?(): void };
type NodeFactory = (ctx: AudioContext) => WorkletNode;

interface Graph {
  apply(on: boolean, immediate?: boolean): void;
  dispose(): void;
}

/** True when the browser can run the processor: AudioWorklet in a secure context and WebAssembly. */
export function isNoiseSuppressionSupported(): boolean {
  const g = globalThis as {
    AudioContext?: unknown;
    AudioWorkletNode?: unknown;
    WebAssembly?: { compile?: unknown };
  };
  return (
    typeof g.AudioContext === 'function' &&
    typeof g.AudioWorkletNode === 'function' &&
    typeof g.WebAssembly?.compile === 'function' &&
    'audioWorklet' in (g.AudioContext as { prototype: object }).prototype
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Removes background noise from the outgoing microphone with a WebAssembly model in an
 * AudioWorklet: MediaStreamSource → noise worklet → MediaStreamDestination, at 48 kHz.
 *
 * Assets load on the first call, not at startup. When anything fails (no AudioWorklet, wasm
 * blocked by CSP, suspended AudioContext) the call goes ahead with the raw microphone.
 */
export function noiseSuppression(options: NoiseSuppressionOptions = {}) {
  return definePlugin<NoiseSuppressionApi>({
    id: NOISE_SUPPRESSION_PLUGIN_ID,
    setup({ logger }) {
      const model: NoiseModel = options.model ?? 'rnnoise';
      const urls = resolveAssetUrls(model, options);
      const resumeTimeoutMs = options.resumeTimeoutMs ?? 1000;
      const listeners = new Set<(state: NoiseSuppressionState) => void>();
      const graphs = new Set<Graph>();
      let state: NoiseSuppressionState = {
        enabled: options.enabled ?? true,
        supported: isNoiseSuppressionSupported(),
        status: 'idle',
        active: 0,
        error: null,
        model,
      };
      let context: AudioContext | undefined;
      let factory: Promise<NodeFactory> | undefined;
      let disposed = false;
      let warnedUnsupported = false;

      const update = (patch: Partial<NoiseSuppressionState>) => {
        const next = { ...state, ...patch };
        if (
          (Object.keys(patch) as (keyof NoiseSuppressionState)[]).every((k) => next[k] === state[k])
        )
          return;
        state = next;
        for (const listener of [...listeners]) {
          try {
            listener(state);
          } catch (err) {
            logger.error('noise suppression listener threw', err);
          }
        }
      };

      const getContext = (): AudioContext => {
        if (!context || context.state === 'closed') {
          context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
          factory = undefined; // worklet modules are registered per context
        }
        return context;
      };

      const loadFactory = (ctx: AudioContext): Promise<NodeFactory> => {
        factory ??= createFactory(ctx, model, urls).catch((err: unknown) => {
          factory = undefined; // retry on the next call (e.g. after a network error)
          throw err;
        });
        return factory;
      };

      const ensureRunning = async (ctx: AudioContext) => {
        if (ctx.state === 'running') return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          ctx.resume().catch(() => undefined),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, resumeTimeoutMs))),
        ]);
        clearTimeout(timer);
        if ((ctx.state as string) !== 'running') {
          throw new Error(`AudioContext is ${ctx.state} (no user gesture yet?)`);
        }
      };

      const processMicrophone = async (
        input: MediaStream,
      ): Promise<ProcessedMicrophone | undefined> => {
        if (disposed || input.getAudioTracks().length === 0) return undefined;
        if (!state.supported) {
          if (!warnedUnsupported) {
            warnedUnsupported = true;
            logger.info(
              'noise suppression needs AudioWorklet and WebAssembly; sending the raw microphone',
            );
          }
          return undefined;
        }
        let graph: Graph | undefined;
        try {
          if (state.status !== 'ready') update({ status: 'loading' });
          const ctx = getContext();
          const createNode = await loadFactory(ctx);
          await ensureRunning(ctx);
          if (disposed) return undefined;
          const built = buildGraph(ctx, input, createNode, logger, () => {
            graphs.delete(built.graph);
            update({ active: graphs.size });
            if (graphs.size === 0 && ctx.state === 'running')
              void ctx.suspend().catch(() => undefined);
          });
          graph = built.graph;
          graph.apply(state.enabled, true);
          graphs.add(graph);
          update({ status: 'ready', error: null, active: graphs.size });
          return { stream: built.stream, dispose: graph.dispose };
        } catch (err) {
          graph?.dispose();
          logger.warn('noise suppression unavailable, sending the raw microphone', err);
          update({ status: 'error', error: message(err) });
          return undefined;
        }
      };

      const api: NoiseSuppressionApi = {
        get enabled() {
          return state.enabled;
        },
        get supported() {
          return state.supported;
        },
        get state() {
          return state;
        },
        setEnabled(on) {
          if (on === state.enabled) return;
          for (const graph of graphs) graph.apply(on);
          update({ enabled: on });
          logger.debug(`noise suppression ${on ? 'on' : 'off'}`, { active: graphs.size });
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };

      return {
        api,
        hooks: { processMicrophone },
        async dispose() {
          disposed = true;
          for (const graph of [...graphs]) graph.dispose();
          listeners.clear();
          const ctx = context;
          context = undefined;
          factory = undefined;
          if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => undefined);
        },
      };
    },
  });
}

/** Fetch + validate the wasm, register the worklet module, and return a node constructor. */
async function createFactory(
  ctx: AudioContext,
  model: NoiseModel,
  urls: NoiseAssetUrls,
): Promise<NodeFactory> {
  // Lazy: the node classes extend AudioWorkletNode, so they must not load before it is needed.
  const lib = await import('@sapphi-red/web-noise-suppressor');
  const [wasmBinary] = await Promise.all([
    model === 'rnnoise'
      ? lib.loadRnnoise({ url: urls.wasmUrl, simdUrl: urls.simdWasmUrl ?? urls.wasmUrl })
      : lib.loadSpeex({ url: urls.wasmUrl }),
    ctx.audioWorklet.addModule(urls.workletUrl),
  ]);
  // The worklet compiles the binary asynchronously and outputs silence if that fails (e.g. CSP
  // without 'wasm-unsafe-eval', or an HTML 404 page). Compile once here so failures fall back.
  await WebAssembly.compile(wasmBinary);
  return model === 'rnnoise'
    ? (c) => new lib.RnnoiseWorkletNode(c, { maxChannels: 1, wasmBinary })
    : (c) => new lib.SpeexWorkletNode(c, { maxChannels: 1, wasmBinary });
}

/**
 * source ─┬─▶ worklet ─▶ wet gain ─┐
 *         └────────────▶ dry gain ─┴─▶ destination (sent on the call)
 *
 * On: source feeds the worklet, wet=1, dry=0. Off: the worklet is disconnected (idle, no CPU),
 * wet=0, dry=1. The destination track is what the engine mutes via `track.enabled`.
 */
function buildGraph(
  ctx: AudioContext,
  input: MediaStream,
  createNode: NodeFactory,
  logger: Logger,
  onDispose: () => void,
): { stream: MediaStream; graph: Graph } {
  const nodes: AudioNode[] = [];
  const track = <T extends AudioNode>(node: T): T => (nodes.push(node), node);
  let disposed = false;
  let wired = false;
  let failed = false;

  const teardown = () => {
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
    }
  };

  try {
    const source = track(ctx.createMediaStreamSource(input));
    const worklet = track(createNode(ctx));
    worklet.channelCount = 1;
    worklet.channelCountMode = 'explicit';
    worklet.channelInterpretation = 'speakers';
    const wet = track(ctx.createGain());
    const dry = track(ctx.createGain());
    const destination = track(ctx.createMediaStreamDestination());
    destination.channelCount = 1;

    worklet.connect(wet);
    wet.connect(destination);
    source.connect(dry);
    dry.connect(destination);

    const setGain = (param: AudioParam, value: number, immediate: boolean) => {
      if (immediate) {
        param.value = value;
        return;
      }
      param.cancelScheduledValues(ctx.currentTime);
      param.setTargetAtTime(value, ctx.currentTime, CROSSFADE_SECONDS);
    };

    const apply = (on: boolean, immediate = false) => {
      if (disposed) return;
      const process = on && !failed;
      if (process && !wired) {
        source.connect(worklet);
        wired = true;
      } else if (!process && wired) {
        source.disconnect(worklet);
        wired = false;
      }
      setGain(wet.gain, process ? 1 : 0, immediate);
      setGain(dry.gain, process ? 0 : 1, immediate);
    };

    worklet.addEventListener('processorerror', () => {
      logger.error(
        'noise suppression worklet crashed; this call continues with the raw microphone',
      );
      failed = true;
      apply(false, true);
    });

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      teardown();
      try {
        (worklet as WorkletNode).destroy?.();
        worklet.port.close();
      } catch (err) {
        logger.debug('noise worklet cleanup failed', err);
      }
      for (const t of destination.stream.getTracks()) t.stop();
      onDispose();
    };

    return { stream: destination.stream, graph: { apply, dispose } };
  } catch (err) {
    teardown();
    throw err;
  }
}
