import { VoicemailIcon } from 'lucide-react';
import { useRegistration, useVoicemail } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type Translate } from '@/i18n/context';
import { cn } from '@/lib/utils';

export interface VoicemailBadgeProps {
  className?: string;
  /** Called after the voicemail call was placed (or failed). */
  onCall?: (error?: unknown) => void;
}

function describe(t: Translate, count: number, waiting: boolean, old: number): string {
  if (count > 0) return t('voicemail.new', { count });
  if (waiting) return t('voicemail.waiting');
  return old > 0 ? t('voicemail.noneSaved', { old }) : t('voicemail.none');
}

/**
 * Voicemail button with a message-waiting count (V2-VM-01). Click dials the
 * voicemail number. Renders nothing unless `voicemail.enabled` and registered.
 */
export function VoicemailBadge({ className, onCall }: VoicemailBadgeProps) {
  const vm = useVoicemail();
  const reg = useRegistration();
  const i18n = useI18n();
  const { t } = i18n;
  if (!vm.enabled || !reg.isRegistered) return null;
  const count = vm.new;
  const label = describe(t, count, vm.waiting, vm.old);
  const canCall = Boolean(vm.number);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={canCall ? t('voicemail.ariaCall', { label }) : t('voicemail.ariaNoNumber', { label })}
          data-testid="voicemail-badge"
          data-count={count}
          data-waiting={vm.waiting ? 'true' : 'false'}
          disabled={!canCall}
          className={cn('relative', vm.waiting && 'text-primary', className)}
          onClick={() => {
            vm.call().then(
              () => onCall?.(),
              (error: unknown) => onCall?.(error),
            );
          }}
        >
          <VoicemailIcon aria-hidden />
          {(count > 0 || vm.waiting) && (
            <span
              aria-hidden
              data-testid="voicemail-count"
              className="absolute -top-0.5 -end-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground"
            >
              {count > 99 ? `${i18n.number(99)}+` : count > 0 ? i18n.number(count) : ''}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {canCall ? t('voicemail.tooltipCall', { label, number: vm.number ?? '' }) : label}
      </TooltipContent>
    </Tooltip>
  );
}
