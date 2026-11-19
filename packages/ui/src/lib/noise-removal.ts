import { useEffect, useReducer } from 'react';
import { useSoftphone } from 'sipkit-react';

/** The part of the `sipkit-noise` plugin API the settings screen uses (duck-typed: no hard dependency). */
export interface NoiseRemovalApi {
  readonly enabled: boolean;
  readonly supported: boolean;
  setEnabled(on: boolean): void;
  subscribe(listener: () => void): () => void;
}

export const NOISE_PLUGIN_ID = 'noise-suppression';

function isNoiseApi(v: unknown): v is NoiseRemovalApi {
  const o = v as Partial<NoiseRemovalApi> | undefined;
  return Boolean(o && typeof o.setEnabled === 'function' && typeof o.subscribe === 'function');
}

/** The AI noise removal plugin, when installed; re-renders when it is switched on or off. */
export function useNoiseRemoval(): NoiseRemovalApi | undefined {
  const api = useSoftphone();
  const plugin = api.plugin<unknown>(NOISE_PLUGIN_ID);
  const noise = isNoiseApi(plugin) ? plugin : undefined;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => noise?.subscribe(bump), [noise]);
  return noise;
}
