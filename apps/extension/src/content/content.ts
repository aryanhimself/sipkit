/**
 * Content script (isolated world, document_start).
 *
 * 1. Relay: when the page posts `ext:hello` with a MessagePort (core
 *    `connectExtension()`), check source / origin / shape and the allow-list,
 *    ack on the port, then pipe it to the extension's softphone host over a
 *    runtime port. Only protocol messages pass, in both directions. If the
 *    host restarts, reconnect and let the new `welcome` resync the page.
 * 2. Click-to-call: with the setting on, trusted clicks on tel:/sip:/callto:
 *    links dial on the extension's instance instead of navigating.
 */
import {
  EXTENSION_BRIDGE_NS,
  EXTENSION_BRIDGE_VERSION,
  isExtensionWindowMessage,
  isRemoteMessage,
} from 'sipkit-core/remote';
import { CLIENT_PORT } from '../shared/ext';
import { isDialLink } from '../shared/phone';
import { SETTINGS_KEY, isAllowedUrl, sanitizeSettings, type Settings } from '../shared/settings';

const flag = globalThis as unknown as { __sipkitSoftphoneContent?: boolean };

if (!flag.__sipkitSoftphoneContent) {
  flag.__sipkitSoftphoneContent = true;
  main();
}

function main(): void {
  let settings: Settings | null = null;
  const settingsReady = chrome.storage.local
    .get(SETTINGS_KEY)
    .then((r) => {
      settings = sanitizeSettings(r[SETTINGS_KEY]);
    })
    .catch(() => {
      settings = sanitizeSettings(undefined);
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) settings = sanitizeSettings(changes[SETTINGS_KEY].newValue);
  });

  const control = (type: 'ext:ack' | 'ext:refused', extra: Record<string, unknown> = {}) => ({
    ns: EXTENSION_BRIDGE_NS,
    v: EXTENSION_BRIDGE_VERSION,
    type,
    ...extra,
  });

  // ---- relay -----------------------------------------------------------------
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    if (!isExtensionWindowMessage(e.data) || e.data.type !== 'ext:hello') return;
    const pagePort = e.ports[0];
    if (!pagePort) return;
    void settingsReady.then(() => relay(pagePort));
  });

  async function relay(pagePort: MessagePort): Promise<void> {
    if (!settings || !isAllowedUrl(window.location.href, settings.allowedOrigins)) {
      pagePort.postMessage(control('ext:refused', { reason: 'origin-not-allowed' }));
      pagePort.close();
      return;
    }
    pagePort.postMessage(control('ext:ack', { extensionVersion: chrome.runtime.getManifest().version }));

    let runtimePort: chrome.runtime.Port | null = null;
    let pageGone = false;
    let attempts = 0;
    const queue: unknown[] = [];

    const connect = async () => {
      if (pageGone) return;
      try {
        const res = (await chrome.runtime.sendMessage({ type: 'sipkit:ensure-host' })) as { ok: boolean; value?: { allowed: boolean } } | undefined;
        if (!res?.ok || !res.value?.allowed) throw new Error('refused');
        const port = chrome.runtime.connect({ name: CLIENT_PORT });
        runtimePort = port;
        attempts = 0;
        port.onMessage.addListener((m: unknown) => {
          if (!isRemoteMessage(m)) return;
          // The host instance was replaced: reconnect instead of closing the page's channel.
          if (m.type === 'host-bye') return;
          pagePort.postMessage(m);
        });
        port.onDisconnect.addListener(() => {
          if (runtimePort === port) runtimePort = null;
          retry();
        });
        for (const m of queue.splice(0)) port.postMessage(m);
      } catch {
        retry();
      }
    };
    const retry = () => {
      if (pageGone) return;
      if (!chrome.runtime?.id || ++attempts > 20) {
        // Extension reloaded or gone: tell the page so it can fall back.
        pagePort.postMessage({ p: 'sipkit/remote', v: 1, type: 'host-bye', reason: 'extension-unavailable' });
        pagePort.close();
        return;
      }
      setTimeout(() => void connect(), Math.min(2000, 100 * attempts));
    };

    pagePort.onmessage = (e: MessageEvent) => {
      const m: unknown = e.data;
      if (!isRemoteMessage(m)) return;
      if (runtimePort) runtimePort.postMessage(m);
      else if (queue.length < 50) queue.push(m);
      if (m.type === 'bye') {
        pageGone = true;
        runtimePort?.disconnect();
        pagePort.close();
      }
    };
    await connect();
  }

  // Tell a page that is already waiting that the extension is here.
  window.postMessage({ ns: EXTENSION_BRIDGE_NS, v: EXTENSION_BRIDGE_VERSION, type: 'ext:announce' }, window.location.origin);

  // ---- click-to-call ----------------------------------------------------------------
  document.addEventListener(
    'click',
    (e: MouseEvent) => {
      if (!settings?.clickToCall || !e.isTrusted || e.defaultPrevented || e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      const link = target?.closest('a[href]') as HTMLAnchorElement | null;
      const href = link?.getAttribute('href') ?? '';
      if (!isDialLink(href)) return;
      e.preventDefault();
      e.stopPropagation();
      void chrome.runtime.sendMessage({ type: 'sipkit:dial', number: href }).catch(() => undefined);
    },
    true,
  );
}
