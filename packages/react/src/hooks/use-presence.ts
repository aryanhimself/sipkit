import { useCallback, useMemo } from 'react';
import { isFeatureEnabled, type Call, type PresenceInfo } from 'sipkit-core';
import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

/** Own status. Asterisk does not accept presence PUBLISH from phones, so this is DND-based (docs/presence.md). */
export type OwnPresence = 'available' | 'dnd';

export interface UsePresenceResult {
  /** `presence.enabled` and "presence" not in `disabledFeatures`. */
  enabled: boolean;
  /** Watched extensions keyed by target. */
  presence: Record<string, PresenceInfo>;
  /** Watched extensions in watch order. */
  list: PresenceInfo[];
  /** Own status derived from Do Not Disturb. */
  own: OwnPresence;
  watch: (targets: string | string[]) => void;
  unwatch: (targets: string | string[]) => void;
  /** Directed call pickup of the call ringing at `extension`. */
  pickup: (extension: string) => Promise<Call>;
}

/** Presence / BLF state of all watched extensions, plus watch/unwatch/pickup. */
export function usePresence(): UsePresenceResult {
  const api = useSoftphone();
  const presence = useSoftphoneSnapshot((s) => s.presence);
  const dnd = useSoftphoneSnapshot((s) => s.dnd);
  const cfg = api.config;
  const watch = useCallback((t: string | string[]) => api.watch(t), [api]);
  const unwatch = useCallback((t: string | string[]) => api.unwatch(t), [api]);
  const pickup = useCallback((ext: string) => api.pickup(ext), [api]);
  const list = useMemo(() => Object.values(presence), [presence]);
  return {
    enabled: cfg.presence.enabled && isFeatureEnabled(cfg, 'presence'),
    presence,
    list,
    own: dnd ? 'dnd' : 'available',
    watch,
    unwatch,
    pickup,
  };
}

/** Presence of one extension (undefined when not watched). Re-renders only when it changes. */
export function usePresenceOf(target: string | undefined): PresenceInfo | undefined {
  return useSoftphoneSnapshot((s) => (target ? s.presence[target] : undefined));
}
