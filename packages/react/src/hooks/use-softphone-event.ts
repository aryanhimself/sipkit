import { useEffect, useRef } from 'react';
import type { SoftphoneEvents } from 'sipkit-core';
import { useSoftphone } from './use-softphone';

/**
 * Subscribe to a softphone event for the lifetime of the component. The
 * handler may change between renders without resubscribing.
 */
export function useSoftphoneEvent<K extends keyof SoftphoneEvents>(
  event: K,
  handler: (payload: SoftphoneEvents[K]) => void,
  options: { enabled?: boolean } = {},
): void {
  const api = useSoftphone();
  const ref = useRef(handler);
  ref.current = handler;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    return api.on(event, (payload) => ref.current(payload));
  }, [api, event, enabled]);
}
