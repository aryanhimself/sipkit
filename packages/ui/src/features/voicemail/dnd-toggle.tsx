import { BellIcon, BellOffIcon } from 'lucide-react';
import { useDnd, useSoftphone } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n/context';
import { isFeatureEnabled } from '@/lib/features';
import { cn } from '@/lib/utils';

/**
 * Do Not Disturb toggle (V2-FWD-01). While on, incoming calls are rejected
 * (486 by default) and the button is highlighted. Hidden with
 * `disabledFeatures: ['dnd']`. Server-side DND (config `dnd.mode`): busy while
 * the feature code runs; a failure reverts the toggle and shows a toast.
 */
export function DndToggle({ className }: { className?: string }) {
  const api = useSoftphone();
  const { dnd, pending, server, toggle } = useDnd();
  const t = useT();
  if (!isFeatureEnabled(api.config, 'dnd')) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('dnd.label')}
          aria-pressed={dnd}
          data-testid="dnd-toggle"
          data-state={dnd ? 'on' : 'off'}
          data-pending={pending ? 'true' : undefined}
          aria-busy={pending || undefined}
          disabled={pending}
          className={cn(
            dnd &&
              'bg-destructive/12 text-destructive hover:bg-destructive/20 hover:text-destructive',
            className,
          )}
          onClick={() => void toggle()}
        >
          {dnd ? <BellOffIcon /> : <BellIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {pending ? t('dnd.pending') : dnd ? (server ? t('dnd.onServer') : t('dnd.on')) : t('dnd.off')}
      </TooltipContent>
    </Tooltip>
  );
}
