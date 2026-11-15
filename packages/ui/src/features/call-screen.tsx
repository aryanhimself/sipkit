import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  ArrowRightLeftIcon,
  CheckIcon,
  GridIcon,
  MergeIcon,
  MicIcon,
  MicOffIcon,
  PauseIcon,
  PhoneForwardedIcon,
  PhoneIcon,
  PhoneOffIcon,
  PlayIcon,
  RefreshCwIcon,
  UserPlusIcon,
  XIcon,
} from 'lucide-react';
import { getConferenceView, type Call } from 'sipkit-core';
import { isLiveCall, useCallTimer, useCalls, useSoftphone } from 'sipkit-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSoftphoneUI } from '@/context';
import { defaultI18n, useI18n, type Translate } from '@/i18n/context';
import { isFeatureEnabled } from '@/lib/features';
import { callTitle, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CallAvatar } from './call-avatar';
import { CallQualityIndicator } from './call-quality';
import { ConferencePanel } from './conference-panel';
import { useContactLookup } from './contacts';
import { Dialpad } from './dialpad';
import { NumberDialog } from './number-dialog';
import { TransferDialog } from './transfer-dialog';
import { CallVideoView, useCameraToggle } from './video';

/** Status line under the caller ("Ringing…", "On hold · 0:42"). `t` defaults to English. */
export function callStatusText(call: Call, timer: string, conferenceSize = 0, t: Translate = defaultI18n.t): string {
  switch (call.state) {
    case 'setup':
      return call.direction === 'outgoing' ? t('call.calling') : t('call.incoming');
    case 'ringing':
    case 'early':
      return call.direction === 'outgoing' ? t('call.ringing') : t('call.incoming');
    case 'held':
      return t('call.onHold', { timer });
    case 'connected':
      if (call.inConference && conferenceSize > 1) return t('call.conferenceStatus', { count: conferenceSize, timer });
      if (call.hold === 'remote') return t('call.heldByRemote', { timer });
      return timer;
    case 'disconnected':
      return t('call.ended');
  }
}

export interface CallScreenProps {
  /** The call to show. Default: the active call. */
  call: Call;
  className?: string;
}

