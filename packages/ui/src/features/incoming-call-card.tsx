import { PhoneIcon, PhoneOffIcon, VideoIcon } from 'lucide-react';
import type { Call } from 'sipkit-core';
import { useSoftphone } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { useSoftphoneUI } from '@/context';
import { useT } from '@/i18n/context';
import { callTitle, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CallAvatar } from './call-avatar';
import { useContactLookup } from './contacts';
import { useVideoAvailable } from './video';

export interface IncomingCallCardProps {
  call: Call;
  /** 'full' fills the main area (no other call); 'banner' is a compact card over an ongoing call. */
  variant?: 'full' | 'banner';
  className?: string;
}

/** Ringing incoming call with Answer / Decline (Enter / Esc). */
export function IncomingCallCard({ call, variant = 'full', className }: IncomingCallCardProps) {
  const api = useSoftphone();
  const ui = useSoftphoneUI();
  const lookup = useContactLookup();
  const t = useT();
  const contact = lookup(call.remoteNumber);
  const title = callTitle(call, contact?.name);
  const number = formatNumber(call.remoteNumber);
  // Video offer (V2-VID-01): offer "answer with video" next to "audio only".
  const video = useVideoAvailable() && Boolean(call.hasVideo);
  const answer = () => void api.answer(call.id, video ? { video: false } : undefined).catch(() => undefined);
  const answerVideo = () => void api.answer(call.id, { video: true }).catch(() => undefined);
  const reject = () => void api.reject(call.id).catch(() => undefined);
  const ctx = ui.api ? ui.renderContext() : null;

  if (variant === 'banner') {
    return (
      <div
        role="alertdialog"
        aria-label={t('incoming.ariaLabel', { name: title })}
        data-testid="incoming-call"
        data-video={video ? 'true' : undefined}
        className={cn(
          'mx-3 mt-3 flex items-center gap-3 rounded-xl border bg-card p-3 shadow-lg ring-1 ring-success/30 animate-in fade-in-0 slide-in-from-top-2',
          className,
        )}
      >
        <CallAvatar name={title} size="sm" ringing />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-success">
            {t('incoming.bannerLine', { line: call.line })}
            {video && <> · {t('video.badge')}</>}
          </div>
          <div className="truncate text-sm font-semibold">{title}</div>
          {title !== number && <div className="truncate text-xs text-muted-foreground">{number}</div>}
        </div>
        <Button size="icon" variant="call-end" className="rounded-full" aria-label={t('incoming.decline')} onClick={reject}>
          <PhoneOffIcon />
        </Button>
        <Button
          size="icon"
          variant="call-accept"
          className="rounded-full"
          aria-label={video ? t('video.answerAudioOnly') : t('incoming.answer')}
          onClick={answer}
        >
          <PhoneIcon />
        </Button>
        {video && (
          <Button size="icon" variant="call-accept" className="rounded-full" aria-label={t('video.answerWithVideo')} onClick={answerVideo}>
            <VideoIcon />
          </Button>
        )}
      </div>
    );
  }

  return (
    <section
      role="alertdialog"
      aria-label={t('incoming.ariaLabel', { name: title })}
      data-testid="incoming-call"
      data-video={video ? 'true' : undefined}
      className={cn(
        'flex flex-1 flex-col items-center justify-between bg-gradient-to-b from-success/12 via-success/4 to-transparent px-6 pt-10 pb-8 text-center animate-in fade-in-0',
        className,
      )}
    >
      <div className="flex flex-col items-center gap-3">
        <span className="text-xs font-semibold tracking-[0.2em] text-success uppercase">
          {video ? t('video.incomingTitle') : t('incoming.title')}
        </span>
        <CallAvatar name={title} ringing className="mt-2" />
        <div className="min-w-0 max-w-full">
          <h2 className="truncate text-2xl font-semibold tracking-tight">{title}</h2>
          {title !== number && <p className="text-sm text-muted-foreground">{number}</p>}
          {contact?.description && <p className="text-xs text-muted-foreground">{contact.description}</p>}
        </div>
        {ui.slots.callInfo && ctx && <div className="w-full">{ui.slots.callInfo(call, ctx)}</div>}
      </div>
      <div className={cn('flex w-full items-start justify-between', video ? 'max-w-[20rem]' : 'max-w-[16rem]')}>
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="call-end"
            className="size-16 rounded-full shadow-md [&_svg:not([class*='size-'])]:size-7"
            aria-label={t('incoming.decline')}
            onClick={reject}
          >
            <PhoneOffIcon />
          </Button>
          <span className="text-xs text-muted-foreground">{t('incoming.declineHint')}</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="call-accept"
            className={cn(
              "size-16 rounded-full shadow-md [&_svg:not([class*='size-'])]:size-7",
              !video && 'animate-ring-pulse [&_svg]:animate-wiggle',
            )}
            aria-label={video ? t('video.answerAudioOnly') : t('incoming.answer')}
            autoFocus={!video}
            onClick={answer}
          >
            <PhoneIcon />
          </Button>
          <span className="text-xs text-muted-foreground">{video ? t('video.answerAudioHint') : t('incoming.answerHint')}</span>
        </div>
        {video && (
          <div className="flex flex-col items-center gap-2">
            <Button
              variant="call-accept"
              className="size-16 rounded-full shadow-md animate-ring-pulse [&_svg]:animate-wiggle [&_svg:not([class*='size-'])]:size-7"
              aria-label={t('video.answerWithVideo')}
              autoFocus
              onClick={answerVideo}
            >
              <VideoIcon />
            </Button>
            <span className="text-xs text-muted-foreground">{t('video.answerVideoHint')}</span>
          </div>
        )}
      </div>
    </section>
  );
}
