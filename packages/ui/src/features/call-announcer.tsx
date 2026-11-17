import { useEffect, useRef, useState } from 'react';
import { PhoneIcon, PhoneOffIcon, MicOffIcon, XIcon } from 'lucide-react';
import type { Call } from 'sipkit-core';
import { useSoftphoneEvent } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { useI18n, type I18n } from '@/i18n/context';
import { useAnnounce } from '@/lib/announcer';
import { callTitle } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useContactLookup } from './contacts';

/** A call that did not go through, with the reason in words. */
export interface CallFailureNotice {
  callId: string;
  name: string;
  number: string;
  /** "Number not reachable (404)", "Microphone blocked — …". */
  message: string;
  mediaError: boolean;
}

/**
 * The failure text for an ended call, or null when it ended normally.
 * Calls you placed: busy / declined / no answer / failed / blocked microphone.
 * Incoming calls: only a blocked microphone or a failure (declining is not an error).
 */
export function callFailureText(call: Call, i18n: I18n): string | null {
  const reason = call.disconnectReason;
  if (!reason) return null;
  if (call.direction === 'incoming') {
    if (reason !== 'media-error' && reason !== 'failed') return null;
    return i18n.callFailure(reason);
  }
  return i18n.callFailure(reason, call.disconnectCode);
}

/**
 * Screen reader announcements for call and registration state (one place, so
 * nothing is read twice): calling, ringing, connected, on hold, resumed and
 * ended go to the polite live region. A call that fails is reported through
 * `onFailure` instead and shown as an alert (see {@link CallFailureAlert}).
 * Incoming calls announce themselves (IncomingCallCard).
 */
export function CallAnnouncer({ onFailure }: { onFailure: (notice: CallFailureNotice | null) => void }) {
  const announce = useAnnounce();
  const lookup = useContactLookup();
  const i18n = useI18n();
  const { t } = i18n;
  const nameOf = (call: Call) => callTitle(call, lookup(call.remoteNumber)?.name);

  useSoftphoneEvent('call:created', ({ call }) => {
    onFailure(null);
    if (call.direction === 'outgoing') announce(t('announce.calling', { name: nameOf(call) }));
  });

  useSoftphoneEvent('call:updated', ({ call, previous }) => {
    if (call.state === previous.state) return;
    const name = nameOf(call);
    if (call.state === 'ringing' && call.direction === 'outgoing') announce(t('announce.ringing', { name }));
    else if (call.state === 'held') announce(t('announce.held', { name }));
    else if (call.state === 'connected')
      announce(previous.state === 'held' ? t('announce.resumed', { name }) : t('announce.connected', { name }));
  });

  useSoftphoneEvent('call:ended', ({ call }) => {
    const message = callFailureText(call, i18n);
    if (message) {
      onFailure({
        callId: call.id,
        name: nameOf(call),
        number: call.remoteNumber,
        message,
        mediaError: call.disconnectReason === 'media-error',
      });
      return;
    }
    // Missed / Do Not Disturb calls get a toast of their own.
    const missed = call.direction === 'incoming' && !call.connectedAt && call.disconnectReason !== 'rejected';
    if (!missed && call.disconnectReason !== 'dnd') announce(t('announce.ended', { name: nameOf(call) }));
  });

  useSoftphoneEvent('registration:state', (reg) => {
    // Failures are announced by the sign-in form's alert (and the toast); skip the steps in between.
    if (reg.state === 'registered' || reg.state === 'unregistered')
      announce(t('registration.ariaLabel', { status: t(`registration.${reg.state}`) }));
  });

  return null;
}

/**
 * "Call to 1002 didn't go through — Number not reachable (404)" with Call again /
 * Dismiss. role="alert", so it is announced right away.
 */
/** How long the failure notice stays before hiding itself. */
export const CALL_FAILURE_AUTO_HIDE_MS = 8000;

/**
 * Compact one-line warning for a call that didn't go through: number, reason, a small
 * "Call again" and dismiss. It never pushes the dialer or call screen out of view and hides
 * itself after {@link CALL_FAILURE_AUTO_HIDE_MS} (paused while hovered or focused).
 */
export function CallFailureAlert({
  notice,
  onDismiss,
  onRetry,
  className,
}: {
  notice: CallFailureNotice;
  onDismiss: () => void;
  onRetry?: (number: string) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [paused, setPaused] = useState(false);
  // Parents usually pass an inline callback; keep the timer from restarting on every render.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismissRef.current(), CALL_FAILURE_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [notice.callId, paused]);
  const Icon = notice.mediaError ? MicOffIcon : PhoneOffIcon;
  return (
    <div
      role="alert"
      data-testid="call-failure"
      data-call-id={notice.callId}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        'mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-md border border-warning/50 bg-warning/12 py-1 ps-2.5 pe-1 text-xs text-warning-foreground dark:text-warning',
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <p className="line-clamp-2 min-w-0 flex-1 leading-snug" title={`${t('callEnded.failedTitle', { name: notice.name })} — ${notice.message}`}>
        <span className="sr-only">{t('callEnded.failedTitle', { name: notice.name })}. </span>
        <span aria-hidden className="font-medium">{notice.name}</span>
        <span aria-hidden> · </span>
        <span data-testid="call-failure-reason">{notice.message}</span>
      </p>
      {onRetry && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs text-current hover:bg-warning/20"
          onClick={() => {
            onDismiss();
            onRetry(notice.number);
          }}
        >
          <PhoneIcon aria-hidden /> {t('callEnded.retry')}
        </Button>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-7 shrink-0 text-current hover:bg-warning/20"
        aria-label={t('callEnded.dismiss')}
        onClick={onDismiss}
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}
