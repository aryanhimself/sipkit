/**
 * Renderer hardening (V2-DESK-01). Applied app-wide before any window opens.
 *
 * - BrowserWindow uses contextIsolation, sandbox, no nodeIntegration, webSecurity
 *   (see window.ts); this file adds the session- and app-level guards.
 * - CSP response header (the built index.html also carries it as <meta>).
 * - Only microphone/camera (WebRTC), notifications and fullscreen are granted,
 *   and only to the app's own pages.
 * - No navigation away from the app, no new windows (https links open in the
 *   default browser), no <webview>.
 * - IPC senders are checked against the app's own origin.
 */
import { app, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron';
import { buildCsp } from '../shared/csp';
import { isAppUrl } from './app-url';

const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection']);

export function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent, devServer: string | undefined): boolean {
  const url = event.senderFrame?.url ?? '';
  return isAppUrl(url, devServer);
}

export function hardenSession(ses: Session, devServer: string | undefined): void {
  const csp = buildCsp(devServer ? { devServer } : {});
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(webContents.getURL(), devServer));
  });
  ses.setPermissionCheckHandler((webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(webContents?.getURL() ?? '', devServer);
  });
}

/** App-level guards; call before 'ready'. Call {@link hardenDefaultSession} once ready. */
export function hardenApp(devServer: string | undefined): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url, devServer)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!isAppUrl(url, devServer)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

export function hardenDefaultSession(devServer: string | undefined): void {
  hardenSession(session.defaultSession, devServer);
}

/**
 * Self-signed certificates (dev PBX): accepted only when the user enabled
 * `allowInsecureCerts` and only for the configured server host.
 */
export function allowCertificateFor(getHost: () => string | null): void {
  app.on('certificate-error', (event, _webContents, url, _error, _cert, callback) => {
    const host = getHost();
    let target = '';
    try {
      target = new URL(url).hostname;
    } catch {
      /* ignore */
    }
    if (host && target === host) {
      event.preventDefault();
      callback(true);
    } else callback(false);
  });
}
