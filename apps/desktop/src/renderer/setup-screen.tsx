/** First-run (and "edit account") setup: server, extension, credentials. */
import { useState, type FormEvent, type ReactNode } from 'react';
import { validateAccount, type AccountField, type AccountSettings, type EngineKind } from '../shared/settings';
import type { DesktopMessageKey } from '../shared/i18n';
import { useDesktopT } from './i18n';

export interface SetupResult {
  account: AccountSettings;
  /** New password, or null to keep the stored one. */
  password: string | null;
}

export interface SetupScreenProps {
  initial: AccountSettings | null;
  hasPassword: boolean;
  keychainAvailable: boolean;
  engine: EngineKind;
  onSubmit: (result: SetupResult) => Promise<void>;
  onCancel?: () => void;
}

export const inputClass =
  'mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-[invalid=true]:border-destructive';
export const buttonClass =
  'inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50';

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-3">
      <label htmlFor={id} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function SetupScreen({ initial, hasPassword, keychainAvailable, engine, onSubmit, onCancel }: SetupScreenProps) {
  const t = useDesktopT();
  const [server, setServer] = useState(initial?.server ?? '');
  const [domain, setDomain] = useState(initial?.domain ?? '');
  const [extension, setExtension] = useState(initial?.extension ?? '');
  const [authUsername, setAuthUsername] = useState(initial?.authUsername ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Partial<Record<AccountField, string>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateAccount(
      { server, domain, extension, password },
      { requirePassword: !hasPassword, engine },
    );
    const messages: Partial<Record<AccountField, string>> = {};
    for (const [field, code] of Object.entries(found)) {
      messages[field as AccountField] = t(`setup.error.${code}` as DesktopMessageKey);
    }
    setErrors(messages);
    if (Object.keys(messages).length) return;
    setBusy(true);
    setSaveError(null);
    try {
      await onSubmit({
        account: { server: server.trim(), domain: domain.trim(), extension: extension.trim(), authUsername: authUsername.trim(), displayName: displayName.trim() },
        password: password ? password : null,
      });
    } catch (err) {
      setSaveError(t('setup.error.saveFailed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  const invalid = (f: AccountField) => (errors[f] ? { 'aria-invalid': true, 'aria-describedby': `setup-${f}-error` } : {});

  return (
    <div className="flex min-h-full items-start justify-center overflow-auto p-4">
      <form
        onSubmit={submit}
        noValidate
        data-testid="desktop-setup"
        className="w-full max-w-sm rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm"
      >
        <h1 className="text-base font-semibold">{t('setup.title')}</h1>
        <p className="mb-4 text-xs text-muted-foreground">{t('setup.subtitle')}</p>
        {saveError && (
          <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {saveError}
          </p>
        )}
        <Field id="setup-server" label={t('setup.server')} hint={t('setup.serverHint')} error={errors.server}>
          <input
            id="setup-server"
            className={inputClass}
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="wss://"
            autoComplete="url"
            dir="ltr"
            {...invalid('server')}
          />
        </Field>
        <Field id="setup-domain" label={t('setup.domain')} hint={t('setup.domainHint')} error={errors.domain}>
          <input id="setup-domain" className={inputClass} value={domain} onChange={(e) => setDomain(e.target.value)} dir="ltr" {...invalid('domain')} />
        </Field>
        <Field id="setup-extension" label={t('setup.extension')} error={errors.extension}>
          <input
            id="setup-extension"
            className={inputClass}
            value={extension}
            onChange={(e) => setExtension(e.target.value)}
            autoComplete="username"
            dir="ltr"
            {...invalid('extension')}
          />
        </Field>
        <Field id="setup-auth" label={t('setup.authUsername')} hint={t('setup.authUsernameHint')}>
          <input id="setup-auth" className={inputClass} value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} dir="ltr" />
        </Field>
        <Field id="setup-display" label={t('setup.displayName')}>
          <input id="setup-display" className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field
          id="setup-password"
          label={t('setup.password')}
          hint={hasPassword ? t('setup.passwordSaved') : !keychainAvailable ? t('setup.keychainUnavailable') : undefined}
          error={errors.password}
        >
          <input
            id="setup-password"
            type="password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            dir="ltr"
            {...invalid('password')}
          />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          {onCancel && (
            <button type="button" onClick={onCancel} className={`${buttonClass} border border-border bg-background text-foreground hover:bg-accent`}>
              {t('setup.cancel')}
            </button>
          )}
          <button type="submit" disabled={busy} data-testid="desktop-setup-save" className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`}>
            {t('setup.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
