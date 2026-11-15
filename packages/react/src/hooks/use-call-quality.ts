import type { CallId, CallQuality } from 'sipkit-core';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

/**
 * Latest media quality sample for a call (default: the active call), or null
 * before the first sample / when monitoring is off (`callQualityInterval: 0`).
 * Re-renders every `callQualityInterval` seconds while connected.
 */
export function useCallQuality(callId?: CallId | null): CallQuality | null {
  return useSoftphoneSnapshot((s) => {
    const id = callId ?? s.activeCallId;
    if (!id) return null;
    return s.calls.find((c) => c.id === id)?.quality ?? null;
  });
}
