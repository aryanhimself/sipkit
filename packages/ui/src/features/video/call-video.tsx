import { useEffect, useRef } from 'react';
import { VideoIcon, VideoOffIcon } from 'lucide-react';
import type { Call } from 'sipkit-core';
import { useCallVideo, useSoftphone } from 'sipkit-react';
import { useT } from '@/i18n/context';
import { isFeatureEnabled } from '@/lib/features';
import { callTitle } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Video is enabled in config and the softphone supports it (V2-VID-01). */
export function useVideoAvailable(): boolean {
  const api = useSoftphone();
  return Boolean(api.config.video?.enabled && isFeatureEnabled(api.config, 'video') && api.setVideo && api.getVideoStreams);
}

/** A muted, inline <video> bound to a MediaStream (audio always plays through the engine). */
function StreamVideo({
  stream,
  label,
  mirrored,
  className,
  testId,
}: {
  stream: MediaStream;
  label: string;
  mirrored?: boolean;
  className?: string;
  testId: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    const played = el.play() as Promise<void> | undefined;
    played?.catch(() => undefined); // autoplay blocked / superseded: the next render retries
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-label={label}
      data-testid={testId}
      className={cn('size-full object-cover', mirrored && '-scale-x-100', className)}
    />
  );
}

export interface CallVideoViewProps {
  call: Call;
  className?: string;
}

/**
 * Video area of the call screen: remote video large, our camera as a mirrored
 * picture-in-picture (bottom end corner, RTL-aware). Renders nothing for
 * audio-only calls and for conferences (audio-only by design).
 */
export function CallVideoView({ call, className }: CallVideoViewProps) {
  const video = useCallVideo(call.id);
  const available = useVideoAvailable();
  const t = useT();
  if (!available || !video.hasVideo) return null;
  if (call.inConference) {
    return (
      <p className="mx-3 mb-2 flex shrink-0 items-center justify-center gap-1.5 text-xs text-muted-foreground" data-testid="video-conference-note">
        <VideoOffIcon className="size-3.5" aria-hidden />
        {t('video.conferenceAudioOnly')}
      </p>
    );
  }
  const name = callTitle(call);
  const connected = call.state === 'connected' || call.state === 'held';
  const remote = video.remoteVideo ? video.remoteStream : null;
  return (
    <div
      role="region"
      aria-label={t('video.region')}
      data-testid="call-video"
      data-camera={video.cameraOn ? 'on' : 'off'}
      data-remote-video={remote ? 'on' : 'off'}
      className={cn(
        'relative mx-3 mb-2 aspect-video max-h-[55vh] shrink-0 overflow-hidden rounded-xl border bg-secondary',
        className,
      )}
    >
      {remote ? (
        <StreamVideo stream={remote} label={t('video.remoteLabel', { name })} testId="remote-video" className="object-contain" />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground" data-testid="remote-video-placeholder">
          <VideoOffIcon className="size-6" aria-hidden />
          <span className="text-xs font-medium">{connected ? t('video.remoteOff') : t('video.waiting')}</span>
        </div>
      )}
      {video.localStream && (
        <div className="absolute end-2 bottom-2 aspect-[4/3] w-1/4 min-w-16 max-w-40 overflow-hidden rounded-lg border-2 border-background shadow-md">
          <StreamVideo stream={video.localStream} label={t('video.localLabel')} mirrored testId="local-video" />
        </div>
      )}
    </div>
  );
}

/** In-call camera toggle for the call screen toolbar (render inside the ActionButton grid). */
export function useCameraToggle(call: Call) {
  const video = useCallVideo(call.id);
  const available = useVideoAvailable();
  const t = useT();
  const connected = call.state === 'connected' || call.state === 'held';
  return {
    visible: available,
    // A toggle button: "Camera", aria-pressed = camera on.
    label: t('video.camera'),
    pressed: video.cameraOn,
    disabled: !connected || call.inConference,
    icon: video.cameraOn ? <VideoIcon aria-hidden /> : <VideoOffIcon aria-hidden />,
    toggle: () => video.toggleCamera(),
  };
}