/** In-call screen: caller, timer, mute/hold/keypad/transfer/add/merge, extension actions, hang up. */
export function CallScreen({ call, className }: CallScreenProps) {
  const api = useSoftphone();
  const ui = useSoftphoneUI();
  const calls = useCalls();
  const lookup = useContactLookup();
  const timer = useCallTimer(call);
  const i18n = useI18n();
  const { t } = i18n;
  const [keypad, setKeypad] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const keypadButtonRef = useRef<HTMLButtonElement>(null);
  const keypadWasOpen = useRef(false);
  const camera = useCameraToggle(call);

  // Keep keyboard focus inside the widget when the call screen replaces the dialpad
  // (so Esc hangs up / digits send DTMF right away).
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const root = el.getRootNode() as Document | ShadowRoot;
    const focused = root.activeElement;
    if (!focused || focused === el.ownerDocument.body) el.focus({ preventScroll: true });
  }, []);

  const cfg = api.config;
  const canTransfer = isFeatureEnabled(cfg, 'transfer');
  const canConference = isFeatureEnabled(cfg, 'conference');

  const contact = lookup(call.remoteNumber);
  // Local mix or server (ConfBridge) room: same view, controls from its capabilities.
  const conference = getConferenceView(calls);
  const conferenceSize = conference?.parties.length ?? 0;
  const inConferenceView = conference?.calls.some((c) => c.id === call.id) ?? false;
  const title = inConferenceView ? t('call.conferenceTitle') : callTitle(call, contact?.name);
  const subtitle =
    inConferenceView && conference
      ? conference.parties.map((p) => p.remoteDisplayName || formatNumber(p.remoteNumber)).join(', ')
      : title !== formatNumber(call.remoteNumber)
        ? formatNumber(call.remoteNumber)
        : contact?.description;
  const connected = call.state === 'connected' || call.state === 'held';
  const held = call.state === 'held';
  const liveCount = calls.filter(isLiveCall).length;
  const mergeable = calls.filter((c) => (c.state === 'connected' || c.state === 'held') && !c.inConference);
  const canMerge = canConference && liveCount > 1 && (mergeable.length > 1 || (mergeable.length === 1 && conferenceSize > 0));

  // Attended-transfer consult in progress for this call?
  const consult = ui.consult;
  const consultActive =
    consult && (consult.consultId === call.id || consult.originalId === call.id) ? consult : null;
  const consultOriginal = consultActive ? calls.find((c) => c.id === consultActive.originalId) : undefined;
  const consultTarget = consultActive ? calls.find((c) => c.id === consultActive.consultId) : undefined;

  useEffect(() => {
    // Clear a stale consult pair once either leg is gone.
    if (consult && (!calls.some((c) => c.id === consult.originalId) || !calls.some((c) => c.id === consult.consultId))) {
      ui.setConsult(null);
    }
  }, [calls, consult, ui]);

  useEffect(() => {
    if (!connected) setKeypad(false);
  }, [connected]);

  // Closing the in-call keypad returns focus to the Keypad button instead of dropping it.
  useEffect(() => {
    if (keypadWasOpen.current && !keypad) keypadButtonRef.current?.focus({ preventScroll: true });
    keypadWasOpen.current = keypad;
  }, [keypad]);

  const run = (fn: () => Promise<unknown> | void) => () => {
    void Promise.resolve()
      .then(fn)
      .catch(() => undefined);
  };

  const ctx = ui.api ? ui.renderContext() : null;
  const extActions = (ui.extensions.callActions ?? []).filter((a) => a.isVisible?.(call) ?? true);

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-label={t('call.ariaLabel', { name: title })}
      data-testid="call-screen"
      data-call-state={call.state}
      data-resuming={call.resuming ? 'true' : undefined}
      className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto outline-none', className)}
    >
      {call.resuming && (
        // Reload-safe calls (docs/resume.md): rejoining the PBX anchor room after a page reload.
        <div
          role="status"
          data-testid="call-resuming"
          className="flex shrink-0 items-center gap-2 border-b bg-warning/15 px-4 py-2 text-xs text-foreground"
        >
          <RefreshCwIcon className="size-4 shrink-0 animate-spin text-warning-foreground dark:text-warning" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{t('call.resuming')}</span>{' '}
            <span className="text-muted-foreground">{t('call.resumingHint')}</span>
          </span>
        </div>
      )}
      {/* Caller header */}
      <div className="relative flex shrink-0 flex-col items-center gap-2 overflow-hidden bg-gradient-to-b from-primary/12 via-primary/4 to-transparent px-4 pt-6 pb-4 text-center">
        <Badge variant="secondary" className="absolute top-3 start-3 bg-background/70">
          {t('call.line', { line: call.line })}
        </Badge>
        {call.muted && (
          <Badge variant="destructive" className="absolute top-3 end-3">
            <MicOffIcon aria-hidden /> {t('call.muted')}
          </Badge>
        )}
        {!(camera.visible && call.hasVideo && !call.inConference) && (
          <CallAvatar name={title} conference={inConferenceView} ringing={!connected} />
        )}
        <div className="mt-1 min-w-0 max-w-full">
          <h2 className="truncate text-xl font-semibold tracking-tight" data-testid="call-title">
            {title}
          </h2>
          {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        <p
          className={cn(
            'text-sm font-medium tabular-nums',
            held ? 'text-warning-foreground dark:text-warning' : connected ? 'text-success' : 'text-muted-foreground',
          )}
          data-testid="call-status"
        >
          {callStatusText(call, i18n.duration(timer.elapsedMs), conferenceSize, t)}
        </p>
        <CallQualityIndicator call={call} />
        {ui.slots.callInfo && ctx && <div className="w-full">{ui.slots.callInfo(call, ctx)}</div>}
      </div>

      <CallVideoView call={call} />

      {consultActive && consultOriginal && consultTarget && (
        <div
          role="region"
          aria-label={t('transfer.attendedRegion')}
          className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-primary/25 bg-primary/6 px-3 py-2 text-xs"
        >
          <ArrowRightLeftIcon className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {i18n.rich('transfer.attendedSummary', {
              from: <b>{callTitle(consultOriginal)}</b>,
              to: <b>{callTitle(consultTarget)}</b>,
            })}
          </span>
          <Button
            size="sm"
            className="h-7"
            disabled={consultTarget.state !== 'connected' && consultTarget.state !== 'held'}
            onClick={run(async () => {
              await api.completeAttendedTransfer(consultActive.originalId, consultActive.consultId);
              ui.setConsult(null);
            })}
          >
            <CheckIcon aria-hidden /> {t('transfer.complete')}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-7"
            aria-label={t('transfer.cancel')}
            onClick={run(async () => {
              ui.setConsult(null);
              await api.hangup(consultActive.consultId);
            })}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      )}

      {canConference && inConferenceView && <ConferencePanel />}

      {/* Actions or keypad */}
      <div className="flex flex-1 flex-col justify-end px-5 pb-5">
        {keypad ? (
          <Dialpad mode="dtmf" className="mb-3" autoFocus />
        ) : (
          <div role="toolbar" aria-label={t('controls.toolbar')} className="mx-auto mb-5 grid w-full max-w-[18rem] grid-cols-3 gap-x-3 gap-y-4">
            <ActionButton
              label={call.muted ? t('controls.unmute') : t('controls.mute')}
              pressed={call.muted}
              disabled={!connected}
              icon={call.muted ? <MicOffIcon aria-hidden /> : <MicIcon aria-hidden />}
              onClick={() => api.mute(!call.muted, call.id)}
            />
            <ActionButton
              label={held ? t('controls.resume') : t('controls.hold')}
              pressed={held}
              disabled={!connected || inConferenceView}
              icon={held ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
              onClick={run(() => api.hold(!held, call.id))}
            />
            <ActionButton
              label={t('controls.keypad')}
              disabled={!connected}
              icon={<GridIcon aria-hidden />}
              onClick={() => setKeypad(true)}
              buttonRef={keypadButtonRef}
            />
            {camera.visible && (
              <ActionButton
                label={camera.label}
                pressed={camera.pressed}
                disabled={camera.disabled}
                icon={camera.icon}
                onClick={run(camera.toggle)}
              />
            )}
            {canTransfer && (
              <ActionButton
                label={t('controls.transfer')}
                disabled={!connected}
                icon={<PhoneForwardedIcon aria-hidden />}
                onClick={() => setTransferOpen(true)}
              />
            )}
            {canConference && (
              <ActionButton
                label={t('controls.addCall')}
                disabled={!connected || liveCount >= cfg.maxLines}
                icon={<UserPlusIcon aria-hidden />}
                onClick={() => setAddOpen(true)}
              />
            )}
            {canConference && liveCount > 1 && (
              <ActionButton label={t('controls.merge')} disabled={!canMerge} icon={<MergeIcon aria-hidden />} onClick={run(() => api.conference())} />
            )}
            {ctx &&
              extActions.map((a) => (
                <ActionButton
                  key={a.id}
                  label={a.label}
                  icon={a.icon}
                  pressed={a.isActive?.(call)}
                  disabled={a.isDisabled?.(call)}
                  onClick={run(() => a.onSelect(call, ctx))}
                />
              ))}
          </div>
        )}

        <div className="relative flex items-center justify-center">
          {keypad && (
            <Button
              variant="ghost"
              size="sm"
              className="absolute start-0 text-muted-foreground"
              onClick={() => setKeypad(false)}
            >
              {t('controls.hideKeypad')}
            </Button>
          )}
          <Button
            variant="call-end"
            className="size-14 rounded-full shadow-md [&_svg:not([class*='size-'])]:size-6"
            aria-label={t('controls.hangUp')}
            aria-keyshortcuts="Escape"
            onClick={run(() => api.hangup(call.id))}
          >
            <PhoneOffIcon aria-hidden />
          </Button>
        </div>
      </div>

      {canTransfer && <TransferDialog call={call} open={transferOpen} onOpenChange={setTransferOpen} />}
      {canConference && (
        <NumberDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          title={t('addCall.title')}
          description={t('addCall.description')}
          submitLabel={t('addCall.submit')}
          submitIcon={<PhoneIcon aria-hidden />}
          onSubmit={async (n) => {
            await api.call(n);
          }}
        />
      )}
    </section>
  );
}

export function ActionButton({
  label,
  icon,
  pressed,
  disabled,
  onClick,
  buttonRef,
}: {
  label: string;
  icon: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      onClick={onClick}
      className="group flex flex-col items-center gap-1.5 outline-none disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        aria-hidden
        className={cn(
          'grid size-14 place-items-center rounded-full bg-secondary text-secondary-foreground transition-colors [&_svg]:size-5',
          'group-hover:bg-accent group-focus-visible:ring-[3px] group-focus-visible:ring-ring group-disabled:group-hover:bg-secondary',
          pressed && 'bg-foreground text-background group-hover:bg-foreground/90',
        )}
      >
        {icon}
      </span>
      <span aria-hidden className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
    </button>
  );
}
