import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

/**
 * A plugin's public API by id, or undefined if the plugin is not installed.
 * Re-evaluated whenever the softphone state changes (plugins set up async).
 */
export function usePlugin<T = unknown>(id: string): T | undefined {
  const api = useSoftphone();
  return useSoftphoneSnapshot(() => api.plugin<T>(id));
}
