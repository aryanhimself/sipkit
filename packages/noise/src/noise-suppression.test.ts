import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Logger, PluginContext, PluginInstance, SoftphonePlugin } from 'sipkit-core';
import {
  noiseSuppression,
  type NoiseSuppressionApi,
  type NoiseSuppressionOptions,
} from './noise-suppression';
import { resolveAssetUrls } from './assets';

// ---------------------------------------------------------------------------
// Web Audio fakes: just enough of the API to record how the graph is wired.
// ---------------------------------------------------------------------------

const fakes = vi.hoisted(() => {
  class FakeTrack {
    enabled = true;
    readyState = 'live';
    stop = vi.fn(() => {
      this.readyState = 'ended';
    });
  }
  class FakeMediaStream {
    constructor(private readonly tracks: FakeTrack[] = []) {}
    getAudioTracks() {
      return this.tracks;
    }
    getTracks() {
      return this.tracks;
    }
  }
  class FakeParam {
    value = 1;
    cancelScheduledValues = vi.fn();
    setTargetAtTime = vi.fn((v: number) => {
      this.value = v;
    });
  }
  class FakeNode {
    readonly outputs = new Set<FakeNode>();
    channelCount = 2;
    channelCountMode = 'max';
    channelInterpretation = 'speakers';
    constructor(
      readonly context: FakeAudioContext,
      readonly kind: string,
    ) {
      context.nodes.push(this);
    }
    connect(node: FakeNode) {
      this.outputs.add(node);
      return node;
    }
    disconnect(node?: FakeNode) {
      if (node) this.outputs.delete(node);
      else this.outputs.clear();
    }
  }
  class FakeGain extends FakeNode {
    readonly gain = new FakeParam();
  }
  class FakeDestination extends FakeNode {
    readonly stream = new FakeMediaStream([new FakeTrack()]);
  }
  class FakeWorkletNode extends FakeNode {
    readonly port = { close: vi.fn(), postMessage: vi.fn() };
    readonly listeners: Record<string, (() => void)[]> = {};
    destroy = vi.fn();
    constructor(
      context: FakeAudioContext,
      name: string,
      readonly options: unknown,
    ) {
      super(context, `worklet:${name}`);
    }
    addEventListener(type: string, fn: () => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type: string) {
      for (const fn of this.listeners[type] ?? []) fn();
    }
  }
  class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    /** Initial state for new contexts, and whether resume() works. */
    static initialState: 'running' | 'suspended' = 'running';
    static resumable = true;
    state: 'running' | 'suspended' | 'closed' = FakeAudioContext.initialState;
    readonly nodes: FakeNode[] = [];
    readonly currentTime = 0;
    private readonly worklet = { addModule: vi.fn(async (_url: string) => undefined) };
    // A prototype getter, like BaseAudioContext.audioWorklet (the support check looks there).
    get audioWorklet() {
      return this.worklet;
    }
    failSource = false;
    constructor(readonly options: { sampleRate?: number; latencyHint?: string }) {
      FakeAudioContext.instances.push(this);
    }
    createMediaStreamSource(stream: FakeMediaStream) {
      if (this.failSource) throw new Error('sample-rate mismatch');
      const node = new FakeNode(this, 'source');
      (node as FakeNode & { stream: FakeMediaStream }).stream = stream;
      return node;
    }
    createGain() {
      return new FakeGain(this, 'gain');
    }
    createMediaStreamDestination() {
      return new FakeDestination(this, 'destination');
    }
    resume = vi.fn(async () => {
      if (FakeAudioContext.resumable && this.state !== 'closed') this.state = 'running';
    });
    suspend = vi.fn(async () => {
      this.state = 'suspended';
    });
    close = vi.fn(async () => {
      this.state = 'closed';
    });
  }
  // The real classes only call `super(ctx, name, { processorOptions })`.
  class RnnoiseWorkletNode extends FakeWorkletNode {
    constructor(ctx: FakeAudioContext, options: unknown) {
      super(ctx, 'rnnoise', options);
    }
  }
  class SpeexWorkletNode extends FakeWorkletNode {
    constructor(ctx: FakeAudioContext, options: unknown) {
      super(ctx, 'speex', options);
    }
  }
  const lib = {
    RnnoiseWorkletNode,
    SpeexWorkletNode,
    loadRnnoise: vi.fn(async (_o: { url: string; simdUrl: string }) => new ArrayBuffer(8)),
    loadSpeex: vi.fn(async (_o: { url: string }) => new ArrayBuffer(4)),
  };
  return {
    FakeTrack,
    FakeMediaStream,
    FakeNode,
    FakeGain,
    FakeDestination,
    FakeWorkletNode,
    FakeAudioContext,
    lib,
  };
});

