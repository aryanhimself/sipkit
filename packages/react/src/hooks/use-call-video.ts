import { useCallback, useEffect, useState } from 'react';
import type { CallId } from 'sipkit-core';
import { shallowEqual } from '../equality';
import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

export interface UseCallVideoResult {
  /** Video is enabled in config and the softphone implementation supports it. */
  supported: boolean;
  /** The call carries (or, while ringing, offers) video. */
  hasVideo: boolean;
  cameraOn: boolean;
  remoteVideo: boolean;
  /** Our camera preview (null while the camera is off). */
  localStream: MediaStream | null;
  /** The remote party's video (null when there is none). */
  remoteStream: MediaStream | null;
  setVideo: (on: boolean) => Promise<void>;
  toggleCamera: () => Promise<void>;
}

const hasLiveVideo = (s: MediaStream | undefined): s is MediaStream =>
  Boolean(s?.getVideoTracks().some((t) => t.readyState === 'live'));

/**
 * Video state and MediaStreams of a call (default: the active call). The
 * streams are read from `getVideoStreams()` (never from the snapshot) and
 * refreshed on every `call:video` event (V2-VID-01).
 */
export function useCallVideo(callId?: CallId | null): UseCallVideoResult {
  const api = useSoftphone();
  const id = useSoftphoneSnapshot((s) => callId ?? s.activeCallId);
  const flags = useSoftphoneSnapshot((s) => {
    const call = id ? s.calls.find((c) => c.id === id) : undefined;
    return {
      hasVideo: Boolean(call?.hasVideo),
      cameraOn: Boolean(call?.cameraOn),
      remoteVideo: Boolean(call?.remoteVideo),
      state: call?.state,
    };
  }, shallowEqual);
  const supported = Boolean(api.config.video?.enabled && api.setVideo && api.getVideoStreams);
  // Bumped on `call:video` so the streams' changed tracks are re-read.
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!id) return;
    return api.on('call:video', (e) => {
      if (e.callId === id) setVersion((v) => v + 1);
    });
  }, [api, id]);

  // Cheap: stable stream objects per call, read on every render.
  const streams = id && supported ? (api.getVideoStreams?.(id) ?? {}) : {};

  const setVideo = useCallback(
    async (on: boolean) => {
      if (!api.setVideo) throw new Error('Video is not supported');
      await api.setVideo(on, id ?? undefined);
    },
    [api, id],
  );
  const toggleCamera = useCallback(() => setVideo(!flags.cameraOn), [setVideo, flags.cameraOn]);

  return {
    supported,
    hasVideo: flags.hasVideo,
    cameraOn: flags.cameraOn,
    remoteVideo: flags.remoteVideo,
    localStream: hasLiveVideo(streams.local) ? streams.local : null,
    remoteStream: hasLiveVideo(streams.remote) ? streams.remote : null,
    setVideo,
    toggleCamera,
  };
}
