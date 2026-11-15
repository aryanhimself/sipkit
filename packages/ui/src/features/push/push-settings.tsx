import { useId } from 'react';
import { usePush } from 'sipkit-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useI18n, type Translate } from '@/i18n/context';
import type { MessageKey } from '@/i18n/en';

const ERROR_KEYS: Record<string, MessageKey> = {
  'permission-denied': 'push.error.permission-denied',
  unsupported: 'push.error.unsupported',
  'service-unreachable': 'push.error.service-unreachable',
  'service-rejected': 'push.error.service-rejected',
  'no-vapid-key': 'push.error.no-vapid-key',
  'subscribe-failed': 'push.error.subscribe-failed',
  'not-configured': 'push.error.not-configured',
};

/** Translated text for a `PushState.error` code. */
export function pushErrorText(t: Translate, code: string | undefined): string | undefined {
  if (!code) return undefined;
  return t(ERROR_KEYS[code] ?? 'push.error.subscribe-failed');
}

/**
 * Settings row for call notifications (V2-PUSH-01): a switch that asks for
 * notification permission and subscribes this browser. Renders nothing unless
 * `push.enabled`, supported by the browser and not in `disabledFeatures`.
 */
export function PushSettings() {
  const push = usePush();
  const { t } = useI18n();
  const id = useId();
  if (!push.available) return null;
  const blocked = push.permission === 'denied';
  const error = blocked ? t('push.blocked') : pushErrorText(t, push.error);
  return (
    <div className="grid gap-1.5" data-testid="push-settings" data-subscribed={push.subscribed ? 'true' : 'false'} data-permission={push.permission}>
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-0.5">
          <Label htmlFor={id}>{t('push.toggle')}</Label>
          <p className="text-xs text-muted-foreground">{t('push.description')}</p>
        </div>
        <Switch
          id={id}
          data-testid="push-toggle"
          checked={push.subscribed}
          disabled={push.busy || (blocked && !push.subscribed)}
          aria-busy={push.busy || undefined}
          onCheckedChange={() => void push.toggle()}
        />
      </div>
      {push.busy && <p className="text-xs text-muted-foreground">{t('push.statusBusy')}</p>}
      {!push.busy && push.subscribed && !error && <p className="text-xs text-muted-foreground">{t('push.statusOn')}</p>}
      {!push.busy && error && (
        <p role="alert" data-testid="push-error" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
