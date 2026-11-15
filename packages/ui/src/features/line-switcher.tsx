import type { KeyboardEvent } from 'react';
import type { Call } from 'sipkit-core';
import { useActiveCall, useCallTimer, useCalls, useSoftphone } from 'sipkit-react';
import { useI18n, useT } from '@/i18n/context';
import { callTitle } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useContactLookup } from './contacts';

/**
 * Tabs for each line when more than one call exists. Tab pattern: one tab stop,
 * arrow keys / Home / End move between lines and switch the active call.
 */
export function LineSwitcher({ className, alwaysShow = false }: { className?: string; alwaysShow?: boolean }) {
  const calls = useCalls();
  const active = useActiveCall();
  const api = useSoftphone();
  const t = useT();
  if (calls.length < (alwaysShow ? 1 : 2)) return null;
  const selectedIndex = Math.max(0, calls.findIndex((c) => c.id === active?.id));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next: number;
    if (e.key in keys) {
      // In right-to-left layouts the visual order of ArrowLeft / ArrowRight flips.
      const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
      const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      const step = horizontal && rtl ? -keys[e.key]! : keys[e.key]!;
      next = (selectedIndex + step + calls.length) % calls.length;
    } else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = calls.length - 1;
    else return;
    e.preventDefault();
    const call = calls[next];
    if (!call) return;
    api.setActiveCall(call.id);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t('lines.label')}
      onKeyDown={onKeyDown}
      className={cn('flex gap-1.5 overflow-x-auto border-b bg-muted/40 px-3 py-2', className)}
    >
      {calls.map((call) => (
        <LineTab
          key={call.id}
          call={call}
          selected={active?.id === call.id}
          focusable={calls[selectedIndex]?.id === call.id}
          onSelect={() => api.setActiveCall(call.id)}
        />
      ))}
    </div>
  );
}

function LineTab({
  call,
  selected,
  focusable,
  onSelect,
}: {
  call: Call;
  selected: boolean;
  focusable: boolean;
  onSelect: () => void;
}) {
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
        : 'bg-primary motion-safe:animate-pulse';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      onClick={onSelect}
      className={cn(
        'flex min-h-8 min-w-0 shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-start text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring',
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