vi.mock('@sapphi-red/web-noise-suppressor', () => fakes.lib);

const {
  FakeAudioContext,
  FakeMediaStream,
  FakeTrack,
  FakeWorkletNode,
  FakeGain,
  FakeDestination,
  lib,
} = fakes;
type Ctx = InstanceType<typeof FakeAudioContext>;
type Node = InstanceType<typeof fakes.FakeNode>;

function makeLogger(): Logger &
  Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn>> {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

let compile: MockInstance<typeof WebAssembly.compile>;

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = 'running';
  FakeAudioContext.resumable = true;
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  compile = vi.spyOn(WebAssembly, 'compile').mockResolvedValue({} as WebAssembly.Module);
  lib.loadRnnoise.mockClear();
  lib.loadSpeex.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup(options: NoiseSuppressionOptions = {}) {
  const logger = makeLogger();
  const plugin = noiseSuppression(options);
  const instance = (await plugin.setup({
    logger,
  } as unknown as PluginContext)) as PluginInstance<NoiseSuppressionApi>;
  const api = instance.api!;
  const process = (stream = mic()) =>
    instance.hooks!.processMicrophone!(stream as unknown as MediaStream) as Promise<
      { stream: MediaStream; dispose(): void } | undefined
    >;
  return { plugin, instance, api, logger, process };
}

function mic() {
  return new FakeMediaStream([new FakeTrack()]);
}

function graphOf(ctx: Ctx) {
  const find = <T extends Node>(pred: (n: Node) => boolean) => ctx.nodes.filter(pred) as T[];
  const sources = find((n) => n.kind === 'source');
  const worklets = find<InstanceType<typeof FakeWorkletNode>>((n) => n instanceof FakeWorkletNode);
  const destinations = find<InstanceType<typeof FakeDestination>>(
    (n) => n instanceof FakeDestination,
  );
  const gains = find<InstanceType<typeof FakeGain>>((n) => n instanceof FakeGain);
  const at = (i: number) => {
    const source = sources[i]!;
    const worklet = worklets[i]!;
    const destination = destinations[i]!;
    const wet = [...worklet.outputs][0] as InstanceType<typeof FakeGain>;
    const dry = gains.filter((g) => g !== wet && source.outputs.has(g))[0]!;
    return { source, worklet, destination, wet, dry };
  };
  return { at, count: sources.length };
}

describe('noiseSuppression()', () => {
  it('is a sipkit plugin with a stable id', () => {
    const plugin: SoftphonePlugin<unknown> = noiseSuppression();
    expect(plugin.id).toBe('noise-suppression');
  });

  it('builds MediaStreamSource → worklet → MediaStreamDestination at 48 kHz', async () => {
    const { process, api } = await setup();
    const input = mic();
    const result = await process(input);

    expect(result).toBeDefined();
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.options.sampleRate).toBe(48_000);
    const { source, worklet, destination, wet, dry } = graphOf(ctx).at(0);
    expect((source as Node & { stream: unknown }).stream).toBe(input);
    expect(worklet.kind).toBe('worklet:rnnoise');
    expect(worklet.options).toEqual({ maxChannels: 1, wasmBinary: expect.any(ArrayBuffer) });
    expect(worklet.channelCount).toBe(1);
    expect(worklet.channelCountMode).toBe('explicit');
    expect(source.outputs.has(worklet)).toBe(true);
    expect(wet.outputs.has(destination)).toBe(true);
    expect(dry.outputs.has(destination)).toBe(true);
    expect(wet.gain.value).toBe(1);
    expect(dry.gain.value).toBe(0);
    // The engine sends and mutes (track.enabled) this exact track.
    expect(result!.stream).toBe(destination.stream);
    expect(api.state).toMatchObject({ status: 'ready', active: 1, error: null, supported: true });
  });

  it('loads nothing until the first call, then uses the bundled assets', async () => {
    const { process } = await setup();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(lib.loadRnnoise).not.toHaveBeenCalled();

    await process();
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith(
      expect.stringMatching(/\/assets\/rnnoise-worklet\.js$/),
    );
    expect(lib.loadRnnoise).toHaveBeenCalledWith({
      url: expect.stringMatching(/\/assets\/rnnoise\.wasm$/),
      simdUrl: expect.stringMatching(/\/assets\/rnnoise_simd\.wasm$/),
    });
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('honours asset overrides', async () => {
    const { process } = await setup({
      assetsBaseUrl: 'https://cdn.example.com/noise/',
      workletUrl: '/w.js',
    });
    await process();
    expect(FakeAudioContext.instances[0]!.audioWorklet.addModule).toHaveBeenCalledWith('/w.js');
    expect(lib.loadRnnoise).toHaveBeenCalledWith({
      url: 'https://cdn.example.com/noise/rnnoise.wasm',
      simdUrl: 'https://cdn.example.com/noise/rnnoise_simd.wasm',
    });
  });

  it('supports the speex model', async () => {
    const { process } = await setup({ model: 'speex' });
    await process();
    const ctx = FakeAudioContext.instances[0]!;
    expect(graphOf(ctx).at(0).worklet.kind).toBe('worklet:speex');
    expect(lib.loadSpeex).toHaveBeenCalledWith({
      url: expect.stringMatching(/\/assets\/speex\.wasm$/),
    });
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith(
      expect.stringMatching(/\/assets\/speex-worklet\.js$/),
    );
  });

  it('setEnabled() switches calls in progress live, without a new stream', async () => {
    const { process, api } = await setup();
    const listener = vi.fn();
    api.subscribe(listener);
    const result = await process();
    const { source, worklet, wet, dry } = graphOf(FakeAudioContext.instances[0]!).at(0);
    listener.mockClear();

    api.setEnabled(false);
    expect(api.enabled).toBe(false);
    expect(source.outputs.has(worklet)).toBe(false); // worklet idle, no CPU
    expect(wet.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, expect.any(Number));
    expect(dry.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, expect.any(Number));
    expect(wet.gain.value).toBe(0);
    expect(dry.gain.value).toBe(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));

    api.setEnabled(true);
    expect(source.outputs.has(worklet)).toBe(true);
    expect(wet.gain.value).toBe(1);
    expect(dry.gain.value).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(result!.stream).toBe(graphOf(FakeAudioContext.instances[0]!).at(0).destination.stream);

    api.setEnabled(true); // no-op
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('starts bypassed with enabled: false and can be turned on mid-call', async () => {
    const { process, api } = await setup({ enabled: false });
    expect(await process()).toBeDefined();
    const { source, worklet, wet, dry } = graphOf(FakeAudioContext.instances[0]!).at(0);
    expect(source.outputs.has(worklet)).toBe(false);
    expect([wet.gain.value, dry.gain.value]).toEqual([0, 1]);
    api.setEnabled(true);
    expect(source.outputs.has(worklet)).toBe(true);
    expect([wet.gain.value, dry.gain.value]).toEqual([1, 0]);
  });

  it('shares one AudioContext and one model load across calls', async () => {
    const { process, api } = await setup();
    const [a, b] = await Promise.all([process(), process()]);
    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(lib.loadRnnoise).toHaveBeenCalledTimes(1);
    expect(graphOf(ctx).count).toBe(2);
    expect(api.state.active).toBe(2);

    api.setEnabled(false);
    expect(graphOf(ctx).at(0).dry.gain.value).toBe(1);
    expect(graphOf(ctx).at(1).dry.gain.value).toBe(1);

    a!.dispose();
    expect(ctx.state).toBe('running');
    b!.dispose();
    expect(api.state.active).toBe(0);
    expect(ctx.suspend).toHaveBeenCalledTimes(1); // idle: release the audio thread
    expect(ctx.close).not.toHaveBeenCalled();

    // The next call resumes the same context.
    await process();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ctx.resume).toHaveBeenCalled();
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1);
  });

  it('dispose() of a call releases its graph exactly once', async () => {
    const { process } = await setup();
    const result = await process();
    const { source, worklet, destination, wet, dry } = graphOf(FakeAudioContext.instances[0]!).at(
      0,
    );
    result!.dispose();
    result!.dispose();
    for (const node of [source, worklet, wet, dry, destination]) expect(node.outputs.size).toBe(0);
    expect(worklet.destroy).toHaveBeenCalledTimes(1);
    expect(worklet.port.close).toHaveBeenCalledTimes(1);
    expect(destination.stream.getTracks()[0]!.stop).toHaveBeenCalled();
  });

  it('plugin dispose closes the shared context and live graphs', async () => {
    const { process, instance } = await setup();
    await process();
    const ctx = FakeAudioContext.instances[0]!;
    const { worklet } = graphOf(ctx).at(0);
    await instance.dispose!();
    expect(worklet.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(await process()).toBeUndefined();
  });

  describe('falls back to the raw microphone', () => {
    it('without AudioWorklet', async () => {
      vi.stubGlobal('AudioWorkletNode', undefined);
      const { process, api, logger } = await setup();
      expect(api.supported).toBe(false);
      expect(await process()).toBeUndefined();
      expect(await process()).toBeUndefined();
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(logger.info).toHaveBeenCalledTimes(1);
    });

    it('when the worklet module fails to load, and retries on the next call', async () => {
      const { process, api, logger } = await setup();
      lib.loadRnnoise.mockRejectedValueOnce(new Error('network down'));
      expect(await process()).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('raw microphone'),
        expect.any(Error),
      );
      expect(api.state).toMatchObject({ status: 'error', error: 'network down', active: 0 });

      expect(await process()).toBeDefined();
      expect(lib.loadRnnoise).toHaveBeenCalledTimes(2);
      expect(api.state).toMatchObject({ status: 'ready', error: null });
    });

    it('when wasm compilation is blocked (CSP)', async () => {
      compile.mockRejectedValueOnce(new Error('wasm-unsafe-eval'));
      const { process, api } = await setup();
      expect(await process()).toBeUndefined();
      expect(api.state.error).toBe('wasm-unsafe-eval');
      expect(FakeAudioContext.instances[0]!.nodes).toHaveLength(0);
    });

    it('when the AudioContext stays suspended', async () => {
      FakeAudioContext.initialState = 'suspended';
      FakeAudioContext.resumable = false;
      const { process, api } = await setup({ resumeTimeoutMs: 5 });
      expect(await process()).toBeUndefined();
      expect(api.state.error).toMatch(/suspended/);
    });

    it('when the graph cannot be built, leaving nothing connected', async () => {
      const { process } = await setup();
      await process();
      const ctx = FakeAudioContext.instances[0]!;
      ctx.failSource = true;
      expect(await process()).toBeUndefined();
      expect(graphOf(ctx).count).toBe(1);
    });

    it('when the worklet crashes mid-call', async () => {
      const { process, api, logger } = await setup();
      await process();
      const { source, worklet, wet, dry } = graphOf(FakeAudioContext.instances[0]!).at(0);
      worklet.emit('processorerror');
      expect(logger.error).toHaveBeenCalled();
      expect(source.outputs.has(worklet)).toBe(false);
      expect([wet.gain.value, dry.gain.value]).toEqual([0, 1]);
      api.setEnabled(false);
      api.setEnabled(true); // stays bypassed
      expect(source.outputs.has(worklet)).toBe(false);
    });
  });

  it('passes streams without audio through untouched', async () => {
    const { process } = await setup();
    expect(await process(new FakeMediaStream([]))).toBeUndefined();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});

describe('resolveAssetUrls()', () => {
  it('builds URLs from a base folder', () => {
    expect(resolveAssetUrls('speex', { assetsBaseUrl: '/static/noise' })).toEqual({
      workletUrl: '/static/noise/speex-worklet.js',
      wasmUrl: '/static/noise/speex.wasm',
      simdWasmUrl: undefined,
    });
  });

  it('uses an explicit wasm URL as-is (no SIMD variant)', () => {
    const urls = resolveAssetUrls('rnnoise', { wasmUrl: '/r.wasm', workletUrl: '/w.js' });
    expect(urls).toEqual({ workletUrl: '/w.js', wasmUrl: '/r.wasm', simdWasmUrl: undefined });
  });

  it('defaults to files next to the module', () => {
    const urls = resolveAssetUrls('rnnoise', {});
    expect(urls.workletUrl).toMatch(/\/assets\/rnnoise-worklet\.js$/);
    expect(urls.simdWasmUrl).toMatch(/\/assets\/rnnoise_simd\.wasm$/);
  });
});
