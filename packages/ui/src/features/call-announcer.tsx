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
  const Icon = notice.mediaError ? MicOffIcon : PhoneOffIcon;
  return (
    <div
      role="alert"
      data-testid="call-failure"
      data-call-id={notice.callId}
      className={cn(
        'mx-3 mt-3 flex shrink-0 items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-sm',
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{t('callEnded.failedTitle', { name: notice.name })}</p>
        <p className="text-destructive" data-testid="call-failure-reason">
          {notice.message}
        </p>
        {onRetry && (
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-8"
            onClick={() => {
              onDismiss();
              onRetry(notice.number);
            }}
          >
            <PhoneIcon aria-hidden /> {t('callEnded.retry')}
          </Button>
        )}
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        className="-me-1.5 -mt-1 shrink-0 text-muted-foreground"
        aria-label={t('callEnded.dismiss')}
        onClick={onDismiss}
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}
