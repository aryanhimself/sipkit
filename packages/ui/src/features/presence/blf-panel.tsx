import type { PresenceInfo } from 'sipkit-core';
import { LayoutGridIcon, PhoneIncomingIcon } from 'lucide-react';
import { usePresence, useRegistration, useSoftphone } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/i18n/context';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useContactLookup } from '../contacts';
import { EmptyState } from '../empty-state';
import { PresenceLamp, presenceDescription, presenceStateLabel } from './presence-lamp';

export interface BlfPanelProps {
  className?: string;
  /** Dial handler (defaults to `api.call`). */
  onCall?: (number: string) => void;
}

/**
 * Compact busy lamp field (V2-BLF-01): one tile per watched extension with a
 * lamp and its state as text. Click a tile to call; a ringing extension gets a
 * "Pick up" button (directed pickup).
 */
export function BlfPanel({ className, onCall }: BlfPanelProps) {
  const api = useSoftphone();
  const reg = useRegistration();
  const { list, pickup } = usePresence();
  const lookup = useContactLookup();
  const { t } = useI18n();

  if (list.length === 0) {
    return (
      <EmptyState
        className={className}
        icon={<LayoutGridIcon />}
        title={t('blf.emptyTitle')}
        description={t('blf.emptyDescription')}
      />
    );
  }

  const dial = (n: string) => (onCall ? onCall(n) : void api.call(n).catch(() => undefined));

  return (
    <ScrollArea className={cn('min-h-0 flex-1', className)}>
      <ul className="grid grid-cols-2 gap-2 p-3" aria-label={t('blf.listLabel')} data-testid="blf-panel">
        {list.map((info) => (
          <BlfTile
            key={info.target}
            info={info}
            name={lookup(info.target)?.name}
            disabled={!reg.isRegistered}
            onCall={() => dial(info.target)}
            onPickup={() => void pickup(info.target).catch(() => undefined)}
          />
        ))}
      </ul>
    </ScrollArea>
  );
}

function BlfTile({
  info,
  name,
  disabled,
  onCall,
  onPickup,
}: {
  info: PresenceInfo;
  name?: string;
  disabled: boolean;
  onCall: () => void;
  onPickup: () => void;
}) {
  const { t } = useI18n();
  const label = name ?? formatNumber(info.target);
  const status = presenceDescription(t, info);
  const ringing = info.state === 'ringing';
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-2',
        ringing && 'border-warning',
      )}
      data-testid="blf-tile"
      data-target={info.target}
      data-state={info.state}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onCall}
        aria-label={t('blf.tileLabel', { name: label, state: status })}
        className="flex min-w-0 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        <PresenceLamp state={info.state} label={false} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{label}</span>
          <span className="block truncate text-xs text-muted-foreground" title={presenceStateLabel(t, info.state)}>
            {status}
          </span>
        </span>
      </button>
      {ringing && (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={disabled}
          aria-label={t('blf.pickupLabel', { name: label })}
          onClick={onPickup}
          data-testid="blf-pickup"
        >
          <PhoneIncomingIcon />
          {t('blf.pickup')}
        </Button>
      )}
    </li>
  );
}
