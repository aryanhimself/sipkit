import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { SoftphoneSnapshot } from 'sipkit-core';
import { useSoftphone } from './use-softphone';

const identity = <T,>(x: T) => x;

/**
 * Subscribe to the softphone snapshot (or a slice of it).
 *
 * The component re-renders only when the selected value changes according to
 * `isEqual` (default `Object.is`). Selectors may be inline functions.
 *
 * ```ts
 * const state = useSoftphoneSnapshot((s) => s.registration.state);
 * const ids = useSoftphoneSnapshot((s) => s.calls.map((c) => c.id), shallowEqual);
 * ```
 */
export function useSoftphoneSnapshot(): SoftphoneSnapshot;
export function useSoftphoneSnapshot<T>(
  selector: (snapshot: SoftphoneSnapshot) => T,
  isEqual?: (a: T, b: T) => boolean,
): T;
export function useSoftphoneSnapshot<T>(
  selector: (snapshot: SoftphoneSnapshot) => T = identity as (s: SoftphoneSnapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const api = useSoftphone();
  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);
  selectorRef.current = selector;
  isEqualRef.current = isEqual;

  // Memoize per snapshot object so getSnapshot is stable between store changes.
  const cache = useRef<{ snapshot: SoftphoneSnapshot; selector: unknown; value: T } | null>(null);

  const getSelection = useCallback((): T => {
    const snapshot = api.getSnapshot();
    const prev = cache.current;
    if (prev && prev.snapshot === snapshot && prev.selector === selectorRef.current) {
      return prev.value;
    }
    const next = selectorRef.current(snapshot);
    if (prev && isEqualRef.current(prev.value, next)) {
      cache.current = { snapshot, selector: selectorRef.current, value: prev.value };
      return prev.value;
    }
    cache.current = { snapshot, selector: selectorRef.current, value: next };
    return next;
  }, [api]);

  const subscribe = useCallback((onChange: () => void) => api.subscribe(onChange), [api]);

  return useSyncExternalStore(subscribe, getSelection, getSelection);
}
