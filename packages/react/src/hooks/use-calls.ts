import type { Call } from 'sipkit-core';
import { shallowEqual } from '../equality';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

const LIVE = new Set<Call['state']>(['setup', 'ringing', 'early', 'connected', 'held']);

export function isLiveCall(call: Call): boolean {
  return LIVE.has(call.state);
}

/** True for an incoming call the user has not answered yet. */
export function isIncomingRinging(call: Call): boolean {
  return call.direction === 'incoming' && (call.state === 'ringing' || call.state === 'setup');
}

export interface UseCallsOptions {
  /** Include calls in `disconnected` state if the engine still lists them. Default false. */
  includeEnded?: boolean;
}

/** All calls (lines), sorted by line number. */
export function useCalls(options: UseCallsOptions = {}): Call[] {
  const includeEnded = options.includeEnded ?? false;
  return useSoftphoneSnapshot(
    (s) =>
      (includeEnded ? s.calls : s.calls.filter(isLiveCall)).slice().sort((a, b) => a.line - b.line),
    shallowEqual,
  );
}

/** Unanswered incoming calls. */
export function useIncomingCalls(): Call[] {
  return useSoftphoneSnapshot((s) => s.calls.filter(isIncomingRinging), shallowEqual);
}
