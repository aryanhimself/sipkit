import { useCallback } from 'react';
import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

export interface UseDndResult {
  /** Do Not Disturb is on: incoming calls are rejected automatically (or by the PBX). */
  dnd: boolean;
  /** Server-side DND (config `dnd.mode`): the feature-code call is still running. */
  pending: boolean;
  /** DND is enforced by the PBX (config `dnd.mode` 'server' | 'both'). */
  server: boolean;
  /**
   * Turn DND on/off. Resolves when applied. A server-side failure reverts the
   * toggle and is reported through a `dndServerFailed` notification, so the
   * returned promise never rejects; use `api.setDnd` to handle errors yourself.
   */
  setDnd: (on: boolean) => Promise<void>;
  toggle: () => Promise<void>;
}

/** Do Not Disturb state and setters. */
export function useDnd(): UseDndResult {
  const api = useSoftphone();
  const dnd = useSoftphoneSnapshot((s) => s.dnd);
  const pending = useSoftphoneSnapshot((s) => s.dndPending === true);
  const server = api.config.dnd.mode !== 'local';
  const setDnd = useCallback(
    (on: boolean) => Promise.resolve(api.setDnd(on)).catch(() => undefined),
    [api],
  );
  const toggle = useCallback(() => setDnd(!api.getSnapshot().dnd), [api, setDnd]);
  return { dnd, pending, server, setDnd, toggle };
}
