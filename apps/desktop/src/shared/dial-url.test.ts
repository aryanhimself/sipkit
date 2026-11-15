import { describe, expect, it } from 'vitest';
import { findAppUrlInArgv, normalizePhoneNumber, parseAppUrl } from './dial-url';

const dial = (target: string, scheme: string) => ({ kind: 'dial', target, scheme });

describe('parseAppUrl: tel', () => {
  it.each([
    ['tel:+1-555-123-4567', '+15551234567'],
    ['tel:+1 (555) 123.4567', '+15551234567'],
    ['TEL:1002', '1002'],
    ['tel:%2B977%201%204412345', '+97714412345'],
    ['tel:1002;phone-context=example.com', '1002'],
    ['tel://5550100', '5550100'],
    ['tel:*97', '*97'],
    ['tel:#31#1002', '#31#1002'],
  ])('%s → %s', (url, target) => {
    expect(parseAppUrl(url)).toEqual(dial(target, 'tel'));
  });

  it.each(['tel:', 'tel:abc', 'tel:+', 'tel:%E0%A4%A', 'tel:1002<script>', `tel:${'1'.repeat(40)}`])(
    'rejects %s',
    (url) => {
      expect(parseAppUrl(url)).toBeNull();
    },
  );
});

describe('parseAppUrl: sip / sips', () => {
  it('dials the user part on the local PBX', () => {
    expect(parseAppUrl('sip:1002@pbx.example.com', { localDomains: ['pbx.example.com'] })).toEqual(dial('1002', 'sip'));
    expect(parseAppUrl('sip:1002@PBX.example.com:5060;transport=udp', { localDomains: ['pbx.example.com'] })).toEqual(
      dial('1002', 'sip'),
    );
  });

  it('keeps the full URI for other domains', () => {
    expect(parseAppUrl('sip:alice@other.example.org')).toEqual(dial('sip:alice@other.example.org', 'sip'));
    expect(parseAppUrl('sips:bob@secure.example.org?subject=hi')).toEqual(dial('sips:bob@secure.example.org', 'sips'));
  });

  it('accepts a bare user and strips passwords', () => {
    expect(parseAppUrl('sip:1003')).toEqual(dial('1003', 'sip'));
    expect(parseAppUrl('sip:alice:hunter2@other.example.org')).toEqual(dial('sip:alice@other.example.org', 'sip'));
  });

  it('rejects malformed hosts and users', () => {
    expect(parseAppUrl('sip:1002@bad host')).toBeNull();
    expect(parseAppUrl('sip:@pbx')).toBeNull();
    expect(parseAppUrl('sip:a b@pbx')).toBeNull();
  });
});

describe('parseAppUrl: callto', () => {
  it.each([
    ['callto:1002', '1002'],
    ['callto://+15551234567', '+15551234567'],
    ['callto://+1 555 123 4567/', '+15551234567'],
  ])('%s → %s', (url, target) => {
    expect(parseAppUrl(url)).toEqual(dial(target, 'callto'));
  });

  it('handles callto with a SIP address', () => {
    expect(parseAppUrl('callto:1002@pbx.test', { localDomains: ['pbx.test'] })).toEqual(dial('1002', 'callto'));
  });
});

describe('parseAppUrl: sipkit actions', () => {
  it('answer / decline with a call id', () => {
    expect(parseAppUrl('sipkit://answer?call=mock-3')).toEqual({ kind: 'action', action: 'answer', callId: 'mock-3' });
    expect(parseAppUrl('sipkit://decline?call=abc')).toEqual({ kind: 'action', action: 'decline', callId: 'abc' });
    expect(parseAppUrl('sipkit://answer')).toEqual({ kind: 'action', action: 'answer' });
  });

  it('show, dial, unknown', () => {
    expect(parseAppUrl('sipkit://show')).toEqual({ kind: 'action', action: 'show' });
    expect(parseAppUrl('sipkit://dial?number=1002')).toEqual(dial('1002', 'sipkit'));
    expect(parseAppUrl('sipkit://format-disk')).toBeNull();
    expect(parseAppUrl('sipkit://answer?call=../../etc')).toBeNull();
  });
});

describe('parseAppUrl: other input', () => {
  it.each(['', 'https://example.com', 'javascript:alert(1)', 'mailto:a@b.c', '1002', 'file:///etc/passwd'])('ignores %s', (url) => {
    expect(parseAppUrl(url)).toBeNull();
  });

  it('ignores non-strings', () => {
    expect(parseAppUrl(undefined as unknown as string)).toBeNull();
  });
});

describe('findAppUrlInArgv', () => {
  it('finds the URL among flags and paths (Windows second-instance argv)', () => {
    const argv = ['C:\\Program Files\\SipKit\\SipKit.exe', '--allow-file-access-from-files', 'tel:1002'];
    expect(findAppUrlInArgv(argv)).toEqual(dial('1002', 'tel'));
  });

  it('returns null when there is none', () => {
    expect(findAppUrlInArgv(['/usr/bin/app', '.', '--hidden'])).toBeNull();
  });

  it('skips arguments that look like flags even if they contain a scheme', () => {
    expect(findAppUrlInArgv(['--url=tel:1002'])).toBeNull();
  });
});

describe('normalizePhoneNumber', () => {
  it('keeps + * # and digits only', () => {
    expect(normalizePhoneNumber(' +977 (1) 441-2345 ')).toBe('+97714412345');
    expect(normalizePhoneNumber('1+2')).toBeNull();
  });
});
