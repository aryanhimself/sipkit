/** Desktop-only settings: global hotkeys, tray / notification behaviour, links, language. */
import { useState, type FormEvent } from 'react';
import { HOTKEY_ACTIONS, planHotkeys, type HotkeyAction, type HotkeySettings } from '../shared/hotkeys';
import type { DesktopMessageKey } from '../shared/i18n';
import type { HotkeyRegistrationResult } from '../shared/ipc';
import type { DesktopSettings } from '../shared/settings';
import { useDesktopT } from './i18n';
import { buttonClass, Field, inputClass } from './setup-screen';

export interface DesktopSettingsPanelProps {
  settings: DesktopSettings;
  hotkeyProblems: HotkeyRegistrationResult['problems'];
  onSave: (patch: Partial<DesktopSettings>) => Promise<HotkeyRegistrationResult['problems']>;
  onEditAccount: () => void;
  onSignOut: () => void;
  onClose: () => void;
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 py-1 text-sm text-foreground">
      <input id={id} type="checkbox" className="size-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function DesktopSettingsPanel({ settings, hotkeyProblems, onSave, onEditAccount, onSignOut, onClose }: DesktopSettingsPanelProps) {
  const t = useDesktopT();
  const [hotkeys, setHotkeys] = useState<HotkeySettings>(settings.hotkeys);
  const [closeToTray, setCloseToTray] = useState(settings.closeToTray);
  const [notifyIncoming, setNotifyIncoming] = useState(settings.notifications.incoming);
  const [notifyMissed, setNotifyMissed] = useState(settings.notifications.missed);
  const [handleTelLinks, setHandleTelLinks] = useState(settings.handleTelLinks);
  const [locale, setLocale] = useState(settings.locale);
  const [problems, setProblems] = useState(hotkeyProblems);
  const [saved, setSaved] = useState(false);

  const plan = planHotkeys(hotkeys);
  const localError = (action: HotkeyAction): string | undefined => {
    const problem = plan.problems.find((p) => p.action === action) ?? problems.find((p) => p.action === action);
    return problem ? t(`hotkey.error.${problem.error}` as DesktopMessageKey) : undefined;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (plan.problems.length) return;
    const next = await onSave({
      hotkeys,
      closeToTray,
      notifications: { incoming: notifyIncoming, missed: notifyMissed },
      handleTelLinks,
      locale,
    });
    setProblems(next);
    setSaved(true);
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="desktop-settings-title" className="absolute inset-0 z-50 flex flex-col bg-background text-foreground" data-testid="desktop-settings">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h1 id="desktop-settings-title" className="text-base font-semibold">
            {t('settings.title')}
          </h1>
          <button type="button" onClick={onClose} className={`${buttonClass} h-8 px-3 hover:bg-accent`}>
            {t('settings.close')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <section className="mb-4">
            <h2 className="mb-2 text-sm font-semibold">{t('settings.account')}</h2>
            <p className="mb-2 text-xs text-muted-foreground" dir="ltr">
              {settings.account ? `${settings.account.extension} · ${settings.account.server}` : ''}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={onEditAccount} className={`${buttonClass} h-8 border border-border hover:bg-accent`}>
                {t('settings.editAccount')}
              </button>
              <button type="button" onClick={onSignOut} className={`${buttonClass} h-8 border border-border text-destructive hover:bg-destructive/10`}>
                {t('settings.signOut')}
              </button>
            </div>
          </section>
          <section className="mb-4">
            <h2 className="text-sm font-semibold">{t('settings.hotkeys')}</h2>
            <p className="mb-2 text-xs text-muted-foreground">{t('settings.hotkeysHint')}</p>
            {HOTKEY_ACTIONS.map((action) => (
              <Field key={action} id={`hotkey-${action}`} label={t(`hotkey.${action}` as DesktopMessageKey)} error={localError(action)}>
                <input
                  id={`hotkey-${action}`}
                  data-testid={`hotkey-${action}`}
                  className={inputClass}
                  value={hotkeys[action]}
                  placeholder={t('settings.hotkeyUnbound')}
                  onChange={(e) => {
                    setHotkeys({ ...hotkeys, [action]: e.target.value });
                    setProblems(problems.filter((p) => p.action !== action));
                  }}
                  dir="ltr"
                />
              </Field>
            ))}
          </section>
          <section className="mb-4">
            <h2 className="mb-1 text-sm font-semibold">{t('settings.behaviour')}</h2>
            <Toggle id="opt-tray" label={t('settings.closeToTray')} checked={closeToTray} onChange={setCloseToTray} />
            <Toggle id="opt-incoming" label={t('settings.notifyIncoming')} checked={notifyIncoming} onChange={setNotifyIncoming} />
            <Toggle id="opt-missed" label={t('settings.notifyMissed')} checked={notifyMissed} onChange={setNotifyMissed} />
            <Toggle id="opt-links" label={t('settings.handleTelLinks')} checked={handleTelLinks} onChange={setHandleTelLinks} />
          </section>
          <section className="mb-4">
            <Field id="opt-locale" label={t('settings.language')}>
              <select
                id="opt-locale"
                className={inputClass}
                value={locale}
                onChange={(e) => setLocale(e.target.value as DesktopSettings['locale'])}
              >
                <option value="auto">{t('settings.languageAuto')}</option>
                <option value="en">English</option>
                <option value="ne">नेपाली</option>
              </select>
            </Field>
          </section>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-3">
          {saved && (
            <span role="status" className="text-xs text-muted-foreground">
              {t('settings.saved')}
            </span>
          )}
          <button type="submit" className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`} data-testid="desktop-settings-save">
            {t('settings.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
