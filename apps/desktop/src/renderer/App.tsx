import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SoftphoneApi } from 'sipkit-core';
import { Softphone, type SoftphoneSlots } from 'sipkit-ui';
import { resolveDesktopLocale } from '../shared/i18n';
import type { DesktopBootstrap, DesktopBridge, UpdateState } from '../shared/ipc';
import type { DesktopSettings } from '../shared/settings';
import { createPhone, toSoftphoneConfig } from './create-softphone';
import { attachDesktopIntegration } from './desktop-integration';
import { DesktopSettingsPanel } from './desktop-settings';
import { DesktopLocaleProvider, useDesktopT } from './i18n';
import { SetupScreen, type SetupResult } from './setup-screen';

declare global {
  interface Window {
    sipkitDesktop?: DesktopBridge;
    /** Mock engine only: the softphone, for e2e tests (like apps/playground). */
    __softphone?: SoftphoneApi;
  }
}

function useSystemTheme(): 'light' | 'dark' {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  return dark ? 'dark' : 'light';
}

type View = 'loading' | 'setup' | 'phone';

export function App() {
  const bridge = window.sipkitDesktop;
  const [boot, setBoot] = useState<DesktopBootstrap | null>(null);
  const [view, setView] = useState<View>('loading');
  const [password, setPassword] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [update, setUpdate] = useState<UpdateState>({ state: 'disabled' });
  const theme = useSystemTheme();

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      const b = await bridge.bootstrap();
      const pw = b.settings.account ? await bridge.getPassword() : null;
      if (cancelled) return;
      setBoot(b);
      setPassword(pw);
      setView(b.settings.account && pw ? 'phone' : 'setup');
    })();
    const off = bridge.onUpdate(setUpdate);
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge]);

  const locale = boot ? resolveDesktopLocale(boot.settings.locale, boot.osLocale) : 'en';

  // One softphone per account / password / engine. Keyed on the account's
  // content so saving unrelated settings (hotkeys, language) never drops a call,
  // and independent of the view so "Edit account" → Cancel keeps it running.
  const account = boot?.settings.account ?? null;
  const accountKey = account ? JSON.stringify(account) : '';
  const engine = boot?.engine ?? 'sipjs';
  const phone = useMemo(() => {
    if (!accountKey || !password) return null;
    const acc = JSON.parse(accountKey) as NonNullable<typeof account>;
    // Locale changes are applied through the widget prop, not by recreating the phone.
    return createPhone({ engine, config: toSoftphoneConfig(acc, password, locale), bridge: bridge?.engine });
  }, [accountKey, password, engine, bridge]);

  useEffect(() => {
    if (!phone || !bridge) return;
    if (engine === 'mock') window.__softphone = phone;
    const detach = attachDesktopIntegration(phone, bridge, {
      onUiCommand: () => setShowSettings(true),
      onCommandResult: (command, outcome) => console.info('[desktop] command', command.type, outcome),
    });
    return () => {
      detach();
      void phone.stop();
      if (window.__softphone === phone) delete window.__softphone;
    };
  }, [phone, bridge, engine]);

  // Settings can be opened from the tray before an account exists.
  useEffect(() => {
    if (!bridge || phone) return;
    return bridge.onCommand((c) => {
      if (c.type === 'openSettings' && boot?.settings.account) setShowSettings(true);
    });
  }, [bridge, phone, boot]);

  const saveAccount = useCallback(
    async ({ account: next, password: pw }: SetupResult) => {
      if (!bridge || !boot) return;
      if (pw) await bridge.savePassword(pw);
      const settings = await bridge.saveSettings({ account: next });
      const effective = pw ?? (await bridge.getPassword());
      setBoot({ ...boot, settings, hasPassword: boot.hasPassword || Boolean(pw) });
      setPassword(effective);
      setView(effective ? 'phone' : 'setup');
    },
    [bridge, boot],
  );

  const saveSettings = useCallback(
    async (patch: Partial<DesktopSettings>) => {
      if (!bridge || !boot) return [];
      const settings = await bridge.saveSettings(patch);
      const hotkeys = await bridge.applyHotkeys(settings.hotkeys);
      setBoot({ ...boot, settings, hotkeyProblems: hotkeys.problems });
      return hotkeys.problems;
    },
    [bridge, boot],
  );

  const signOut = useCallback(async () => {
    if (!bridge || !boot) return;
    await bridge.signOut();
    setShowSettings(false);
    setPassword(null);
    setBoot({ ...boot, settings: { ...boot.settings, account: null }, hasPassword: false });
    setView('setup');
  }, [bridge, boot]);

  if (!bridge) return null;

  return (
    <DesktopLocaleProvider locale={locale}>
      <div className="sipkit-phone relative flex h-full flex-col bg-background text-foreground" data-theme={theme}>
        {view === 'setup' && boot && (
          <SetupScreen
            initial={boot.settings.account}
            hasPassword={boot.hasPassword && Boolean(boot.settings.account)}
            keychainAvailable={boot.keychainAvailable}
            engine={boot.engine}
            onSubmit={saveAccount}
            onCancel={boot.settings.account && password ? () => setView('phone') : undefined}
          />
        )}
        {view === 'phone' && phone && (
          <PhoneView phone={phone} locale={locale} update={update} onOpenSettings={() => setShowSettings(true)} />
        )}
        {showSettings && boot && (
          <DesktopSettingsPanel
            settings={boot.settings}
            hotkeyProblems={boot.hotkeyProblems}
            onSave={saveSettings}
            onEditAccount={() => {
              setShowSettings(false);
              setView('setup');
            }}
            onSignOut={() => void signOut()}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>
    </DesktopLocaleProvider>
  );
}

function GearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function PhoneView({
  phone,
  locale,
  update,
  onOpenSettings,
}: {
  phone: SoftphoneApi;
  locale: 'en' | 'ne';
  update: UpdateState;
  onOpenSettings: () => void;
}) {
  const t = useDesktopT();
  const slots = useMemo<SoftphoneSlots>(
    () => ({
      headerActions: () => (
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t('settings.open')}
          title={t('settings.open')}
          data-testid="desktop-settings-open"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <GearIcon />
        </button>
      ),
      idleBanner: ({ snapshot }) =>
        snapshot.registration.state === 'failed' || snapshot.registration.state === 'unregistered' ? (
          <div role="alert" className="mx-3 mt-2 flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span>{t('banner.registrationFailed')}</span>
            <button type="button" onClick={onOpenSettings} className="font-medium underline">
              {t('banner.openSettings')}
            </button>
          </div>
        ) : null,
    }),
    // t changes identity every render; the locale is the real dependency.
    [onOpenSettings, locale],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Softphone
        softphone={phone}
        layout="compact"
        locale={locale}
        slots={slots}
        showLogin={false}
        className="h-full min-h-0 max-h-none w-full max-w-none min-w-0 flex-1 rounded-none border-0 shadow-none"
      />
      {update.state === 'downloaded' && (
        <p role="status" className="border-t border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t('update.downloaded', { version: update.version })}
        </p>
      )}
    </div>
  );
}
