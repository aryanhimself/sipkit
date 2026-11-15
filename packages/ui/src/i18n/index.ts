export { en } from './en';
export type { MessageKey, Messages } from './en';
export { ne } from './ne';
export { registerLocale, registeredLocales, resolveLocale } from './locales';
export type { LocaleDefinition, ResolvedLocale, TextDirection } from './locales';
export { createI18n, I18nContext, useI18n, useT } from './context';
export type { I18n, Translate, TranslateValues } from './context';
export { createPseudoLocale, pseudoMessage } from './pseudo';
