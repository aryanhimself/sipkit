import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { HistoryIcon, LayoutGridIcon, MessagesSquareIcon, PhoneIcon, SettingsIcon, UsersIcon, VoicemailIcon } from 'lucide-react';
import { isVoicemailListEnabled } from 'sipkit-core';
import { Direction } from 'radix-ui';
import type { Call, SoftphoneApi } from 'sipkit-core';
import {
  SoftphoneProvider,
  isIncomingRinging,
  isLiveCall,
  useSoftphone,
  useSoftphoneEvent,
  useSoftphoneSnapshot,
} from 'sipkit-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  SoftphoneUIContext,
  type ConsultPair,
  type SoftphoneLayout,
  type SoftphoneTheme,
  type SoftphoneUIState,
} from '@/context';
import type {
  Contact,
  PanelExtension,
  SoftphoneExtensions,
  SoftphoneRenderContext,
  SoftphoneSlots,
} from '@/extensions';
import { createHistoryStore, type HistoryStore } from '@/history-store';
import { applySavedDialPrefs } from '@/lib/dial-prefs';
import { applySavedAudioPrefs } from '@/lib/audio-prefs';
import { MicrophoneAccess } from '@/features/audio-settings';
import { createI18n, I18nContext } from '@/i18n/context';
import type { Messages } from '@/i18n/en';
import { localesVersion, subscribeLocales } from '@/i18n/locales';
import { AnnouncerProvider } from '@/lib/announcer';
import { playDtmfTone } from '@/lib/dtmf-tones';
import { isFeatureEnabled } from '@/lib/features';
import { PortalContext, type PortalEnvironment } from '@/lib/portal';
import { cn } from '@/lib/utils';
import { themeTokensToCssVars, type ThemeTokenOverrides } from '@/theme/tokens';
import { CallAnnouncer, CallFailureAlert, type CallFailureNotice } from '@/features/call-announcer';
import { CallHistory } from '@/features/call-history';
import { ChatPanel, ChatUnreadBadge } from '@/features/chat';
import { CallScreen } from '@/features/call-screen';
import { ContactsList } from '@/features/contacts';
import { BlfPanel } from '@/features/presence';
import { Dialpad } from '@/features/dialpad';
import { IncomingCallCard } from '@/features/incoming-call-card';
import { LineSwitcher } from '@/features/line-switcher';
import { LoginForm } from '@/features/login-form';
import { Settings } from '@/features/settings';
import { StatusBar } from '@/features/status-bar';
import { SoftphoneToaster } from '@/features/toaster';
import { VoicemailPanel, VoicemailTabBadge } from '@/features/voicemail/voicemail-panel';
import { PushPrompt } from '@/features/push';

