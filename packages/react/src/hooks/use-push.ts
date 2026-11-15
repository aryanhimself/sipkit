import { useCallback } from 'react';
import { isFeatureEnabled, type PushState, type PushWorkerLabels } from 'sipkit-core';
import { shallowEqual } from '../equality';
import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

const OFF: PushState = { enabled: false, supported: false, permission: 'unsupported', subscribed: false, busy: false };

export interface UsePushResult extends PushState {
  /**
   * Push can be offered: `push.enabled`, "push" not in `disabledFeatures`, the
   * browser supports it and the softphone implementation has push.
   */
  available: boolean;
  /**
   * Ask for permission (when needed) and subscribe. Call from a click handler:
   * browsers only show the permission prompt for a user gesture. Rejects with
   * the failure; `error` on the state carries a code for the UI.
   */
  subscribe: () => Promise<PushState>;
  unsubscribe: () => Promise<PushState>;
  /** Subscribe when off, unsubscribe when on. Never rejects (see `error`). */
  toggle: () => Promise<void>;
  /** Localised notification texts for the service worker. */
  setLabels: (labels: Partial<PushWorkerLabels>) => void;
}

/** Web Push for incoming calls (V2-PUSH-01): permission, subscription and the pending notification click. */
export function usePush(): UsePushResult {
  const api = useSoftphone();
  const state = useSoftphoneSnapshot((s) => s.push ?? OFF, shallowEqual);
  const cfg = api.config;
  const subscribe = useCallback(() => {
    if (!api.subscribePush) return Promise.reject(new Error('Push is not supported by this softphone'));
    return api.subscribePush();
  }, [api]);
  const unsubscribe = useCallback(() => {
    if (!api.unsubscribePush) return Promise.resolve(api.getSnapshot().push ?? OFF);
    return api.unsubscribePush();
  }, [api]);
  const toggle = useCallback(async () => {
    const on = api.getSnapshot().push?.subscribed ?? false;
    await (on ? unsubscribe() : subscribe()).catch(() => undefined);
  }, [api, subscribe, unsubscribe]);
  const setLabels = useCallback((labels: Partial<PushWorkerLabels>) => api.setPushLabels?.(labels), [api]);
  return {
    ...state,
    available:
      Boolean(cfg.push?.enabled) && isFeatureEnabled(cfg, 'push') && state.supported && typeof api.subscribePush === 'function',
    subscribe,
    unsubscribe,
    toggle,
    setLabels,
  };
}
