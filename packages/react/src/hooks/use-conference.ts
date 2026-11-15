import { useMemo } from 'react';
import { getConferenceView, type ConferenceView } from 'sipkit-core';
import { useCalls } from './use-calls';

/**
 * The current conference (local mix or server ConfBridge room), or null.
 * Render controls from `capabilities`, never from the configured mode.
 */
export function useConference(): ConferenceView | null {
  const calls = useCalls();
  return useMemo(() => getConferenceView(calls), [calls]);
}
