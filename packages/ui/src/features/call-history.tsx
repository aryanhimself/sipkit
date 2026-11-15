import { useRef, useSyncExternalStore } from 'react';
import { shallowEqual } from 'sipkit-react';
import {
  HistoryIcon,
  PhoneIcon,
  PhoneIncomingIcon,
  PhoneMissedIcon,
  PhoneOutgoingIcon,
  Trash2Icon,
} from 'lucide-react';
import type { Cdr } from 'sipkit-core';
import { usePlugin, useRegistration, useSoftphone } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useSoftphoneUI } from '@/context';
import type { CallHistoryPluginApi } from '@/extensions';
import { useI18n, type I18n } from '@/i18n/context';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useContactLookup } from './contacts';
import { EmptyState } from './empty-state';

const EMPTY: Cdr[] = [];
const noopSubscribe = () => () => undefined;

/** Call records from the `call-history` plugin, or the built-in recorder. */
export function useCallHistory(): { items: Cdr[]; clear?: () => void } {
  const plugin = usePlugin<CallHistoryPluginApi>('call-history');
  const { history } = useSoftphoneUI();
  // Plugins may return a fresh array per list() call; keep a stable reference.
  const cache = useRef<Cdr[]>(EMPTY);
  const pluginSnapshot = () => {
    const next = plugin?.list() ?? EMPTY;
    if (!shallowEqual(cache.current, next)) cache.current = next;
    return cache.current;
  };
  const pluginSubscribe = plugin?.onChange ?? plugin?.subscribe;
  const source = plugin && pluginSubscribe
    ? {
        subscribe: (cb: () => void) => pluginSubscribe.call(plugin, () => cb()),
        getSnapshot: pluginSnapshot,
        clear: plugin.clear?.bind(plugin),
      }
    : history
      ? { subscribe: history.subscribe, getSnapshot: history.getSnapshot, clear: history.clear }
      : null;
  const items = useSyncExternalStore(
    source?.subscribe ?? noopSubscribe,
    source?.getSnapshot ?? (() => EMPTY),
    source?.getSnapshot ?? (() => EMPTY),
  );
  return { items, clear: source?.clear };
}

function isMissed(c: Cdr) {
  return c.direction === 'incoming' && !c.connectedAt && c.reason !== 'rejected';
}

export interface CallHistoryProps {
  className?: string;
  onCall?: (number: string) => void;
}

/** Recent calls. Click a row to call back. */
export function CallHistory({ className, onCall }: CallHistoryProps) {
  const api = useSoftphone();
  const reg = useRegistration();
  const { items, clear } = useCallHistory();
  const lookup = useContactLookup();
  const i18n = useI18n();
  const { t } = i18n;

  const dial = (n: string) => (onCall ? onCall(n) : void api.call(n).catch(() => undefined));

  if (items.length === 0) {
    return (
      <EmptyState
        className={className}
        icon={<HistoryIcon />}
        title={t('history.emptyTitle')}
        description={t('history.emptyDescription')}
      />
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('history.recent')}</h3>
        {clear && (
          <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={clear}>
            <Trash2Icon /> {t('history.clear')}
          </Button>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="px-2 pb-2" aria-label={t('history.listLabel')}>
          {items.map((c) => {
            const number = c.direction === 'outgoing' ? c.called : c.caller;
            const missed = isMissed(c);
            const name = c.remoteDisplayName || lookup(number)?.name;
            const Icon = missed ? PhoneMissedIcon : c.direction === 'incoming' ? PhoneIncomingIcon : PhoneOutgoingIcon;
            return (
              <li key={c.callId}>
                <button
                  type="button"
                  disabled={!reg.isRegistered}
                  onClick={() => dial(number)}
                  aria-label={t('history.callBack', { name: name ?? number })}
                  className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-start outline-none hover:bg-muted/70 focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-default disabled:opacity-100"
                >
                  <span
                    className={cn(
                      'grid size-9 shrink-0 place-items-center rounded-full [&_svg]:size-4',
                      missed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    <Icon aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-sm font-medium', missed && 'text-destructive')}>
                      {name ?? formatNumber(number)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {name ? `${formatNumber(number)} · ` : ''}
                      {missed ? t('history.missed') : c.durationMs > 0 ? i18n.duration(c.durationMs) : reasonLabel(c, i18n)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums group-hover:hidden">
                    {i18n.when(c.endedAt)}
                  </span>
                  <PhoneIcon className="hidden size-4 shrink-0 text-success group-hover:block" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}

function reasonLabel(c: Cdr, i18n: I18n): string {
  switch (c.reason) {
    case 'busy':
    case 'dnd':
    case 'rejected':
    case 'no-answer':
    case 'cancelled':
    case 'failed':
    case 'media-error':
      return i18n.endReason(c.reason);
    default:
      return i18n.t('history.notConnected');
  }
}