export interface SoftphoneProps {
  /** Softphone instance. Omit when rendering inside a <SoftphoneProvider>. */
  softphone?: SoftphoneApi;
  /** 'compact' (320–420px widget, default) or 'full' (fills its container, multi-column). */
  layout?: SoftphoneLayout;
  /**
   * 'light', 'dark' or 'system' (follows `prefers-color-scheme` live). The user
   * can change it from the menu / settings; a new prop value wins. Default 'system'.
   */
  theme?: SoftphoneTheme;
  /**
   * UI language: a BCP 47 tag ('en', 'ne', 'ne-NP'), a list in preference
   * order, or 'auto' (browser languages). Falls back ne-NP → ne → en.
   * Default: `config.language`, else 'en'.
   */
  locale?: string | readonly string[];
  /** Message overrides on top of the resolved locale (e.g. rename a tab). */
  messages?: Partial<Messages>;
  /** Brand color (any CSS color). Shorthand for `themeTokens={{ primary }}`. */
  brandColor?: string;
  /**
   * Runtime theme overrides (see docs/theming.md), e.g.
   * `{ primary: '#0a7', radius: '0.5rem', dark: { primary: '#3dd6a0' } }`.
   * Sets the `--sipkit-*` CSS variables on the widget root.
   */
  themeTokens?: ThemeTokenOverrides;
  /** Host extensions: extra tabs, call actions, panels. */
  extensions?: SoftphoneExtensions;
  /** Small injection points in built-in screens. */
  slots?: SoftphoneSlots;
  /** Contacts shown in the Contacts tab (merged with the `contacts` plugin). */
  contacts?: Contact[];
  /** Initially selected tab id. Default 'phone' (or the first side tab in full layout). */
  defaultTab?: string;
  onTabChange?: (tab: string) => void;
  /**
   * Keyboard shortcuts (Enter = call/answer, Esc = hang up/reject, digits = dial/DTMF).
   * true (default): while focus is inside the widget. 'global': anywhere on the page.
   */
  hotkeys?: boolean | 'global';
  /** Render the toast area for `notification` events. Default true. */
  toaster?: boolean;
  /** Show the login form when not registered. Default true. */
  showLogin?: boolean;
  /** Persist the built-in call history in localStorage. Default true. */
  persistHistory?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The complete softphone widget.
 *
 * ```tsx
 * <Softphone softphone={phone} layout="compact" extensions={{ tabs: [crmTab] }} />
 * ```
 */
export function Softphone({ softphone, ...props }: SoftphoneProps) {
  if (softphone) {
    return (
      <SoftphoneProvider softphone={softphone}>
        <SoftphoneView {...props} />
      </SoftphoneProvider>
    );
  }
  return <SoftphoneView {...props} />;
}

const EMPTY_CONTACTS: Contact[] = [];
const EMPTY_EXT: SoftphoneExtensions = {};
const EMPTY_SLOTS: SoftphoneSlots = {};

interface TabDef {
  id: string;
  label: string;
  icon: ReactNode;
  order: number;
  render: () => ReactNode;
  /** Shown after the label (e.g. an unread count). */
  badge?: ReactNode;
}

function useResolvedTheme(theme: SoftphoneTheme): 'light' | 'dark' {
  const query = '(prefers-color-scheme: dark)';
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [systemDark, setSystemDark] = useState(get);
  useEffect(() => {
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const on = () => setSystemDark(mql.matches);
    on();
    mql.addEventListener?.('change', on);
    return () => mql.removeEventListener?.('change', on);
  }, [theme]);
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

function SoftphoneView({
  layout = 'compact',
  theme: themeProp = 'system',
  locale: localeProp,
  messages,
  brandColor,
  themeTokens,
  extensions = EMPTY_EXT,
  slots = EMPTY_SLOTS,
  contacts = EMPTY_CONTACTS,
  defaultTab,
  onTabChange,
  hotkeys = true,
  toaster = true,
  showLogin = true,
  persistHistory = true,
  className,
  style,
}: Omit<SoftphoneProps, 'softphone'>) {
  const api = useSoftphone();
  const snapshot = useSoftphoneSnapshot();
  const cfg = api.config;

  // ---- theme ------------------------------------------------------------
  const [theme, setTheme] = useState<SoftphoneTheme>(themeProp);
  useEffect(() => setTheme(themeProp), [themeProp]);
  const resolvedTheme = useResolvedTheme(theme);

  // ---- locale -------------------------------------------------------------
  const requestedLocale =
    (typeof localeProp === 'string' ? localeProp : localeProp?.join(',')) || cfg.language || 'en';
  const [locale, setLocale] = useState<string>(requestedLocale);
  useEffect(() => setLocale(requestedLocale), [requestedLocale]);
  const localesRev = useSyncExternalStore(subscribeLocales, localesVersion, localesVersion);
  const i18n = useMemo(() => createI18n(locale.split(','), messages), [locale, messages, localesRev]);
  const { t } = i18n;

  // ---- portal / shadow DOM ------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<PortalEnvironment>({ container: null, inShadowRoot: false });
  const portalRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const inShadowRoot = typeof ShadowRoot !== 'undefined' && el.getRootNode() instanceof ShadowRoot;
    setPortal((p) => (p.container === el && p.inShadowRoot === inShadowRoot ? p : { container: el, inShadowRoot }));
  }, []);

  // ---- history ------------------------------------------------------------
  const [history, setHistory] = useState<HistoryStore | null>(null);
  const historyKey = persistHistory ? `sipkit:history:${cfg.username || 'anonymous'}` : null;
  useEffect(() => {
    const store = createHistoryStore(api, historyKey);
    setHistory(store);
    return () => store.dispose();
  }, [api, historyKey]);

  // ---- saved dialing preferences (Settings → Dialing) -----------------------
  useEffect(() => {
    applySavedDialPrefs(api)
      .then(() => applySavedAudioPrefs(api))
      .catch(() => undefined);
  }, [api, cfg.username]);

  // ---- UI state -------------------------------------------------------------
  const [dialValue, setDialValue] = useState('');
  const [consult, setConsult] = useState<ConsultPair | null>(null);
  const [chatPeer, setChatPeer] = useState<string | null>(null);
  /** Last call that did not go through (busy, 404, blocked microphone…), until dismissed or the next call. */
  const [failure, setFailure] = useState<CallFailureNotice | null>(null);

