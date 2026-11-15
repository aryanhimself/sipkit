import { createContext, Fragment, createElement, useContext, type ReactNode } from 'react';
import { isSoftphoneError, type DisconnectReason, type SoftphoneNotification } from 'sipkit-core';
import { formatDuration, formatLocaleNumber, formatTime, formatWhen } from '@/lib/format';
import type { MessageKey, Messages } from './en';
import { formatMessage, formatToParts, type FormatContext, type MessageValues } from './format-message';
import { resolveLocale, type TextDirection } from './locales';

export type TranslateValues = Record<string, string | number>;
export type Translate = (key: MessageKey, values?: TranslateValues) => string;

/** Everything the UI needs to render text for one locale. */
export interface I18n {
  /** Resolved language tag (for `lang`). */
  locale: string;
  /** The registered locale that matched first (e.g. 'ne' for 'ne-NP'). */
  code: string;
  /** Locale used for Intl formatting. */
  intlLocale: string;
  dir: TextDirection;
  messages: Messages;
  t: Translate;
  /** Like `t` but values may be React nodes (e.g. `<b>`). */
  rich: (key: MessageKey, values: Record<string, ReactNode>) => ReactNode;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** Call timer, "m:ss" / "h:mm:ss". */
  duration: (ms: number) => string;
  time: (epochMs: number) => string;
  /** Today: time; yesterday: "Yesterday"; else a short date. */
  when: (epochMs: number, now?: number) => string;
  /** Localised text for a thrown error (core error codes are mapped). */
  error: (error: unknown) => string;
  /** Short text for a call end reason. */
  endReason: (reason: DisconnectReason) => string;
  /**
   * Human-readable reason a call did not go through ("Number not reachable (404)",
   * "Microphone blocked — …", "Busy (486)"). Null for normal endings (hang up,
   * cancel, transfer). Pass `code` only for calls you placed: on incoming calls the
   * code is usually your own reject response.
   */
  callFailure: (reason: DisconnectReason, code?: number) => string | null;
  /** "Wrong username or password (403)" for known SIP codes, else the server's reason. */
  registrationFailure: (reason?: string, code?: number) => string;
  /** Title/message of a core `notification`, translated by its `code` when known. */
  notification: (n: SoftphoneNotification) => { title: string; message?: string };
}

const CALL_FAILURE_KEYS: Partial<Record<DisconnectReason, MessageKey>> = {
  'media-error': 'callFailure.media-error',
  busy: 'callFailure.busy',
  rejected: 'callFailure.rejected',
  'no-answer': 'callFailure.no-answer',
  failed: 'callFailure.failed',
};

const END_REASON_KEYS: Record<DisconnectReason, MessageKey> = {
  'local-hangup': 'endReason.local-hangup',
  'remote-hangup': 'endReason.remote-hangup',
  rejected: 'endReason.rejected',
  busy: 'endReason.busy',
  'no-answer': 'endReason.no-answer',
  cancelled: 'endReason.cancelled',
  transferred: 'endReason.transferred',
  failed: 'endReason.failed',
  'media-error': 'endReason.media-error',
  dnd: 'endReason.dnd',
};

/**
 * Build an I18n for a locale (tag, list of tags, or 'auto') with optional
 * message overrides on top of the resolved catalogue.
 */
export function createI18n(locale?: string | readonly string[] | null, overrides?: Partial<Messages>): I18n {
  const resolved = resolveLocale(locale);
  const messages: Messages = overrides ? { ...resolved.messages, ...overrides } : resolved.messages;
  const intlLocale = resolved.intlLocale;
  let plurals: Intl.PluralRules;
  try {
    plurals = new Intl.PluralRules(intlLocale);
  } catch {
    plurals = new Intl.PluralRules('en');
  }
  const ctx: FormatContext = {
    plural: (n) => plurals.select(n),
    number: (n) => formatLocaleNumber(n, intlLocale),
  };
  const lookup = (key: MessageKey): string => messages[key] ?? key;
  const t: Translate = (key, values) => formatMessage(lookup(key), values as MessageValues, ctx);
  const has = (key: string): key is MessageKey => Object.prototype.hasOwnProperty.call(messages, key);
  const registrationFailure = (reason?: string, code?: number): string => {
    const sipKey = `sip.${code}`;
    if (code && has(sipKey)) return `${t(sipKey)} (${code})`;
    return `${reason || t('registration.failedReason')}${code ? ` (${code})` : ''}`;
  };
  const callFailure = (reason: DisconnectReason, code?: number): string | null => {
    const key = CALL_FAILURE_KEYS[reason];
    if (!key) return null;
    // A blocked microphone is the actionable part, whatever the server answered.
    if (reason === 'media-error') return t(key);
    const sipKey = `callSip.${code}`;
    if (code && has(sipKey)) return `${t(sipKey)} (${code})`;
    return code ? `${t(key)} (${code})` : t(key);
  };

  const i18n: I18n = {
    locale: resolved.tag,
    code: resolved.chain[0] ?? 'en',
    intlLocale,
    dir: resolved.dir,
    messages,
    t,
    rich: (key, values) => {
      const parts = formatToParts(lookup(key), values, ctx);
      return createElement(Fragment, null, ...parts.map((p, i) => createElement(Fragment, { key: i }, p as ReactNode)));
    },
    number: (value, options) => formatLocaleNumber(value, intlLocale, options),
    duration: (ms) => formatDuration(ms, intlLocale),
    time: (epochMs) => formatTime(epochMs, intlLocale),
    when: (epochMs, now) => formatWhen(epochMs, now, intlLocale),
    endReason: (reason) => t(END_REASON_KEYS[reason] ?? 'history.notConnected'),
    registrationFailure,
    callFailure,
    notification: (n) => {
      if (!n.code) return { title: n.title, message: n.message };
      const params = n.params ?? {};
      const titleKey = `notification.${n.code}.title`;
      const messageKey = `notification.${n.code}.message`;
      const title = has(titleKey) ? t(titleKey, params) : n.title;
      if (n.code === 'registrationFailed') {
        const code = typeof params.code === 'number' ? params.code : undefined;
        const reason = typeof params.reason === 'string' ? params.reason : undefined;
        return { title, message: code || reason ? registrationFailure(reason, code) : n.message };
      }
      return { title, message: has(messageKey) ? t(messageKey, params) : n.message };
    },
    error: (error) => {
      if (isSoftphoneError(error)) {
        const key = `error.${error.code}` as MessageKey;
        if (key in messages) return t(key, { detail: error.message });
      }
      return error instanceof Error ? error.message : String(error);
    },
  };
  return i18n;
}

export const defaultI18n: I18n = createI18n('en');

export const I18nContext = createContext<I18n>(defaultI18n);

/** Locale, direction, `t` and formatters of the surrounding <Softphone> (English outside one). */
export function useI18n(): I18n {
  return useContext(I18nContext);
}

/** The translate function: `t('controls.hold')`, `t('voicemail.new', { count: 3 })`. */
export function useT(): Translate {
  return useContext(I18nContext).t;
}
