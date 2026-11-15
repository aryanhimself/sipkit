import { describe, expect, it } from 'vitest';
import { ConfigError, hasCredentials, isFeatureEnabled, resolveConfig } from './config';

describe('resolveConfig', () => {
  it('applies defaults', () => {
    const cfg = resolveConfig();
    expect(cfg).toMatchObject({
      transportMode: 'webrtc',
      maxLines: 2,
      dtmfMode: 'auto',
      registerExpires: 300,
      autoRegister: true,
      ringTimeout: 90,
      extraHeaders: [],
    });
    expect(cfg.iceServers.length).toBeGreaterThan(0);
  });

  it('derives the domain from the first websocket URL', () => {
    expect(resolveConfig({ websocketUrls: ['wss://pbx.example.com:8089/ws'] }).domain).toBe('pbx.example.com');
    expect(resolveConfig({ domain: 'sip.example.com', websocketUrls: ['wss://a.test/ws'] }).domain).toBe('sip.example.com');
  });

  it('rejects invalid values with readable issues', () => {
    try {
      resolveConfig({ maxLines: 0, websocketUrls: ['nope'], registerExpires: 5 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const e = error as ConfigError;
      expect(e.issues.length).toBe(3);
      expect(e.message).toMatch(/maxLines/);
      expect(e.message).toMatch(/websocketUrls\.0/);
    }
  });

  it('hasCredentials requires username, url and domain', () => {
    expect(hasCredentials(resolveConfig({}))).toBe(false);
    expect(hasCredentials(resolveConfig({ username: '1001' }))).toBe(false);
    expect(hasCredentials(resolveConfig({ username: '1001', websocketUrls: ['wss://a.test/ws'] }))).toBe(true);
  });

  it('native mode needs sipServer instead of a WebSocket URL and derives the domain from it', () => {
    const native = resolveConfig({ username: '2001', transportMode: 'native', sipServer: 'pbx.test:5060' });
    expect(native.domain).toBe('pbx.test');
    expect(hasCredentials(native)).toBe(true);
    expect(hasCredentials(resolveConfig({ username: '2001', transportMode: 'native' }))).toBe(false);
    expect(resolveConfig({ transportMode: 'native', sipServer: 'sip:10.0.0.1;transport=tls' }).domain).toBe('10.0.0.1');
    // Other modes ignore sipServer for the domain (gateway mode still needs a WebSocket URL).
    expect(hasCredentials(resolveConfig({ username: '1001', sipServer: 'pbx.test' }))).toBe(false);
  });

  it('isFeatureEnabled is case-insensitive', () => {
    const cfg = resolveConfig({ disabledFeatures: ['Contacts'] });
    expect(isFeatureEnabled(cfg, 'contacts')).toBe(false);
    expect(isFeatureEnabled(cfg, 'history')).toBe(true);
  });
});
