/**
 * Default asset locations: the files shipped in `dist/assets/`, resolved against this module.
 *
 * The `new URL('<literal>', import.meta.url)` form is deliberate: Vite, webpack 5, Rollup and
 * Parcel detect it and emit the file as an asset, and from a CDN it resolves next to the bundle.
 * Keep each path a string literal so bundlers can see it.
 */

export type NoiseModel = 'rnnoise' | 'speex';

export interface NoiseAssetUrls {
  /** AudioWorklet processor module. */
  workletUrl: string;
  /** Wasm binary. */
  wasmUrl: string;
  /** Wasm binary built with SIMD (RNNoise only); used when the browser supports wasm SIMD. */
  simdWasmUrl?: string;
}

export const ASSET_FILES: Record<NoiseModel, { worklet: string; wasm: string; simdWasm?: string }> =
  {
    rnnoise: { worklet: 'rnnoise-worklet.js', wasm: 'rnnoise.wasm', simdWasm: 'rnnoise_simd.wasm' },
    speex: { worklet: 'speex-worklet.js', wasm: 'speex.wasm' },
  };

function bundled(model: NoiseModel): NoiseAssetUrls {
  if (model === 'speex') {
    return {
      workletUrl: new URL('./assets/speex-worklet.js', import.meta.url).href,
      wasmUrl: new URL('./assets/speex.wasm', import.meta.url).href,
    };
  }
  return {
    workletUrl: new URL('./assets/rnnoise-worklet.js', import.meta.url).href,
    wasmUrl: new URL('./assets/rnnoise.wasm', import.meta.url).href,
    simdWasmUrl: new URL('./assets/rnnoise_simd.wasm', import.meta.url).href,
  };
}

/** Explicit URLs win, then `assetsBaseUrl`, then the files shipped with the package. */
export function resolveAssetUrls(
  model: NoiseModel,
  overrides: Partial<NoiseAssetUrls> & { assetsBaseUrl?: string },
): NoiseAssetUrls {
  const { assetsBaseUrl, ...explicit } = overrides;
  let base: NoiseAssetUrls | undefined;
  const fallback = () => (base ??= fromBase(model, assetsBaseUrl) ?? bundled(model));
  const wasmUrl = explicit.wasmUrl ?? fallback().wasmUrl;
  return {
    workletUrl: explicit.workletUrl ?? fallback().workletUrl,
    wasmUrl,
    // An explicit plain wasm URL without a SIMD one means "use exactly this file".
    simdWasmUrl:
      model === 'rnnoise'
        ? (explicit.simdWasmUrl ?? (explicit.wasmUrl ? undefined : fallback().simdWasmUrl))
        : undefined,
  };
}

function fromBase(model: NoiseModel, baseUrl: string | undefined): NoiseAssetUrls | undefined {
  if (!baseUrl) return undefined;
  const dir = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const files = ASSET_FILES[model];
  const at = (file: string) =>
    /^[a-z][a-z0-9+.-]*:/i.test(dir) ? new URL(file, dir).href : dir + file;
  return {
    workletUrl: at(files.worklet),
    wasmUrl: at(files.wasm),
    simdWasmUrl: files.simdWasm ? at(files.simdWasm) : undefined,
  };
}