  const calls = snapshot.calls.filter(isLiveCall);
  const activeCall = snapshot.calls.find((c) => c.id === snapshot.activeCallId) ?? null;
  const ringing = calls.filter(isIncomingRinging);
  const established = calls.filter((c) => !isIncomingRinging(c));
  const displayCall: Call | null =
    activeCall && !isIncomingRinging(activeCall) && isLiveCall(activeCall) ? activeCall : (established[0] ?? null);

  // ---- tabs -----------------------------------------------------------------
  const full = layout === 'full';
  const voicemailList = isVoicemailListEnabled(cfg) && typeof api.refreshVoicemails === 'function';
  const tabs = useMemo<TabDef[]>(() => {
    const list: TabDef[] = [];
    if (!full) list.push({ id: 'phone', label: t('tab.phone'), icon: <PhoneIcon aria-hidden />, order: 0, render: () => null });
    if (isFeatureEnabled(cfg, 'history'))
      list.push({ id: 'history', label: t('tab.history'), icon: <HistoryIcon aria-hidden />, order: 10, render: () => <CallHistory onCall={dialRef.current} /> });
    if (isFeatureEnabled(cfg, 'contacts'))
      list.push({ id: 'contacts', label: t('tab.contacts'), icon: <UsersIcon aria-hidden />, order: 20, render: () => <ContactsList onCall={dialRef.current} /> });
    if (cfg.presence.enabled && isFeatureEnabled(cfg, 'presence'))
      list.push({ id: 'blf', label: t('tab.blf'), icon: <LayoutGridIcon aria-hidden />, order: 25, render: () => <BlfPanel onCall={dialRef.current} /> });
    if (cfg.chat.enabled && isFeatureEnabled(cfg, 'chat'))
      list.push({ id: 'chat', label: t('tab.chat'), icon: <MessagesSquareIcon aria-hidden />, order: 15, badge: <ChatUnreadBadge />, render: () => <ChatPanel onCall={dialRef.current} /> });
    // Voicemail list (V2-VM-02): needs voicemail.api and a softphone that implements it.
    if (voicemailList && isFeatureEnabled(cfg, 'voicemail'))
      list.push({ id: 'voicemail', label: t('tab.voicemail'), icon: <VoicemailIcon aria-hidden />, order: 18, badge: <VoicemailTabBadge />, render: () => <VoicemailPanel onCall={dialRef.current} /> });
    for (const t of extensions.tabs ?? []) {
      list.push({
        id: t.id,
        label: t.label,
        icon: t.icon ?? null,
        order: t.order ?? 50,
        render: () => t.render(renderContextRef.current()),
      });
    }
    if (isFeatureEnabled(cfg, 'settings'))
      list.push({ id: 'settings', label: t('tab.settings'), icon: <SettingsIcon aria-hidden />, order: 100, render: () => <Settings /> });
    return list.sort((a, b) => a.order - b.order);
    // cfg identity changes on updateConfig; disabledFeatures is what matters.
  }, [full, cfg.disabledFeatures.join('|'), cfg.presence.enabled, cfg.chat.enabled, voicemailList, extensions.tabs, t]);

  const firstTab = tabs[0]?.id ?? 'phone';
  const [tab, setTabState] = useState<string>(defaultTab ?? firstTab);
  const currentTab = tabs.some((t) => t.id === tab) ? tab : firstTab;
  const setTab = useCallback(
    (id: string) => {
      setTabState(id);
      onTabChange?.(id);
    },
    [onTabChange],
  );

  const dial = useCallback(
    (number: string) => {
      if (!full) setTab('phone');
      void api.call(number).catch(() => undefined);
    },
    [api, full, setTab],
  );
  const dialRef = useRef(dial);
  dialRef.current = dial;

  const openChat = useCallback(
    (peer: string | null) => {
      setChatPeer(peer);
      if (peer !== null) setTab('chat');
    },
    [setTab],
  );

  const renderContext = useCallback(
    (): SoftphoneRenderContext => ({
      api,
      snapshot: api.getSnapshot(),
      activeCall: (() => {
        const s = api.getSnapshot();
        return s.calls.find((c) => c.id === s.activeCallId) ?? null;
      })(),
      dial: (n) => dialRef.current(n),
      openTab: (id) => setTab(id),
    }),
    [api, setTab],
  );
  const renderContextRef = useRef(renderContext);
  renderContextRef.current = renderContext;

  // Jump to the phone view when a call starts or rings.
  useSoftphoneEvent('call:created', () => {
    if (!full) setTab('phone');
  });

