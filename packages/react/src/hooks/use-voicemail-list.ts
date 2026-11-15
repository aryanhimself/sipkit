import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_VOICEMAIL_LIST,
  isFeatureEnabled,
  isVoicemailListEnabled,
  type VoicemailListState,
  type VoicemailMessage,
} from 'sipkit-core';
import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

export interface UseVoicemailListResult extends VoicemailListState {
  /** `voicemail.enabled`, `voicemail.api.baseUrl` set, the API implemented, and "voicemail" not in `disabledFeatures`. */
  enabled: boolean;
  /** Reload the list. Rejects on failure (the error code is also in `error`). */
  refresh: () => Promise<VoicemailMessage[]>;
  markRead: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Download a recording as a Blob (bearer auth). See {@link useVoicemailPlayer}. */
  getAudio: (id: string) => Promise<Blob>;
  /** A mark-read / delete request for this id is in flight. */
  isPending: (id: string) => boolean;
}

function unsupported(): Promise<never> {
  return Promise.reject(new Error('Voicemail list is not supported by this softphone'));
}

/** Voicemail list (V2-VM-02): messages from services/voicemail-api plus actions. */
export function useVoicemailList(): UseVoicemailListResult {
  const api = useSoftphone();
  const state = useSoftphoneSnapshot((s) => s.voicemailList ?? EMPTY_VOICEMAIL_LIST);
  const cfg = api.config;
  const refresh = useCallback(() => api.refreshVoicemails?.() ?? unsupported(), [api]);
  const markRead = useCallback((id: string) => api.markVoicemailRead?.(id) ?? unsupported(), [api]);
  const remove = useCallback((id: string) => api.deleteVoicemail?.(id) ?? unsupported(), [api]);
  const getAudio = useCallback((id: string) => api.getVoicemailAudio?.(id) ?? unsupported(), [api]);
  const pending = state.pending;
  const isPending = useCallback((id: string) => pending.includes(id), [pending]);
  return {
    ...state,
    enabled: isVoicemailListEnabled(cfg) && isFeatureEnabled(cfg, 'voicemail') && typeof api.refreshVoicemails === 'function',
    refresh,
    markRead,
    remove,
    getAudio,
    isPending,
  };
}

export interface UseVoicemailPlayerResult {
  /** Message whose recording is loaded (or loading). */
  id: string | null;
  /** Object URL for an `<audio src>`; revoked when replaced, stopped or unmounted. */
  url: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Download a recording and expose it as `url`. */
  load: (id: string) => Promise<void>;
  /** Release the current recording. */
  stop: () => void;
}

/**
 * Loads voicemail recordings through the authenticated API into object URLs,
 * so tokens never end up in an `<audio src>`. One recording at a time.
 */
export function useVoicemailPlayer(): UseVoicemailPlayerResult {
  const { getAudio } = useVoicemailList();
  const [state, setState] = useState<Omit<UseVoicemailPlayerResult, 'load' | 'stop'>>({ id: null, url: null, status: 'idle' });
  const urlRef = useRef<string | null>(null);
  const seq = useRef(0);

  const release = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const stop = useCallback(() => {
    seq.current++;
    release();
    setState({ id: null, url: null, status: 'idle' });
  }, [release]);

  const load = useCallback(
    async (id: string) => {
      const mine = ++seq.current;
      release();
      setState({ id, url: null, status: 'loading' });
      try {
        const blob = await getAudio(id);
        if (mine !== seq.current) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setState({ id, url, status: 'ready' });
      } catch (error) {
        if (mine === seq.current) setState({ id, url: null, status: 'error' });
        throw error;
      }
    },
    [getAudio, release],
  );

  useEffect(() => release, [release]);

  return { ...state, load, stop };
}
