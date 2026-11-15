import type { Call } from 'sipkit-core';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

/** The call the user is currently interacting with, or null. */
export function useActiveCall(): Call | null {
  return useSoftphoneSnapshot((s) => {
    if (!s.activeCallId) return null;
    return s.calls.find((c) => c.id === s.activeCallId) ?? null;
  });
}
