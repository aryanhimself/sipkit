/**
 * Electron main process for the SipKit desktop app
 * (V2-DESK-01 shell, V2-DESK-03 integrations). See docs/desktop.md.
 *
 * Responsibilities: single window + tray, settings and keychain-backed
 * credentials, global hotkeys, OS notifications, tel:/sip:/callto: links,
 * auto-update. The softphone itself (SIP.js engine + sipkit-ui) runs
 * in the sandboxed renderer; main talks to it only through the commands and
 * reports defined in shared/ipc.ts.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, globalShortcut, ipcMain, safeStorage, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { APP_SCHEME, DIAL_SCHEMES, findAppUrlInArgv, parseAppUrl, type ParsedAppUrl } from '../shared/dial-url';
import type { HotkeyAction } from '../shared/hotkeys';
import { resolveDesktopLocale, translate, type DesktopMessageKey } from '../shared/i18n';
import { IPC, type DesktopBootstrap, type DesktopCommand, type HotkeyRegistrationResult, type UpdateState } from '../shared/ipc';
import { localSipDomains, serverHost, type DesktopSettings, type EngineKind } from '../shared/settings';
import { isTrayStatus } from '../shared/status';
import { parseCallInfo } from '../shared/validate';
import { CommandBus } from './command-bus';
import { CredentialStore, memoryKeyStore } from './credentials';
import { invokeNativeEngine, nativeEngineHost, setNativeEngineEmitter } from './engine-host';
import { HotkeyManager } from './hotkeys';
import { NotificationCenter } from './notifications';
import { allowCertificateFor, hardenApp, hardenDefaultSession, isTrustedSender } from './security';
import { SettingsStore } from './settings-store';
import { TrayController } from './tray';
import { resolveUpdateConfig, startAutoUpdates } from './updater';

const TEST = process.env.SIPKIT_DESKTOP_TEST === '1';
/** Set by electron-vite in `pnpm dev`. */
const DEV_SERVER = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const APP_NAME = 'SipKit';

// Separate profile for tests / side-by-side instances. Must happen before the
// single-instance lock, which is keyed on the userData directory.
if (process.env.SIPKIT_DESKTOP_USER_DATA) app.setPath('userData', resolve(process.env.SIPKIT_DESKTOP_USER_DATA));
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.sipkit.phone');

const log = (message: string) => {
  if (!app.isPackaged || TEST) console.log(`[desktop] ${message}`);
};

if (!app.requestSingleInstanceLock()) {
  // Another instance is running: it receives our argv via 'second-instance'.
  app.quit();
} else {
  bootstrapMain();
}

