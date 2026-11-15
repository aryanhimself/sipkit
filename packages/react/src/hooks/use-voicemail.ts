import { useCallback } from 'react';
import {
  isFeatureEnabled,
  voicemailNumberFromAccount,
  type Call,
  type VoicemailState,
} from 'sipkit-core';
import { shallowEqual } from '../equality';
import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

export interface UseVoicemailResult extends VoicemailState {
  /** `voicemail.enabled` and "voicemail" not in `disabledFeatures`. */
  enabled: boolean;
  /** Number dialed by `call()`: config `voicemail.number`, else the server's Message-Account. */
  number: string | undefined;
  /** Dial the voicemail access number. */
  call: () => Promise<Call>;
}

/** Message waiting state (MWI) plus a one-click "dial voicemail" action. */
export function useVoicemail(): UseVoicemailResult {
  const api = useSoftphone();
  const state = useSoftphoneSnapshot((s) => s.voicemail, shallowEqual);
  const cfg = api.config;
  const call = useCallback(() => api.callVoicemail(), [api]);
  return {
    ...state,
    enabled: cfg.voicemail.enabled && isFeatureEnabled(cfg, 'voicemail'),
    number: cfg.voicemail.number.trim() || voicemailNumberFromAccount(state.account),
    call,
  };
}
