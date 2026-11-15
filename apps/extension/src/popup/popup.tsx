/**
 * Popup: just another client of the extension's softphone instance. The
 * standard sipkit-ui widget runs on a RemoteSoftphone over a runtime
 * port, so it shows exactly what every attached page shows.
 */
import 'sipkit-ui/styles.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteSoftphone } from 'sipkit-core/remote';
import { Softphone } from 'sipkit-ui';
import { CLIENT_PORT, RuntimePortTransport, msg, uiLocale } from '../shared/ext';
import { SETTINGS_KEY, sanitizeSettings } from '../shared/settings';

async function connect(remote: RemoteSoftphone): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'sipkit:ensure-host' });
  await remote.connect(new RuntimePortTransport(chrome.runtime.connect({ name: CLIENT_PORT })), { timeoutMs: 8000 });
}

function Popup() {
  const [remote] = useState(() => new RemoteSoftphone());
  const [status, setStatus] = useState(remote.status);
  const [failed, setFailed] = useState(false);
  const [softphoneUrl, setSoftphoneUrl] = useState('');

  useEffect(() => {
    let active = true;
    const off = remote.onStatus((s) => {
      setStatus(s);
      // Host restarted (e.g. engine switched in Options): attach again.
      if (s === 'detached' && active) setTimeout(() => active && void connect(remote).catch(() => setFailed(true)), 300);
    });
    void connect(remote).catch(() => setFailed(true));
    void chrome.runtime.sendMessage({ type: 'sipkit:popup-opened' }).catch(() => undefined);
    void chrome.storage.local.get(SETTINGS_KEY).then((r) => setSoftphoneUrl(sanitizeSettings(r[SETTINGS_KEY]).softphoneUrl));
    return () => {
      active = false;
      off();
      remote.disconnect();
    };
  }, [remote]);

  return (
    <>
      <div className="ext-bar" data-testid="ext-status" data-status={status}>
        <span className="ext-grow">{status === 'connected' ? msg('popupConnected') : msg('popupConnecting')}</span>
        {softphoneUrl ? (
          <button type="button" onClick={() => void chrome.tabs.create({ url: softphoneUrl })}>
            {msg('popupOpenSoftphone')}
          </button>
        ) : null}
        <button type="button" onClick={() => void chrome.runtime.openOptionsPage()}>
          {msg('popupOptions')}
        </button>
      </div>
      {failed && status !== 'connected' ? (
        <p className="ext-message" role="alert">
          {msg('popupHostUnavailable')}
        </p>
      ) : (
        <div className="ext-widget">
          <Softphone softphone={remote} layout="compact" theme="system" locale={uiLocale()} persistHistory={false} />
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
