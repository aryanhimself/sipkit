import { useEffect, useState } from 'react';
import {
  CheckIcon,
  LoaderCircleIcon,
  PauseIcon,
  PhoneIcon,
  PlayIcon,
  RotateCwIcon,
  Trash2Icon,
  VoicemailIcon,
} from 'lucide-react';
import type { VoicemailMessage } from 'sipkit-core';
import {
  useRegistration,
  useSoftphone,
  useVoicemail,
  useVoicemailList,
  useVoicemailPlayer,
} from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n, type I18n } from '@/i18n/context';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useContactLookup } from '../contacts';
import { EmptyState } from '../empty-state';

export interface VoicemailPanelProps {
  className?: string;
  /** Dial a number (the call-back action). Default: `softphone.call()`. */
  onCall?: (number: string) => void;
}

function errorText(i18n: I18n, code: string | undefined): string {
  switch (code) {
    case 'unauthorized':
    case 'forbidden':
      return i18n.t('voicemailList.errorAuth');
    case 'network':
    case 'timeout':
      return i18n.t('voicemailList.errorNetwork');
    default:
      return i18n.t('voicemailList.errorGeneric');
  }
}

/**
 * Voicemail tab (V2-VM-02): messages from services/voicemail-api with play,
 * mark heard, call back and delete (with confirmation). Renders nothing unless
 * `voicemail.enabled` and `voicemail.api.baseUrl` are set.
 */
