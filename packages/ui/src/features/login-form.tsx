import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDownIcon, Loader2Icon, LogInIcon, ShieldAlertIcon } from 'lucide-react';
import { useRegistration, useSoftphone } from 'sipkit-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/i18n/context';
import { cn } from '@/lib/utils';

export interface LoginFormProps {
  className?: string;
  /** Show the server fields (WebSocket URL, domain) open by default. */
  showServerFields?: boolean;
  footer?: ReactNode;
  onSignedIn?: () => void;
}

/** Credentials form: applies them with `updateConfig` and registers. */
export function LoginForm({ className, showServerFields, footer, onSignedIn }: LoginFormProps) {
  const api = useSoftphone();
  const reg = useRegistration();
  const cfg = api.config;
  const id = useId();
  const i18n = useI18n();
  const { t } = i18n;
  const [username, setUsername] = useState(cfg.username);
  const [password, setPassword] = useState(cfg.password);
  const [domain, setDomain] = useState(cfg.domain);
  const [wsUrl, setWsUrl] = useState(cfg.websocketUrls[0] ?? '');
  const [advanced, setAdvanced] = useState(showServerFields ?? !cfg.websocketUrls.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failure =
    error ??
    (reg.state === 'failed' ? i18n.registrationFailure(reg.reason, reg.code) : null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim()) {
      setError(t('login.usernameRequired'));
      return;
    }
    setBusy(true);
    try {
      const patch: Parameters<typeof api.updateConfig>[0] = {
        username: username.trim(),
        password,
        domain: domain.trim(),
      };
      if (wsUrl.trim()) patch.websocketUrls = [wsUrl.trim()];
      await api.updateConfig(patch);
      if (api.getSnapshot().registration.state !== 'registered') await api.register();
      if (api.getSnapshot().registration.state === 'registered') onSignedIn?.();
    } catch (err) {
      setError(i18n.error(err));
    } finally {
      setBusy(false);
    }
  }

  const pending = busy || reg.isPending;

  return (
    <form onSubmit={onSubmit} className={cn('flex flex-col gap-4 p-5', className)} aria-label={t('login.formLabel')}>
      <div className="space-y-1 pt-2 text-center">
        <h2 className="text-lg font-semibold tracking-tight">{t('login.title', { brand: cfg.brandName })}</h2>
        <p className="text-sm text-muted-foreground">{t('login.subtitle')}</p>
      </div>

      {failure && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive"
        >
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>{failure}</span>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-user`}>{t('login.username')}</Label>
        <Input
          id={`${id}-user`}
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('login.usernamePlaceholder')}
          autoFocus
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-pass`}>{t('login.password')}</Label>
        <Input
          id={`${id}-pass`}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <button
        type="button"
        className="-my-1 flex items-center gap-1 self-start rounded text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring"
        aria-expanded={advanced}
        aria-controls={`${id}-server`}
        onClick={() => setAdvanced((v) => !v)}
      >
        <ChevronDownIcon className={cn('size-3.5 transition-transform', advanced && 'rotate-180')} />
        {t('login.serverSettings')}
      </button>
      {advanced && (
        <div id={`${id}-server`} className="grid gap-3 rounded-lg border bg-muted/40 p-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-ws`}>{t('login.websocketUrl')}</Label>
            <Input
              id={`${id}-ws`}
              name="wsUrl"
              inputMode="url"
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
              placeholder="wss://pbx.example.com:8089/ws"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-domain`}>{t('login.domain')}</Label>
            <Input
              id={`${id}-domain`}
              name="domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="pbx.example.com"
            />
          </div>
        </div>
      )}

      <Button type="submit" size="lg" disabled={pending} className="mt-1 w-full">
        {pending ? <Loader2Icon className="animate-spin" /> : <LogInIcon />}
        {pending ? t('login.submitting') : t('login.submit')}
      </Button>
      {footer}
    </form>
  );
}
