/**
 * Auto-update (V2-DESK-01) via electron-updater against a generic HTTPS feed
 * (a static directory holding `latest.yml` / `latest-mac.yml` and the
 * installers, as produced by electron-builder).
 *
 * Feed URL, first match wins:
 * 1. `SIPKIT_UPDATE_URL` at runtime (support / staging override),
 * 2. `app-update.yml` written by electron-builder from `SIPKIT_UPDATE_URL` at build time.
 *
 * Without either, auto-update is off. A no-op in development (`app.isPackaged === false`), in e2e (`SIPKIT_DESKTOP_TEST=1`)
 * and with `SIPKIT_UPDATE_DISABLED=1`.
 */
import type { UpdateState } from '../shared/ipc';

export interface UpdateConfig {
  enabled: boolean;
  /** Explicit feed URL (otherwise app-update.yml from the build). */
  feedUrl: string | null;
  reason?: 'dev' | 'test' | 'disabled' | 'invalidUrl' | 'noFeed';
}

export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function resolveUpdateConfig(opts: {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  /** `resources/app-update.yml` exists (the build had SIPKIT_UPDATE_URL). */
  hasBuildFeed: boolean;
}): UpdateConfig {
  const { isPackaged, env, hasBuildFeed } = opts;
  if (!isPackaged) return { enabled: false, feedUrl: null, reason: 'dev' };
  if (env.SIPKIT_DESKTOP_TEST === '1') return { enabled: false, feedUrl: null, reason: 'test' };
  if (env.SIPKIT_UPDATE_DISABLED === '1') return { enabled: false, feedUrl: null, reason: 'disabled' };
  const raw = env.SIPKIT_UPDATE_URL?.trim();
  if (!raw) return hasBuildFeed ? { enabled: true, feedUrl: null } : { enabled: false, feedUrl: null, reason: 'noFeed' };
  try {
    const url = new URL(raw);
    // Updates must come over HTTPS (http only for a local test feed).
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      return { enabled: false, feedUrl: null, reason: 'invalidUrl' };
    }
    return { enabled: true, feedUrl: url.toString() };
  } catch {
    return { enabled: false, feedUrl: null, reason: 'invalidUrl' };
  }
}

export interface UpdaterHandle {
  stop(): void;
}

/** Start periodic update checks. electron-updater is only loaded when enabled. */
export async function startAutoUpdates(
  config: UpdateConfig,
  onState: (state: UpdateState) => void,
  log: (message: string) => void = () => {},
): Promise<UpdaterHandle> {
  if (!config.enabled) {
    log(`auto-update off (${config.reason ?? 'unknown'})`);
    onState({ state: 'disabled' });
    return { stop() {} };
  }
  const { autoUpdater } = await import('electron-updater');
  if (config.feedUrl) autoUpdater.setFeedURL({ provider: 'generic', url: config.feedUrl });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => onState({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => onState({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => onState({ state: 'none' }));
  autoUpdater.on('update-downloaded', (info) => onState({ state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => {
    log(`auto-update error: ${err.message}`);
    onState({ state: 'error', message: err.message });
  });
  const check = () => {
    autoUpdater.checkForUpdates().catch((err: unknown) => log(`update check failed: ${String(err)}`));
  };
  check();
  const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}
