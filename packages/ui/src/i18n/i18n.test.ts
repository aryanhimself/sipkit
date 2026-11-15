import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftphoneError } from 'sipkit-core';
import { createI18n } from './context';
import { en, type Messages } from './en';
import { formatMessage, messageArguments, parseMessage, type FormatContext } from './format-message';
import { registerLocale, resolveLocale } from './locales';
import { ne } from './ne';
import { createPseudoLocale, pseudoMessage } from './pseudo';

// --- compile-time completeness: these must fail typecheck ----------------------
// @ts-expect-error a locale missing keys is not a complete catalogue
const _missing: Messages = { 'meta.languageName': 'x' };
// @ts-expect-error unknown keys are rejected
const _extra: Messages = { ...en, 'tab.unknown': 'x' };
void _missing;
void _extra;

const enCtx: FormatContext = {
  plural: (n) => new Intl.PluralRules('en').select(n),
  number: (n) => new Intl.NumberFormat('en').format(n),
};

describe('formatMessage (ICU-lite)', () => {
  it('interpolates arguments and formats numbers', () => {
    expect(formatMessage('Call {name}', { name: 'Alice' }, enCtx)).toBe('Call Alice');
    expect(formatMessage('{n} calls', { n: 1234 }, enCtx)).toBe('1,234 calls');
    expect(formatMessage('Missing {x}', {}, enCtx)).toBe('Missing {x}');
  });

  it('selects plural branches with # and exact matches', () => {
    const msg = '{count, plural, =0 {no calls} one {# call} other {# calls}}';
    expect(formatMessage(msg, { count: 0 }, enCtx)).toBe('no calls');
    expect(formatMessage(msg, { count: 1 }, enCtx)).toBe('1 call');
    expect(formatMessage(msg, { count: 25 }, enCtx)).toBe('25 calls');
  });

  it('supports select and nesting', () => {
    const msg = '{from} ({reason, select, dnd {Do Not Disturb} other {busy}})';
    expect(formatMessage(msg, { from: 'Bob', reason: 'dnd' }, enCtx)).toBe('Bob (Do Not Disturb)');
    expect(formatMessage(msg, { from: 'Bob', reason: 'x' }, enCtx)).toBe('Bob (busy)');
    const nested = '{n, plural, one {{who} has # call} other {{who} has # calls}}';
    expect(formatMessage(nested, { n: 2, who: 'Ann' }, enCtx)).toBe('Ann has 2 calls');
  });

  it('returns malformed messages verbatim', () => {
    expect(parseMessage('broken {')).toBeNull();
    expect(formatMessage('broken {', {}, enCtx)).toBe('broken {');
    expect(formatMessage('{n, plural, one {x}}', { n: 1 }, enCtx)).toBe('{n, plural, one {x}}'); // no `other`
  });

  it('uses the locale plural rules', () => {
    const i18n = createI18n('en');
    expect(i18n.t('voicemail.new', { count: 1 })).toBe('1 new voicemail');
    expect(i18n.t('voicemail.new', { count: 3 })).toBe('3 new voicemails');
    expect(createI18n('ne').t('voicemail.new', { count: 3 })).toBe('3 नयाँ भ्वाइसमेल');
  });
});

describe('catalogues', () => {
  const enKeys = Object.keys(en).sort();

  it('every built-in locale has exactly the English keys', () => {
    expect(Object.keys(ne).sort()).toEqual(enKeys);
  });

  it('messages parse and use the same arguments as English', () => {
    for (const [key, source] of Object.entries(en)) {
      expect(parseMessage(source), `en ${key}`).not.toBeNull();
      const translated = ne[key as keyof Messages];
      expect(translated.trim(), `ne ${key} is empty`).not.toBe('');
      expect(parseMessage(translated), `ne ${key}`).not.toBeNull();
      expect(messageArguments(translated), `ne ${key} arguments`).toEqual(messageArguments(source));
    }
  });

  it('Nepali is actually translated (Devanagari) apart from technical terms', () => {
    const latinOnly = new Set([
      'call.lineShort',
      'login.websocketUrl',
      'quality.mos',
      'unit.ms',
      'unit.kbps',
      'unit.percent',
    ]);
    for (const [key, value] of Object.entries(ne)) {
      if (latinOnly.has(key)) continue;
      expect(/[ऀ-ॿ]/.test(value), `ne ${key} has no Devanagari: ${value}`).toBe(true);
    }
  });
});

