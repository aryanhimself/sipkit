import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/i18n/context';
import { sanitizeDialInput, sanitizePastedNumber } from '@/lib/format';

export interface NumberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel: string;
  submitIcon?: ReactNode;
  onSubmit: (number: string) => void | Promise<void>;
  /** Content above the input (e.g. a blind/attended toggle). */
  children?: ReactNode;
}

/** Small dialog asking for a number (used by Add call). */
export function NumberDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  submitIcon,
  onSubmit,
  children,
}: NumberDialogProps) {
  const id = useId();
  const i18n = useI18n();
  const { t } = i18n;
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      setValue('');
      onOpenChange(false);
    } catch (err) {
      setError(i18n.error(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-n`}>{t('numberDialog.label')}</Label>
            <Input
              id={`${id}-n`}
              autoFocus
              inputMode="tel"
              autoComplete="off"
              value={value}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(e) => setValue(sanitizeDialInput(e.target.value))}
              onPaste={(e) => {
                e.preventDefault();
                setValue(sanitizePastedNumber(e.clipboardData.getData('text')));
              }}
              placeholder={t('numberDialog.placeholder')}
            />
            {error && (
              <p role="alert" id={`${id}-error`} className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!value.trim() || busy} aria-busy={busy || undefined}>
              {submitIcon}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
