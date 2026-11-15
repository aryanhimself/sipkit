import { msg, uiLocale } from './ext';

/** Fill `[data-i18n]` elements from _locales and set lang/dir. */
export function applyI18n(doc: Document): void {
  doc.documentElement.lang = uiLocale();
  doc.documentElement.dir = msg('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
  doc.title = msg('extName');
  for (const el of doc.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = msg(el.dataset.i18n!);
  }
}
