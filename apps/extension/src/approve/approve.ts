/** "Connect this site": the user approves a page to provision SIP credentials into the extension. */
import { applyI18n } from '../shared/i18n-dom';
import { originOf } from '../shared/settings';

applyI18n(document);
const origin = originOf(new URLSearchParams(location.search).get('origin') ?? '');
document.getElementById('origin')!.textContent = origin || '—';

const decide = (approved: boolean) => {
  if (!origin) return window.close();
  void chrome.runtime
    .sendMessage({ type: 'sipkit:approve', origin, approved })
    .catch(() => undefined)
    .finally(() => window.close());
};
document.getElementById('allow')!.addEventListener('click', () => decide(true));
document.getElementById('deny')!.addEventListener('click', () => decide(false));
