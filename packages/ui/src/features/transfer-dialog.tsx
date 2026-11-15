import { useRef, useState, type KeyboardEvent } from 'react';
import { PhoneForwardedIcon, UsersRoundIcon } from 'lucide-react';
import type { Call } from 'sipkit-core';
import { useSoftphone } from 'sipkit-react';
import { useSoftphoneUI } from '@/context';
import { useT } from '@/i18n/context';
import { cn } from '@/lib/utils';
import { NumberDialog } from './number-dialog';

export type TransferMode = 'blind' | 'attended';

export interface TransferDialogProps {
  call: Call;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Transfer the call.
 * - Blind: REFER immediately.
 * - Attended: hold the call, dial the target; the call screen then offers "Complete transfer".
 */
export function TransferDialog({ call, open, onOpenChange }: TransferDialogProps) {
  const api = useSoftphone();
  const { setConsult } = useSoftphoneUI();
  const t = useT();
  const [mode, setMode] = useState<TransferMode>(api.config.defaultTransferType);
  const radios = useRef<Record<TransferMode, HTMLButtonElement | null>>({ blind: null, attended: null });

  // Radio group keyboard pattern: arrows move and select, one tab stop for the group.
  function onRadioKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next: TransferMode = mode === 'blind' ? 'attended' : 'blind';
    setMode(next);
    radios.current[next]?.focus();
  }

  async function submit(number: string) {
    if (mode === 'blind') {
      await api.transfer(number, call.id);
    } else {
      const consult = await api.startAttendedTransfer(number, call.id);
      setConsult({ originalId: call.id, consultId: consult.id });
    }
  }

  return (
    <NumberDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('transfer.title')}
      description={
        mode === 'blind'
          ? t('transfer.descriptionBlind')
          : t('transfer.descriptionAttended')
      }
      submitLabel={mode === 'blind' ? t('transfer.submitBlind') : t('transfer.submitAttended')}
      submitIcon={<PhoneForwardedIcon aria-hidden />}
      onSubmit={submit}
    >
      <div role="radiogroup" aria-label={t('transfer.type')} className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {(['blind', 'attended'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            tabIndex={mode === m ? 0 : -1}
            ref={(el) => {
              radios.current[m] = el;
            }}
            onKeyDown={onRadioKey}
            onClick={() => setMode(m)}
            className={cn(
              'flex h-8 items-center justify-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring [&_svg]:size-4',
              mode === m && 'bg-background text-foreground shadow-sm',
            )}
          >
            {m === 'blind' ? <PhoneForwardedIcon aria-hidden /> : <UsersRoundIcon aria-hidden />}
            {m === 'blind' ? t('transfer.blind') : t('transfer.attended')}
          </button>
        ))}
      </div>
    </NumberDialog>
  );
}