function bootstrapMain(): void {
  const store = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
  const credentials = new CredentialStore(
    join(app.getPath('userData'), 'credentials.bin'),
    TEST ? memoryKeyStore() : safeStorage,
  );
  let win: BrowserWindow | null = null;
  let quitting = false;
  let hotkeyResult: HotkeyRegistrationResult = { registered: [], problems: [] };
  let lastUpdate: UpdateState = { state: 'disabled' };

  const locale = () => resolveDesktopLocale(store.get().locale, app.getLocale());
  const t = (key: DesktopMessageKey, params?: Record<string, string>) => translate(locale(), key, params);

  const effectiveEngine = (settings: DesktopSettings): EngineKind => {
    const override = process.env.SIPKIT_DESKTOP_ENGINE;
    return override === 'mock' || override === 'sipjs' || override === 'native' ? override : settings.engine;
  };

  const bus = new CommandBus((command) => win?.webContents.send(IPC.command, command));

  // ---- window -------------------------------------------------------------
  function createWindow(): BrowserWindow {
    const w = new BrowserWindow({
      width: 440,
      height: 760,
      minWidth: 360,
      minHeight: 560,
      show: false,
      title: APP_NAME,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        // Keep timers / ringing alive while hidden in the tray.
        backgroundThrottling: false,
      },
    });
    w.once('ready-to-show', () => {
      if (!process.argv.includes('--hidden')) w.show();
    });
    w.on('close', (event) => {
      if (!quitting && store.get().closeToTray) {
        event.preventDefault();
        w.hide();
      }
    });
    w.on('closed', () => {
      if (win === w) win = null;
      bus.reset();
    });
    w.webContents.on('did-start-loading', () => bus.reset());
    w.webContents.on('render-process-gone', () => bus.reset());
    if (DEV_SERVER) void w.loadURL(DEV_SERVER);
    else void w.loadFile(join(__dirname, '../renderer/index.html'));
    return w;
  }

  function showWindow(): void {
    // macOS can deliver 'open-url' before 'ready'; the window is created on ready.
    if (!app.isReady()) return;
    if (!win || win.isDestroyed()) win = createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  const windowFocused = () => Boolean(win && !win.isDestroyed() && win.isVisible() && win.isFocused());

  // ---- commands from URLs / hotkeys / tray / notifications ----------------
  function handleParsed(parsed: ParsedAppUrl | null): void {
    if (!parsed) return;
    if (parsed.kind === 'dial') {
      bus.send({ type: 'dial', target: parsed.target, source: 'url' });
      showWindow();
      return;
    }
    if (parsed.action === 'answer') {
      bus.send(parsed.callId ? { type: 'answer', callId: parsed.callId } : { type: 'answer' });
      showWindow();
    } else if (parsed.action === 'decline') {
      bus.send(parsed.callId ? { type: 'decline', callId: parsed.callId } : { type: 'decline' });
    } else showWindow();
  }
  const parseOptions = () => ({ localDomains: localSipDomains(store.get().account) });
  const handleUrl = (url: string) => {
    log(`open url ${url}`);
    handleParsed(parseAppUrl(url, parseOptions()));
  };
  const handleArgv = (argv: readonly string[]) => handleParsed(findAppUrlInArgv(argv, parseOptions()));

  const hotkeyCommand: Record<HotkeyAction, DesktopCommand> = {
    answer: { type: 'answer' },
    hangup: { type: 'hangup' },
    toggleMute: { type: 'toggleMute' },
    toggleDnd: { type: 'toggleDnd' },
  };
  const hotkeys = new HotkeyManager(globalShortcut, (action) => {
    log(`hotkey ${action}`);
    bus.send(hotkeyCommand[action]);
  });

  const notifications = new NotificationCenter(
    process.platform,
    () => ({ incomingTitle: t('notify.incomingTitle'), missedTitle: t('notify.missedTitle'), answer: t('notify.answer'), decline: t('notify.decline') }),
    {
      answer: (callId) => {
        bus.send({ type: 'answer', callId });
        showWindow();
      },
      decline: (callId) => bus.send({ type: 'decline', callId }),
      show: showWindow,
    },
    !TEST,
  );

  const tray = new TrayController(APP_NAME, t, {
    show: showWindow,
    toggleDnd: () => bus.send({ type: 'toggleDnd' }),
    openSettings: () => {
      showWindow();
      bus.send({ type: 'openSettings' });
    },
    quit: () => {
      quitting = true;
      app.quit();
    },
  });

  // macOS delivers links through 'open-url' (also before 'ready' on cold start).
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleUrl(url);
  });
  // Windows / Linux: a second launch (link click, toast button) lands here.
  app.on('second-instance', (_event, argv) => {
    const parsed = findAppUrlInArgv(argv, parseOptions());
    if (parsed) handleParsed(parsed);
    else showWindow();
  });

  // ---- protocol registration ----------------------------------------------
  function registerProtocols(settings: DesktopSettings): void {
    // In dev / e2e the "app" is the generic Electron binary: never make it the
    // system tel: handler unless explicitly asked.
    if ((!app.isPackaged && process.env.SIPKIT_DESKTOP_REGISTER_PROTOCOLS !== '1') || TEST) return;
    const args = app.isPackaged ? [] : [resolve(process.argv[1] ?? '.')];
    const set = (scheme: string) =>
      app.isPackaged ? app.setAsDefaultProtocolClient(scheme) : app.setAsDefaultProtocolClient(scheme, process.execPath, args);
    set(APP_SCHEME);
    for (const scheme of DIAL_SCHEMES) {
      if (settings.handleTelLinks) set(scheme);
      else if (app.isDefaultProtocolClient(scheme)) app.removeAsDefaultProtocolClient(scheme);
    }
  }

  // ---- IPC ----------------------------------------------------------------
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (event: IpcMainInvokeEvent, ...args: A): R => {
      if (!isTrustedSender(event, DEV_SERVER)) throw new Error('Untrusted IPC sender');
      return fn(...args);
    };
  const guardOn =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (event: IpcMainEvent, ...args: A): void => {
      if (isTrustedSender(event, DEV_SERVER)) fn(...args);
    };

  ipcMain.handle(
    IPC.bootstrap,
    guard((): DesktopBootstrap => {
      const settings = store.get();
      return {
        settings,
        hasPassword: credentials.has(),
        keychainAvailable: credentials.encryptionAvailable,
        engine: effectiveEngine(settings),
        nativeEngineAvailable: nativeEngineHost() !== null,
        platform: process.platform,
        osLocale: app.getLocale(),
        appVersion: app.getVersion(),
        hotkeyProblems: hotkeyResult.problems,
      };
    }),
  );
  ipcMain.handle(
    IPC.saveSettings,
    guard((patch: unknown) => {
      const before = store.get();
      const next = store.update(patch);
      if (JSON.stringify(before.hotkeys) !== JSON.stringify(next.hotkeys)) hotkeyResult = hotkeys.apply(next.hotkeys);
      if (before.handleTelLinks !== next.handleTelLinks) registerProtocols(next);
      if (before.locale !== next.locale) tray.setTranslator(t);
      return next;
    }),
  );
  ipcMain.handle(IPC.savePassword, guard((password: unknown) => credentials.save(String(password ?? ''))));
  ipcMain.handle(IPC.getPassword, guard(() => credentials.get()));
  ipcMain.handle(
    IPC.signOut,
    guard(() => {
      credentials.clear();
      store.update({ account: null });
    }),
  );
  ipcMain.handle(
    IPC.applyHotkeys,
    guard((raw: unknown) => {
      const next = store.update({ hotkeys: raw });
      hotkeyResult = hotkeys.apply(next.hotkeys);
      return hotkeyResult;
    }),
  );
  ipcMain.handle(IPC.engineInvoke, guard((method: unknown, args: unknown) => invokeNativeEngine(method, args)));

  ipcMain.on(IPC.ready, guardOn(() => bus.ready()));
  ipcMain.on(
    IPC.status,
    guardOn((status: unknown) => {
      if (isTrayStatus(status)) tray.setStatus(status);
    }),
  );
  ipcMain.on(
    IPC.incomingCall,
    guardOn((raw: unknown) => {
      const call = parseCallInfo(raw);
      if (!call || !store.get().notifications.incoming) return;
      // In front of the user already: the widget shows the call.
      if (windowFocused() && !TEST) return;
      notifications.showIncoming(call);
    }),
  );
  ipcMain.on(
    IPC.incomingCallEnded,
    guardOn((callId: unknown) => {
      if (typeof callId === 'string') notifications.dismissIncoming(callId);
    }),
  );
  ipcMain.on(
    IPC.missedCall,
    guardOn((raw: unknown) => {
      const call = parseCallInfo(raw);
      if (call && store.get().notifications.missed) notifications.showMissed(call);
    }),
  );

  // ---- lifecycle ----------------------------------------------------------
  hardenApp(DEV_SERVER);
  allowCertificateFor(() => {
    const s = store.get();
    return s.allowInsecureCerts && s.account ? serverHost(s.account.server) : null;
  });

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => {
    hotkeys.clear();
    globalShortcut.unregisterAll();
    notifications.dismissAll();
    tray.destroy();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', showWindow);

  void app.whenReady().then(async () => {
    hardenDefaultSession(DEV_SERVER);
    const settings = store.get();
    registerProtocols(settings);
    hotkeyResult = hotkeys.apply(settings.hotkeys);
    for (const p of hotkeyResult.problems) log(`hotkey ${p.action} (${p.accelerator}) not registered: ${p.error}`);
    tray.create();
    win = createWindow();
    setNativeEngineEmitter((event) => win?.webContents.send(IPC.engineEvent, event));
    // A link that launched the app (Windows / Linux pass it in argv).
    handleArgv(process.argv.slice(1));

    const updater = await startAutoUpdates(
      resolveUpdateConfig({
        isPackaged: app.isPackaged,
        env: process.env,
        hasBuildFeed: app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
      }),
      (state) => {
        lastUpdate = state;
        win?.webContents.send(IPC.update, state);
      },
      log,
    );
    app.on('will-quit', () => updater.stop());

    if (TEST) {
      // Hooks for the Playwright _electron suite (apps/desktop/e2e). A real
      // global key press cannot be synthesised headless, so tests call the
      // same handler globalShortcut would.
      (globalThis as Record<string, unknown>).__sipkitDesktopTest = {
        triggerHotkey: (action: HotkeyAction) => hotkeys.trigger(action),
        registeredHotkeys: () => hotkeyResult.registered.map((h) => h.accelerator),
        isShortcutRegistered: (accelerator: string) => globalShortcut.isRegistered(accelerator),
        handleUrl,
        trayStatus: () => tray.current,
        notifications: () => notifications.log.slice(),
        notificationAction: (callId: string, action: 'answer' | 'decline') =>
          action === 'answer' ? bus.send({ type: 'answer', callId }) : bus.send({ type: 'decline', callId }),
        lastUpdate: () => lastUpdate,
        settings: () => store.get(),
      };
    }
  });
}
