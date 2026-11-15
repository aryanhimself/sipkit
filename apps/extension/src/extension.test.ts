import { describe, expect, it, vi } from 'vitest';
import { RemoteSoftphone } from 'sipkit-core/remote';
import { isDialLink, normalizePhoneNumber, parseDialLink, parsePhoneFromText } from './shared/phone';
import {
  buildConfig,
  isAllowedUrl,
  isConfigured,
  isValidMatchPattern,
  matchesPattern,
  originOf,
  sanitizeSecrets,
  sanitizeSettings,
} from './shared/settings';
import { badgeFor, isMissed } from './background/controller';
import { RuntimePortTransport, type HostSummary } from './shared/ext';
import { createExtensionHost, summarize } from './host/host';

// chrome.i18n.getMessage stub: return the key so badge texts are predictable.
vi.stubGlobal('chrome', { i18n: { getMessage: (k: string) => k, getUILanguage: () => 'en' } });

describe('phone numbers', () => {
  it('parses dial links', () => {
    expect(parseDialLink('tel:+1-555-0100')).toBe('+15550100');
    expect(parseDialLink('tel:+1%20555%200100;ext=12')).toBe('+15550100');
    expect(parseDialLink('callto://5550199')).toBe('5550199');
    expect(parseDialLink('callto:5550199')).toBe('5550199');
    expect(parseDialLink('sip:1002@pbx.example.com')).toBe('sip:1002@pbx.example.com');
    expect(parseDialLink('sips:alice@pbx.example.com:5061;transport=tls')).toBe('sips:alice@pbx.example.com:5061');
    expect(parseDialLink('sip:1002')).toBe('1002');
    expect(parseDialLink('tel:javascript:alert(1)')).toBeNull();
    expect(parseDialLink('sip:<script>@x')).toBeNull();
    expect(parseDialLink('https://example.com')).toBeNull();
    expect(isDialLink(' TEL:123')).toBe(true);
    expect(isDialLink('mailto:a@b')).toBe(false);
  });

  it('normalises and finds numbers in text', () => {
    expect(normalizePhoneNumber('(01) 555-0100')).toBe('015550100');
    expect(normalizePhoneNumber('*97')).toBe('*97');
    expect(normalizePhoneNumber('1')).toBe('');
    expect(normalizePhoneNumber('call me')).toBe('');
    expect(parsePhoneFromText('Call 98 4100 0000 today')).toBe('9841000000');
    expect(parsePhoneFromText('+977-1-4411111')).toBe('+97714411111');
    expect(parsePhoneFromText('no digits here')).toBeNull();
    expect(parsePhoneFromText('tel:+15550100')).toBe('+15550100');
  });
});

describe('settings', () => {
  it('match patterns behave like the browser (ports ignored unless named)', () => {
    expect(matchesPattern('http://localhost:5197/?instance=shared', 'http://localhost/*')).toBe(true);
    expect(matchesPattern('https://crm.example.com/app', 'https://*.example.com/*')).toBe(true);
    expect(matchesPattern('https://example.com/', 'https://*.example.com/*')).toBe(true);
    expect(matchesPattern('https://evil-example.com/', 'https://*.example.com/*')).toBe(false);
    expect(matchesPattern('http://crm.example.com/', 'https://crm.example.com/*')).toBe(false);
    expect(matchesPattern('https://crm.example.com/admin', 'https://crm.example.com/app/*')).toBe(false);
    expect(matchesPattern('https://crm.example.com:8443/', 'https://crm.example.com:8443/*')).toBe(true);
    expect(matchesPattern('https://crm.example.com:9443/', 'https://crm.example.com:8443/*')).toBe(false);
    expect(matchesPattern('file:///etc/passwd', '<all_urls>')).toBe(false);
    expect(isValidMatchPattern('https://crm.example.com/*')).toBe(true);
    expect(isValidMatchPattern('crm.example.com')).toBe(false);
    expect(isAllowedUrl(undefined, ['<all_urls>'])).toBe(false);
    expect(originOf('https://crm.example.com/x?y')).toBe('https://crm.example.com');
    expect(originOf('chrome-extension://abc/popup.html')).toBe('');
  });

  it('sanitises stored settings and keeps secrets out of them', () => {
    const s = sanitizeSettings({
      engine: 'evil',
      account: { websocketUrls: ['wss://pbx/ws', 'javascript:x'], username: '1001', password: 'leak' },
      allowedOrigins: ['https://crm.example.com/*', 'not a pattern'],
      approvedOrigins: ['https://crm.example.com', 'https://crm.example.com/path'],
      softphoneUrl: 'javascript:alert(1)',
    });
    expect(s.engine).toBe('sipjs');
    expect(s.account.websocketUrls).toEqual(['wss://pbx/ws']);
    expect(JSON.stringify(s)).not.toContain('leak');
    expect(s.allowedOrigins).toEqual(['https://crm.example.com/*']);
    expect(s.approvedOrigins).toEqual(['https://crm.example.com']);
    expect(s.softphoneUrl).toBe('');
    const secrets = sanitizeSecrets({ password: 'pw', registerHeaders: ['Authorization: Bearer t', 5] });
    expect(secrets).toEqual({ password: 'pw', registerHeaders: ['Authorization: Bearer t'] });
    const cfg = buildConfig(s, secrets);
    expect(cfg.password).toBe('pw');
    expect(cfg.instance).toEqual({ mode: 'local' });
    expect(isConfigured(s, secrets)).toBe(true);
    expect(isConfigured(s, sanitizeSecrets({}))).toBe(false);
  });
});

