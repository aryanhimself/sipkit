import { useEffect, useState } from 'react';
import { BellRingIcon } from 'lucide-react';
import { usePush } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/context';
import { cn } from '@/lib/utils';
import { pushErrorText } from './push-settings';

const DISMISS_KEY = 'sipkit:push-prompt-dismissed';

function readDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, '1');
  } catch {
    /* storage blocked */
  }
}

/**
 * Sends the translated notification texts to the push service worker whenever
 * the language changes. Rendered by `<Softphone>`; use it in custom layouts.
 */
export function usePushLabelsSync(): void {
  const { setLabels, enabled } = usePush();
  const i18n = useI18n();
  const { t } = i18n;
  useEffect(() => {
    if (!enabled) return;
    setLabels({
      title: t('push.notification.title'),
      body: t('push.notification.body', { caller: '{caller}' }),
      answer: t('push.notification.answer'),
      decline: t('push.notification.decline'),
    });
  }, [enabled, setLabels, t, i18n.locale]);
}

export interface PushPromptProps {
  className?: string;
}

/**
 * Call notification banner (V2-PUSH-01):
 * - while a notification click waits for its call: "Connecting the call…";
 * - otherwise, once per browser, a prompt to turn notifications on (the browser
 *   permission prompt only appears after the click, as browsers require).
 * Renders nothing when push is unavailable, already on, blocked or dismissed.
 */
export function PushPrompt({ className }: PushPromptProps) {
  const push = usePush();
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(readDismissed);
  usePushLabelsSync();
  if (!push.enabled) return null;
  if (push.pending) {
    return (
      <div
        role="status"
        data-testid="push-pending"
        data-push-call={push.pending.pushCallId}
        className={cn('flex items-center gap-2 border-b bg-accent px-4 py-2 text-xs text-accent-foreground', className)}
      >
        <BellRingIcon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{t('push.pending')}</span>
      </div>
    );
  }
  if (!push.available || push.subscribed || push.permission === 'denied' || dismissed) return null;
  const error = pushErrorText(t, push.error);
  return (
    <section
      aria-label={t('push.promptTitle')}
      data-testid="push-prompt"
      className={cn('flex items-start gap-3 border-b bg-muted/60 px-4 py-3', className)}
    >
      <BellRingIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="text-sm font-medium">{t('push.promptTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('push.promptBody')}</p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-1 flex flex-wrap gap-2">
          <Button size="sm" data-testid="push-prompt-enable" disabled={push.busy} onClick={() => void push.subscribe().catch(() => undefined)}>
            {t('push.promptEnable')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              writeDismissed();
              setDismissed(true);
            }}
          >
            {t('push.promptDismiss')}
          </Button>
        </div>
      </div>
    </section>
  );
}
