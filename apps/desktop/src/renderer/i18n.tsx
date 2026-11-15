import { createContext, useContext, type ReactNode } from 'react';
import { translate, type DesktopMessageKey } from '../shared/i18n';

type T = (key: DesktopMessageKey, params?: Record<string, string | number>) => string;

const LocaleContext = createContext<'en' | 'ne'>('en');

export function DesktopLocaleProvider({ locale, children }: { locale: 'en' | 'ne'; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** Translator for the desktop shell strings (shared/i18n.ts). */
export function useDesktopT(): T {
  const locale = useContext(LocaleContext);
  return (key, params) => translate(locale, key, params);
}