describe('badge and missed calls', () => {
  const base: HostSummary = { configured: true, registration: 'registered', dnd: false, calls: [] };
  const call = (over: Partial<HostSummary['calls'][number]>) => ({
    id: 'c1',
    state: 'ringing',
    direction: 'incoming' as const,
    remoteNumber: '1002',
    ...over,
  });

  it('picks ringing > in call > offline > missed > dnd', () => {
    expect(badgeFor(null, 0).text).toBe('');
    expect(badgeFor({ ...base, configured: false }, 3).text).toBe('');
    expect(badgeFor({ ...base, calls: [call({})] }, 2).text).toBe('badgeRinging');
    expect(badgeFor({ ...base, calls: [call({ state: 'connected' })] }, 2).text).toBe('badgeInCall');
    expect(badgeFor({ ...base, calls: [call({ direction: 'outgoing', state: 'ringing' })] }, 0).text).toBe('badgeInCall');
    expect(badgeFor({ ...base, registration: 'failed' }, 2).text).toBe('badgeOffline');
    expect(badgeFor(base, 3).text).toBe('3');
    expect(badgeFor(base, 150).text).toBe('99+');
    expect(badgeFor({ ...base, dnd: true }, 0).text).toBe('badgeDnd');
    expect(badgeFor(base, 0).text).toBe('');
  });

  it('counts unanswered incoming calls as missed, not declined ones', () => {
    const cdr = { callId: 'c', line: 1, direction: 'incoming' as const, caller: '1002', called: '1001', startedAt: 0, endedAt: 1, durationMs: 0 };
    expect(isMissed({ ...cdr, reason: 'cancelled' })).toBe(true);
    expect(isMissed({ ...cdr, reason: 'dnd' })).toBe(true);
    expect(isMissed({ ...cdr, reason: 'rejected' })).toBe(false);
    expect(isMissed({ ...cdr, reason: 'remote-hangup', connectedAt: 1, durationMs: 5 })).toBe(false);
    expect(isMissed({ ...cdr, direction: 'outgoing', reason: 'no-answer' })).toBe(false);
  });
});

/** In-memory chrome.runtime.Port pair. */
function portPair(): [chrome.runtime.Port, chrome.runtime.Port] {
  const make = () => {
    const msgL = new Set<(m: unknown) => void>();
    const discL = new Set<() => void>();
    const port = {
      name: 'sipkit-client',
      peer: null as unknown as { msgL: Set<(m: unknown) => void>; discL: Set<() => void> },
      msgL,
      discL,
      postMessage(m: unknown) {
        const copy = JSON.parse(JSON.stringify(m)) as unknown;
        queueMicrotask(() => port.peer.msgL.forEach((l) => l(copy)));
      },
      disconnect() {
        queueMicrotask(() => port.peer.discL.forEach((l) => l()));
      },
      onMessage: { addListener: (l: (m: unknown) => void) => msgL.add(l) },
      onDisconnect: { addListener: (l: () => void) => discL.add(l) },
    };
    return port;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a as unknown as chrome.runtime.Port, b as unknown as chrome.runtime.Port];
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('extension host (mock engine)', () => {
  it('serves clients over runtime ports, reports summaries and routes provisioning', async () => {
    const summaries: HostSummary[] = [];
    const provision = vi.fn(async () => undefined);
    const host = createExtensionHost({ provision, onSummary: (s) => summaries.push(s), onCdr: () => undefined }, { version: '1.2.3' });
    await host.configure(
      { engine: 'mock', account: { username: '1001', websocketUrls: [] }, allowedOrigins: ['http://localhost/*'] },
      { password: 'secret' },
    );
    await until(() => summaries.at(-1)?.registration === 'registered');

    const [clientPort, hostPort] = portPair();
    host.attach(hostPort, 'http://localhost:5197', false);
    const remote = new RemoteSoftphone();
    await remote.connect(new RuntimePortTransport(clientPort));
    expect(remote.host).toMatchObject({ kind: 'extension', version: '1.2.3', debug: ['simulateIncomingCall', 'simulateRemoteHangup'] });
    expect(remote.getSnapshot().registration.state).toBe('registered');
    expect(JSON.stringify(remote.config)).not.toContain('secret');

    await remote.debug('simulateIncomingCall', '5550100', 'Jane');
    await until(() => summaries.at(-1)?.calls.length === 1);
    expect(summaries.at(-1)?.calls[0]).toMatchObject({ direction: 'incoming', remoteNumber: '5550100' });
    await host.command('answer', [remote.getSnapshot().calls[0]!.id]);
    await until(() => remote.getSnapshot().calls[0]?.state === 'connected');
    await expect(host.command('updateConfig', [{}])).rejects.toThrow(/refused/);

    await remote.updateConfig({ username: '1002', password: 'x', techPrefix: '9' });
    expect(provision).toHaveBeenCalledWith('http://localhost:5197', false, { username: '1002', password: 'x' });
    remote.disconnect();
  });

  it('summarize drops ended calls', () => {
    const s = summarize(
      {
        app: 'started',
        registration: { state: 'registered' },
        calls: [
          { id: 'a', state: 'connected', direction: 'outgoing', remoteNumber: '1' } as never,
          { id: 'b', state: 'disconnected', direction: 'incoming', remoteNumber: '2' } as never,
        ],
        activeCallId: 'a',
        devices: { available: [], selected: {} },
        engine: 'x',
        voicemail: {} as never,
        dnd: true,
        presence: {},
        chat: {} as never,
      },
      true,
    );
    expect(s.calls.map((c) => c.id)).toEqual(['a']);
    expect(s.dnd).toBe(true);
  });
});