  // ---- keyboard shortcuts --------------------------------------------------
  const handleKey = (e: KeyboardEvent | ReactKeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = (('composedPath' in e && typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target) ??
      null) as Element | null;
    if (target instanceof Element && target.closest('[role="dialog"],[role="menu"],[role="listbox"],form')) return;
    const editable = isEditable(target);
    const firstRinging = ringing[0];

    if (e.key === 'Enter') {
      if (target instanceof Element && target.closest('button,a,[role="tab"],[role="radio"],[role="switch"],textarea,select')) return;
      if (firstRinging) {
        e.preventDefault();
        void api.answer(firstRinging.id).catch(() => undefined);
      } else if (!editable && !displayCall && dialValue.trim()) {
        e.preventDefault();
        dial(dialValue.trim());
        setDialValue('');
      }
      return;
    }
    if (e.key === 'Escape') {
      if (firstRinging) {
        e.preventDefault();
        void api.reject(firstRinging.id).catch(() => undefined);
      } else if (displayCall) {
        e.preventDefault();
        void api.hangup(displayCall.id).catch(() => undefined);
      }
      return;
    }
    if (editable) return;
    if (/^[0-9*#]$/.test(e.key) || (e.key === '+' && !displayCall)) {
      e.preventDefault();
      if (displayCall && displayCall.state === 'connected') {
        playDtmfTone(e.key);
        void api.sendDtmf(e.key, displayCall.id).catch(() => undefined);
      } else if (!displayCall) {
        if (!full) setTab('phone');
        setDialValue((v) => v + e.key);
      }
    } else if (e.key === 'Backspace' && !displayCall && dialValue) {
      e.preventDefault();
      setDialValue((v) => v.slice(0, -1));
    }
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;

  useEffect(() => {
    if (hotkeys !== 'global') return;
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (root && e.composedPath().includes(root)) return; // handled by onKeyDown
      if (isEditable(e.composedPath()[0] as Element | null)) return;
      handleKeyRef.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys]);

  // ---- context ----------------------------------------------------------------
  const uiState: SoftphoneUIState = {
    layout,
    extensions,
    slots,
    contacts,
    history,
    theme,
    setTheme,
    locale,
    setLocale,
    dialValue,
    setDialValue,
    consult,
    setConsult,
    openTab: setTab,
    renderContext,
    api,
    chatPeer,
    openChat,
  };

  // ---- views ---------------------------------------------------------------------
  const reg = snapshot.registration.state;
  const loginView =
    showLogin && (reg === 'failed' || reg === 'unregistered' || (reg === 'idle' && !cfg.username));

  const ctx = renderContext();
  const phoneView = (
    <div className="flex min-h-0 flex-1 flex-col">
      {failure && (
        <CallFailureAlert
          notice={failure}
          onDismiss={() => setFailure(null)}
          onRetry={snapshot.registration.state === 'registered' ? dial : undefined}
        />
      )}
      {ringing[0] && established.length === 0 ? (
        <IncomingCallCard call={ringing[0]} variant="full" />
      ) : (
        <>
          {ringing.map((c) => (
            <IncomingCallCard key={c.id} call={c} variant="banner" />
          ))}
          {displayCall ? (
            <CallScreen key={displayCall.id} call={displayCall} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col justify-center gap-2 overflow-y-auto px-4 pt-2 pb-5">
              {slots.idleBanner?.(ctx)}
              <MicrophoneAccess compact />
              <Dialpad onCall={dial} autoFocus={full ? false : 'if-idle'} />
            </div>
          )}
        </>
      )}
    </div>
  );

  const panels = (extensions.panels ?? []).filter((p) => panelVisible(p, displayCall !== null));
  const renderPanels = (list: PanelExtension[]) =>
    list.map((p) => (
      <section key={p.id} aria-label={p.title ?? p.id} className="rounded-xl border bg-card p-3 shadow-xs">
        {p.title && <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{p.title}</h2>}
        {p.render(ctx)}
      </section>
    ));

  const sideTabs = tabs.filter((t) => t.id !== 'phone');

  const themeVars = useMemo(
    () => themeTokensToCssVars(brandColor ? { primary: brandColor, ...themeTokens } : themeTokens),
    [brandColor, themeTokens],
  );
  const rootStyle: CSSProperties = { ...(themeVars as CSSProperties), ...style };

  return (
    <I18nContext.Provider value={i18n}>
    <Direction.Provider dir={i18n.dir}>
    <SoftphoneUIContext.Provider value={uiState}>
      <PortalContext.Provider value={portal}>
        <TooltipProvider>
          <div
            ref={rootRef}
            role="region"
            aria-label={cfg.brandName}
            lang={i18n.locale}
            dir={i18n.dir}
            data-theme={resolvedTheme}
            data-layout={layout}
            onKeyDown={hotkeys ? (e) => handleKey(e) : undefined}
            className={cn(
              'sipkit-phone relative isolate flex flex-col overflow-hidden bg-background text-foreground',
              full
                ? 'h-full min-h-[560px] w-full rounded-xl border'
                : 'h-[var(--sipkit-height,640px)] max-h-[100dvh] w-full max-w-[420px] min-w-[320px] rounded-2xl border shadow-xl',
              className,
            )}
            style={rootStyle}
          >
            <AnnouncerProvider>
            <CallAnnouncer onFailure={setFailure} />
            <StatusBar actions={slots.headerActions?.(ctx)} />
            {!loginView && <PushPrompt />}

            {loginView ? (
              <ScrollArea className="min-h-0 flex-1">
                <LoginForm
                  className={full ? 'mx-auto w-full max-w-sm py-10' : undefined}
                  footer={slots.loginFooter?.({ api })}
                />
              </ScrollArea>
            ) : full ? (
              <div
                className={cn(
                  'grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(320px,400px)_1fr] md:overflow-hidden',
                  panels.length > 0 && 'lg:grid-cols-[minmax(320px,380px)_1fr_minmax(260px,340px)]',
                )}
              >
                <div className="flex min-h-[520px] flex-col border-b md:min-h-0 md:border-e md:border-b-0">
                  <LineSwitcher />
                  {phoneView}
                </div>
                {sideTabs.length > 0 && (
                  <Tabs value={currentTab} onValueChange={setTab} className="flex min-h-[400px] flex-col gap-0 md:min-h-0">
                    <div className="border-b px-3 py-2">
                      <TabsList className="w-full justify-start overflow-x-auto sm:w-fit">
                        {sideTabs.map((t) => (
                          <TabsTrigger key={t.id} value={t.id} className="flex-none px-3">
                            {t.icon}
                            {t.label}
                            {t.badge}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </div>
                    {sideTabs.map((t) => (
                      <TabsContent key={t.id} value={t.id} className="flex min-h-0 flex-col data-[state=inactive]:hidden">
                        {t.render()}
                      </TabsContent>
                    ))}
                  </Tabs>
                )}
                {panels.length > 0 && (
                  <aside aria-label={t('layout.panels')} className="flex min-h-0 flex-col gap-3 overflow-y-auto border-t bg-muted/30 p-3 lg:border-t-0 lg:border-s">
                    {renderPanels(panels)}
                  </aside>
                )}
              </div>
            ) : (
              <>
                <LineSwitcher />
                <Tabs value={currentTab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
                  {tabs.map((t) => (
                    <TabsContent key={t.id} value={t.id} className="flex min-h-0 flex-col data-[state=inactive]:hidden">
                      {t.id === 'phone' ? phoneView : t.render()}
                    </TabsContent>
                  ))}
                  {panels.some((p) => p.showInCompact) && (
                    <div className="flex max-h-[40%] flex-col gap-2 overflow-y-auto border-t p-3">
                      {renderPanels(panels.filter((p) => p.showInCompact))}
                    </div>
                  )}
                  {slots.footer?.(ctx)}
                  {tabs.length > 1 && (
                    <TabsList
                      aria-label={t('layout.sections')}
                      className="h-auto w-full shrink-0 rounded-none border-t bg-card p-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
                    >
                      {tabs.map((t) => (
                        <TabsTrigger
                          key={t.id}
                          value={t.id}
                          className="h-12 min-w-0 flex-col gap-0.5 rounded-lg text-[11px] text-muted-foreground data-[state=active]:bg-primary/8 data-[state=active]:text-primary data-[state=active]:shadow-none [&_svg:not([class*='size-'])]:size-5"
                        >
                          <span className="relative">
                            {t.icon}
                            {t.badge && <span className="absolute -top-1.5 -end-2.5">{t.badge}</span>}
                          </span>
                          <span className="max-w-full truncate">{t.label}</span>
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  )}
                </Tabs>
              </>
            )}
            {full && slots.footer?.(ctx)}

            {toaster && <SoftphoneToaster theme={resolvedTheme} dir={i18n.dir} />}
            {/* Portal host for dialogs, menus and tooltips (stays inside theme scope / shadow root). */}
            <div ref={portalRef} data-slot="portal-host" />
            </AnnouncerProvider>
          </div>
        </TooltipProvider>
      </PortalContext.Provider>
    </SoftphoneUIContext.Provider>
    </Direction.Provider>
    </I18nContext.Provider>
  );
}

function panelVisible(p: PanelExtension, inCall: boolean): boolean {
  const when = p.when ?? 'always';
  return when === 'always' || (when === 'in-call' ? inCall : !inCall);
}