export function VoicemailPanel({ className, onCall }: VoicemailPanelProps) {
  const api = useSoftphone();
  const reg = useRegistration();
  const vm = useVoicemailList();
  const player = useVoicemailPlayer();
  const i18n = useI18n();
  const { t } = i18n;
  const lookup = useContactLookup();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const { enabled, status, refresh } = vm;

  // Opened before the first automatic load (or with autoRefresh off): load now.
  useEffect(() => {
    if (enabled && status === 'idle') refresh().catch(() => undefined);
  }, [enabled, status, refresh]);

  // The playing message was deleted (here or elsewhere): close the player.
  const { id: playingId, stop } = player;
  useEffect(() => {
    if (playingId && !vm.messages.some((m) => m.id === playingId)) stop();
  }, [playingId, vm.messages, stop]);

  if (!enabled) return null;

  const nameOf = (m: VoicemailMessage) =>
    m.callerName || (m.callerNumber ? lookup(m.callerNumber)?.name : undefined) || (m.callerNumber ? formatNumber(m.callerNumber) : t('voicemailList.unknownCaller'));
  const dial = (n: string) => (onCall ? onCall(n) : void api.call(n).catch(() => undefined));
  const run = (p: Promise<unknown>) => {
    setActionError(false);
    p.catch(() => setActionError(true));
  };

  const loadingFirst = vm.status === 'loading' && !vm.updatedAt;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} data-testid="voicemail-panel" data-status={vm.status}>
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('voicemailList.title')}</h2>
          <p className="truncate text-xs text-muted-foreground" data-testid="voicemail-counts" data-new={vm.counts.new} data-old={vm.counts.old}>
            {t('voicemailList.counts', { new: i18n.number(vm.counts.new), old: i18n.number(vm.counts.old) })}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('voicemailList.refresh')}
          data-testid="voicemail-refresh"
          disabled={vm.status === 'loading'}
          onClick={() => run(vm.refresh())}
        >
          <RotateCwIcon className={cn(vm.status === 'loading' && 'animate-spin')} aria-hidden />
        </Button>
      </div>

      {(vm.status === 'error' || actionError) && (
        <div role="alert" className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="voicemail-error">
          <span>{vm.status === 'error' ? errorText(i18n, vm.error) : t('voicemailList.actionFailed')}</span>
          {vm.status === 'error' && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => run(vm.refresh())}>
              {t('voicemailList.retry')}
            </Button>
          )}
        </div>
      )}

      {loadingFirst ? (
        <EmptyState icon={<LoaderCircleIcon className="animate-spin" aria-hidden />} title={t('voicemailList.loading')} />
      ) : vm.messages.length === 0 ? (
        vm.status !== 'error' && (
          <EmptyState icon={<VoicemailIcon aria-hidden />} title={t('voicemailList.emptyTitle')} description={t('voicemailList.emptyDescription')} />
        )
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="px-2 pb-2" aria-label={t('voicemailList.listLabel')}>
            {vm.messages.map((m) => {
              const name = nameOf(m);
              const isNew = m.folder === 'new';
              const busy = vm.isPending(m.id);
              const playing = player.id === m.id;
              const confirming = confirmId === m.id;
              return (
                <li
                  key={m.id}
                  className="rounded-lg px-2 py-2 hover:bg-muted/40"
                  data-testid="voicemail-item"
                  data-id={m.id}
                  data-folder={m.folder}
                  aria-busy={busy || undefined}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        'mt-0.5 grid size-9 shrink-0 place-items-center rounded-full [&_svg]:size-4',
                        isNew ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <VoicemailIcon aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn('truncate text-sm', isNew ? 'font-semibold' : 'font-medium')} data-testid="voicemail-caller">
                          {name}
                        </span>
                        {isNew && (
                          <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground">
                            {t('voicemailList.newBadge')}
                          </span>
                        )}
                        {m.urgent && (
                          <span className="shrink-0 rounded-full bg-destructive/12 px-1.5 text-[10px] leading-4 font-semibold text-destructive">
                            {t('voicemailList.urgent')}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground tabular-nums">
                        {m.callerName && m.callerNumber ? `${formatNumber(m.callerNumber)} · ` : ''}
                        {i18n.when(m.timestamp)} · {i18n.duration(m.duration * 1000)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-1 ps-12">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={playing ? t('voicemailList.stop') : t('voicemailList.play', { name })}
                      aria-pressed={playing}
                      data-testid="voicemail-play"
                      disabled={!m.hasAudio}
                      title={m.hasAudio ? undefined : t('voicemailList.noAudio')}
                      onClick={() => (playing ? player.stop() : run(player.load(m.id)))}
                    >
                      {playing && player.status === 'loading' ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
                    </Button>
                    {isNew && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('voicemailList.markRead', { name })}
                        data-testid="voicemail-mark-read"
                        disabled={busy}
                        onClick={() => run(vm.markRead(m.id))}
                      >
                        <CheckIcon aria-hidden />
                      </Button>
                    )}
                    {m.callerNumber && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-success hover:text-success"
                        aria-label={t('voicemailList.callBack', { name })}
                        data-testid="voicemail-call-back"
                        disabled={!reg.isRegistered}
                        onClick={() => dial(m.callerNumber!)}
                      >
                        <PhoneIcon aria-hidden />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ms-auto text-muted-foreground hover:text-destructive"
                      aria-label={t('voicemailList.delete', { name })}
                      aria-expanded={confirming}
                      data-testid="voicemail-delete"
                      disabled={busy}
                      onClick={() => setConfirmId(confirming ? null : m.id)}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  </div>

                  {confirming && (
                    <div
                      role="group"
                      aria-label={t('voicemailList.confirmDelete')}
                      className="mt-1 ms-12 flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs"
                      data-testid="voicemail-confirm"
                    >
                      <span>{t('voicemailList.confirmDelete')}</span>
                      <span className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="sm" className="h-7" onClick={() => setConfirmId(null)}>
                          {t('voicemailList.cancel')}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-7"
                          data-testid="voicemail-confirm-delete"
                          autoFocus
                          onClick={() => {
                            setConfirmId(null);
                            run(vm.remove(m.id));
                          }}
                        >
                          {t('voicemailList.confirm')}
                        </Button>
                      </span>
                    </div>
                  )}

                  {playing && (
                    <div className="mt-1 ms-12">
                      {player.status === 'ready' && player.url ? (
                        <audio
                          className="h-8 w-full"
                          controls
                          autoPlay
                          src={player.url}
                          aria-label={t('voicemailList.playerLabel', { name })}
                          data-testid="voicemail-audio"
                        />
                      ) : player.status === 'error' ? (
                        <p className="text-xs text-destructive">{t('voicemailList.audioError')}</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t('voicemailList.loadingAudio')}</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

/** New-message count for the Voicemail tab label (list counts once loaded, else MWI). */
export function VoicemailTabBadge({ className }: { className?: string }) {
  const vm = useVoicemailList();
  const mwi = useVoicemail();
  const i18n = useI18n();
  if (!vm.enabled) return null;
  const count = vm.updatedAt ? vm.counts.new : mwi.new;
  if (count <= 0) return null;
  return (
    <span
      data-testid="voicemail-tab-badge"
      data-count={count}
      className={cn(
        'inline-grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground',
        className,
      )}
    >
      <span aria-hidden>{count > 99 ? `${i18n.number(99)}+` : i18n.number(count)}</span>
      <span className="sr-only">{i18n.t('voicemail.new', { count })}</span>
    </span>
  );
}
