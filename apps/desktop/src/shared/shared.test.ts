import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';
import { DESKTOP_CATALOGUES, resolveDesktopLocale, translate } from './i18n';
import { DEFAULT_SETTINGS, localSipDomains, sanitizeSettings, serverHost, validateAccount } from './settings';
import { deriveTrayStatus, isTrayStatus } from './status';
import { isCallId, parseCallInfo } from './validate';

describe('settings', () => {
  it('falls back to defaults for garbage', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([])).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and drops invalid ones', () => {
    const s = sanitizeSettings({
      account: { server: ' wss://pbx.test:8089/ws ', extension: '1001', domain: 'pbx.test', password: 'leak' },
      engine: 'rocket',
      closeToTray: 'yes',
      notifications: { incoming: false },
      locale: 'ne',
      hotkeys: { answer: 'Alt+A', bogus: 'x' },
      extra: 1,
    });
    expect(s.account).toEqual({ server: 'wss://pbx.test:8089/ws', extension: '1001', domain: 'pbx.test', authUsername: '', displayName: '' });
    expect(JSON.stringify(s)).not.toContain('leak');
    expect(s.engine).toBe('sipjs');
    expect(s.closeToTray).toBe(true);
    expect(s.notifications).toEqual({ incoming: false, missed: true });
    expect(s.locale).toBe('ne');
    expect(s.hotkeys).toEqual({ ...DEFAULT_SETTINGS.hotkeys, answer: 'Alt+A' });
    expect('extra' in s).toBe(false);
  });

  it('merges a partial patch over the current settings', () => {
    const base = sanitizeSettings({ account: { server: 'wss://a.test/ws', extension: '1' }, closeToTray: false });
    const next = sanitizeSettings({ locale: 'en' }, base);
    expect(next.account?.server).toBe('wss://a.test/ws');
    expect(next.closeToTray).toBe(false);
    expect(next.locale).toBe('en');
    expect(sanitizeSettings({ account: null }, base).account).toBeNull();
  });

  it('validates the setup form', () => {
    expect(validateAccount({})).toEqual({ server: 'required', extension: 'required', password: 'required' });
    expect(validateAccount({ server: 'https://x', extension: '10 01', password: 'p' })).toEqual({
      server: 'invalidServer',
      extension: 'invalidExtension',
    });
    expect(validateAccount({ server: 'ws://localhost:8088/ws', extension: '1001', password: 'p' })).toEqual({});
    expect(validateAccount({ server: 'ws://pbx.test/ws', extension: '1001', password: 'p' })).toEqual({ server: 'invalidServer' });
    expect(validateAccount({ server: 'wss://pbx.test/ws', extension: '1001' }, { requirePassword: false })).toEqual({});
    expect(validateAccount({ server: 'wss://pbx.test/ws', extension: '1001', domain: 'bad domain' }, { requirePassword: false })).toEqual({
      domain: 'invalidDomain',
    });
  });

  it('derives SIP domains', () => {
    expect(serverHost('wss://pbx.test:8089/ws')).toBe('pbx.test');
    expect(serverHost('nope')).toBe('');
    expect(localSipDomains({ server: 'wss://ws.pbx.test/ws', domain: 'pbx.test', extension: '1', authUsername: '', displayName: '' })).toEqual([
      'pbx.test',
      'ws.pbx.test',
    ]);
    expect(localSipDomains(null)).toEqual([]);
  });
});

describe('tray status', () => {
  const snap = (state: string, calls: { direction: string; state: string }[] = [], dnd = false) => ({
    registration: { state },
    dnd,
    calls,
  });
  it('follows priority in call > ringing > dnd > registered > connecting > offline', () => {
    expect(deriveTrayStatus(snap('idle'))).toBe('offline');
    expect(deriveTrayStatus(snap('failed'))).toBe('offline');
    expect(deriveTrayStatus(snap('connecting'))).toBe('connecting');
    expect(deriveTrayStatus(snap('registering'))).toBe('connecting');
    expect(deriveTrayStatus(snap('registered'))).toBe('registered');
    expect(deriveTrayStatus(snap('registered', [], true))).toBe('dnd');
    expect(deriveTrayStatus(snap('registered', [{ direction: 'incoming', state: 'ringing' }], true))).toBe('ringing');
    expect(deriveTrayStatus(snap('registered', [{ direction: 'outgoing', state: 'ringing' }]))).toBe('in-call');
    expect(
      deriveTrayStatus(snap('registered', [{ direction: 'incoming', state: 'ringing' }, { direction: 'incoming', state: 'held' }])),
    ).toBe('in-call');
    expect(deriveTrayStatus(snap('registered', [{ direction: 'incoming', state: 'disconnected' }]))).toBe('registered');
  });
  it('validates status values from IPC', () => {
    expect(isTrayStatus('dnd')).toBe(true);
    expect(isTrayStatus('hacked')).toBe(false);
    expect(isTrayStatus(1)).toBe(false);
  });
});

describe('CSP', () => {
  it('is strict in production', () => {
    const csp = buildCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('connect-src \'self\' wss:');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
  it('allows the dev server and HMR socket in dev only', () => {
    const csp = buildCsp({ devServer: 'http://localhost:5173' });
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline' http:\/\/localhost:5173/);
    expect(csp).toContain('ws://localhost:5173');
  });
});

describe('desktop i18n', () => {
  it('has the same keys in every catalogue', () => {
    expect(Object.keys(DESKTOP_CATALOGUES.ne).sort()).toEqual(Object.keys(DESKTOP_CATALOGUES.en).sort());
    for (const value of Object.values(DESKTOP_CATALOGUES.ne)) expect(value.trim()).not.toBe('');
  });
  it('resolves the locale', () => {
    expect(resolveDesktopLocale('auto', 'ne-NP')).toBe('ne');
    expect(resolveDesktopLocale('auto', 'en-US')).toBe('en');
    expect(resolveDesktopLocale('en', 'ne-NP')).toBe('en');
    expect(resolveDesktopLocale('ne', 'en-US')).toBe('ne');
  });
  it('substitutes params', () => {
    expect(translate('en', 'tray.tooltip', { app: 'X', status: 'Y' })).toBe('X: Y');
    expect(translate('en', 'update.downloaded')).toContain('{version}');
  });
});

describe('IPC payload validation', () => {
  it('accepts well-formed call info and strips control characters', () => {
    expect(parseCallInfo({ callId: 'mock-1', number: '1002', displayName: 'Jane\u0007 Doe', extra: 1 })).toEqual({
      callId: 'mock-1',
      number: '1002',
      displayName: 'Jane Doe',
    });
  });
  it('rejects malformed payloads', () => {
    expect(parseCallInfo(null)).toBeNull();
    expect(parseCallInfo({ callId: 'a b', number: '1' })).toBeNull();
    expect(parseCallInfo({ callId: 'a', number: 5 })).toBeNull();
    expect(parseCallInfo({ callId: 'a', number: '  ' })).toBeNull();
    expect(isCallId('x'.repeat(129))).toBe(false);
  });
});
