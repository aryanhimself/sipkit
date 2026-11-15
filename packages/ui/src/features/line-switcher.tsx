import type { Call } from 'sipkit-core';
import { useActiveCall, useCallTimer, useCalls, useSoftphone } from 'sipkit-react';
import { useI18n, useT } from '@/i18n/context';
import { callTitle } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useContactLookup } from './contacts';

/** Tabs for each line when more than one call exists. */
export function LineSwitcher({ className, alwaysShow = false }: { className?: string; alwaysShow?: boolean }) {
  const calls = useCalls();
  const active = useActiveCall();
  const api = useSoftphone();
  const t = useT();
  if (calls.length < (alwaysShow ? 1 : 2)) return null;
  return (
    <div
      role="tablist"
      aria-label={t('lines.label')}
      className={cn('flex gap-1.5 overflow-x-auto border-b bg-muted/40 px-3 py-2', className)}
    >
      {calls.map((call) => (
        <LineTab key={call.id} call={call} selected={active?.id === call.id} onSelect={() => api.setActiveCall(call.id)} />
      ))}
    </div>
  );
}

function LineTab({ call, selected, onSelect }: { call: Call; selected: boolean; onSelect: () => void }) {
  const timer = useCallTimer(call);
  const lookup = useContactLookup();
  const i18n = useI18n();
  const { t } = i18n;
  const status =
    call.direction === 'incoming' && (call.state === 'ringing' || call.state === 'setup')
      ? t('lines.ringing')
      : call.state === 'held'
        ? t('lines.hold')
        : call.state === 'connected'
          ? i18n.duration(timer.elapsedMs)
          : t('lines.calling');
  const dot =
    call.state === 'connected'
      ? 'bg-success'
      : call.state === 'held'
        ? 'bg-warning'
        : 'bg-primary animate-pulse';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-start text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring',
        selected ? 'border-primary/40 bg-background shadow-sm' : 'border-transparent hover:bg-background/60',
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', dot)} aria-hidden />
      <span className="font-semibold text-muted-foreground">{t('call.lineShort', { line: call.line })}</span>
      <span className="max-w-[7rem] truncate font-medium">{callTitle(call, lookup(call.remoteNumber)?.name)}</span>
      <span className="text-muted-foreground tabular-nums">{status}</span>
    </button>
  );
}
