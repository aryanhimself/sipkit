import type { PresenceInfo, PresenceState } from 'sipkit-core';
import { useI18n, type Translate } from '@/i18n/context';
import { cn } from '@/lib/utils';

/** Lamp styling per state. Ringing blinks unless the user prefers reduced motion. */
const LAMP: Record<PresenceState, string> = {
  idle: 'bg-success',
  ringing: 'bg-warning ring-2 ring-warning/40 motion-safe:animate-pulse',
  busy: 'bg-destructive',
  held: 'bg-destructive/40 ring-2 ring-inset ring-destructive',
  unavailable: 'bg-transparent ring-2 ring-inset ring-muted-foreground/60',
  unknown: 'bg-muted-foreground/35',
};

/** Translated state name ("Busy", "Ringing"...). */
export function presenceStateLabel(t: Translate, state: PresenceState): string {
  return t(`presence.state.${state}`);
}

/** Short status line: "Ringing · Alice" when the caller is known, else the state name. */
export function presenceDescription(t: Translate, info: PresenceInfo | undefined): string {
  if (!info) return presenceStateLabel(t, 'unknown');
  const from = info.remoteDisplayName ?? info.remoteNumber;
  if (info.state === 'ringing' && from) return t('presence.ringingFrom', { from });
  if (info.state === 'busy' && from) return t('presence.busyWith', { with: from });
  return presenceStateLabel(t, info.state);
}

export interface PresenceLampProps {
  state: PresenceState;
  className?: string;
  /** Add a visually hidden state label (default true). Turn off when the state is shown as text next to it. */
  label?: boolean;
}

/**
 * A busy lamp: green idle, red busy, blinking amber ringing, hollow red held,
 * hollow grey offline, grey unknown. The state is never conveyed by colour
 * alone: the lamp carries a hidden label (and the BLF panel shows text).
 */
export function PresenceLamp({ state, className, label = true }: PresenceLampProps) {
  const { t } = useI18n();
  return (
    <span className={cn('inline-flex shrink-0 items-center', className)} data-testid="presence-lamp" data-state={state}>
      <span aria-hidden className={cn('block size-2.5 rounded-full', LAMP[state])} />
      {label && <span className="sr-only">{presenceStateLabel(t, state)}</span>}
    </span>
  );
}