describe('resolveLocale', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back ne-NP → ne → en', () => {
    const r = resolveLocale('ne-NP');
    expect(r.tag).toBe('ne-NP');
    expect(r.chain).toEqual(['ne', 'en']);
    expect(r.messages['tab.phone']).toBe('फोन');
    expect(r.dir).toBe('ltr');
    expect(r.intlLocale).toBe('ne-NP-u-nu-latn');
  });

  it('keeps an explicit numbering system (Devanagari digits)', () => {
    expect(resolveLocale('ne-NP-u-nu-deva').intlLocale).toBe('ne-NP-u-nu-deva');
    expect(createI18n('ne-NP-u-nu-deva').duration(65_000)).toBe('१:०५');
    expect(createI18n('ne').duration(65_000)).toBe('1:05');
  });

  it('uses unknown tags for formatting but English text', () => {
    const r = resolveLocale('fr-FR');
    expect(r.chain).toEqual(['en']);
    expect(r.messages['tab.phone']).toBe('Phone');
  });

  it('accepts a preference list and auto (browser languages)', () => {
    expect(resolveLocale(['xx', 'ne']).chain[0]).toBe('ne');
    vi.stubGlobal('navigator', { languages: ['de-DE', 'ne-NP'], language: 'de-DE' });
    expect(resolveLocale('auto').tag).toBe('ne-NP');
    expect(resolveLocale('AUTO').chain[0]).toBe('ne');
  });

  it('derives rtl from the language', () => {
    registerLocale({ code: 'ar', messages: { 'tab.phone': 'هاتف' } });
    const r = resolveLocale('ar-EG');
    expect(r.dir).toBe('rtl');
    expect(r.messages['tab.phone']).toBe('هاتف');
    expect(r.messages['tab.history']).toBe('History'); // partial locale falls back to English
  });

  it('registerLocale merges overrides into an existing locale', () => {
    registerLocale({ code: 'ne', messages: { 'tab.contacts': 'ग्राहक' } });
    expect(resolveLocale('ne').messages['tab.contacts']).toBe('ग्राहक');
    expect(resolveLocale('ne').messages['tab.phone']).toBe('फोन');
    registerLocale({ code: 'ne', messages: { 'tab.contacts': ne['tab.contacts'] } });
  });
});

describe('createI18n helpers', () => {
  it('applies message overrides on top of the locale', () => {
    expect(createI18n('ne', { 'tab.phone': 'डायलर' }).t('tab.phone')).toBe('डायलर');
  });

  it('formats relative days', () => {
    const now = new Date(2026, 10, 9, 12).getTime();
    const yesterday = new Date(2026, 10, 8, 9).getTime();
    expect(createI18n('en').when(yesterday, now)).toBe('Yesterday');
    expect(createI18n('ne').when(yesterday, now)).toBe('हिजो');
  });

  it('maps core error codes', () => {
    const i18n = createI18n('ne');
    expect(i18n.error(new SoftphoneError('MAX_LINES', 'Maximum lines (2) reached'))).toBe('सबै लाइनहरू व्यस्त छन्।');
    expect(createI18n('en').error(new SoftphoneError('ENGINE_ERROR', 'call failed: boom'))).toBe(
      'Something went wrong: call failed: boom',
    );
    expect(i18n.error(new Error('plain'))).toBe('plain');
  });

  it('maps end reasons and SIP failures', () => {
    expect(createI18n('ne').endReason('busy')).toBe('व्यस्त');
    expect(createI18n('en').registrationFailure('Forbidden', 403)).toBe('Wrong username or password (403)');
    expect(createI18n('en').registrationFailure('Server Internal Error', 500)).toBe('Server Internal Error (500)');
    expect(createI18n('en').registrationFailure(undefined, undefined)).toBe('Registration failed');
  });

  it('translates core notifications by code, passing others through', () => {
    const i18n = createI18n('ne');
    expect(
      i18n.notification({
        level: 'info',
        title: 'Missed call',
        message: 'Bob (Do Not Disturb)',
        code: 'missedCall',
        params: { from: 'Bob', reason: 'dnd' },
      }),
    ).toEqual({ title: 'छुटेको कल', message: 'Bob (बाधा नदिनुहोस्)' });
    expect(
      i18n.notification({ level: 'error', title: 'Registration failed', code: 'registrationFailed', params: { code: 403 } }),
    ).toEqual({ title: 'दर्ता असफल भयो', message: 'प्रयोगकर्ता नाम वा पासवर्ड मिलेन (403)' });
    expect(i18n.notification({ level: 'info', title: 'Custom', message: 'from a plugin' })).toEqual({
      title: 'Custom',
      message: 'from a plugin',
    });
  });
});

describe('pseudo-locale', () => {
  it('accents text but keeps ICU syntax intact', () => {
    expect(pseudoMessage('Call {name}')).toBe('[Çáļļ {name}]');
    const msg = pseudoMessage(en['voicemail.new']);
    expect(messageArguments(msg)).toEqual(['count']);
    expect(formatMessage(msg, { count: 2 }, enCtx)).toBe('[2 ñéŵ ṽöíçéɱáíļš]');
  });

  it('provides an RTL variant', () => {
    const def = createPseudoLocale({ rtl: true });
    registerLocale(def);
    expect(resolveLocale('ar-XB').dir).toBe('rtl');
    expect(createI18n('ar-XB').t('tab.phone')).toBe('[Þĥöñé]');
  });
});
