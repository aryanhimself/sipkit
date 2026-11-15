import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppUrl } from './app-url';
import { CommandBus, MAX_QUEUED_COMMANDS } from './command-bus';
import { CredentialStore, memoryKeyStore, type KeyStore } from './credentials';
import { invokeNativeEngine, NATIVE_ENGINE_UNAVAILABLE, registerNativeEngineHost, setNativeEngineEmitter } from './engine-host';
import { HotkeyManager, type ShortcutRegistry } from './hotkeys';
import { callerLabel, escapeXml, incomingCallNotification, missedCallNotification } from './notification-spec';
import { circleIcon, encodePng } from './png';
import { SettingsStore } from './settings-store';
import { resolveUpdateConfig, startAutoUpdates } from './updater';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sipkit-desktop-unit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SettingsStore', () => {
  it('starts with defaults and persists sanitized updates', () => {
    const file = join(dir, 'sub', 'settings.json');
    const store = new SettingsStore(file);
    expect(store.get().account).toBeNull();
    store.update({ account: { server: 'wss://pbx.test/ws', extension: '1001' }, closeToTray: false, password: 'nope' });
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.account.extension).toBe('1001');
    expect(onDisk.closeToTray).toBe(false);
    expect(JSON.stringify(onDisk)).not.toContain('nope');
    expect(new SettingsStore(file).get().closeToTray).toBe(false);
  });

  it('recovers from a corrupt file', () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{not json');
    expect(new SettingsStore(file).get().engine).toBe('sipjs');
  });

  it('returns copies', () => {
    const store = new SettingsStore(join(dir, 's.json'));
    store.get().hotkeys.answer = 'X';
    expect(store.get().hotkeys.answer).toBe('CommandOrControl+Shift+A');
  });
});

describe('CredentialStore', () => {
  it('encrypts through the key store and never writes plain text', () => {
    const keys: KeyStore = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
      decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
    };
    const file = join(dir, 'credentials.bin');
    const store = new CredentialStore(file, keys);
    expect(store.has()).toBe(false);
    expect(store.save('hunter2')).toEqual({ stored: true });
    expect(readFileSync(file).toString()).not.toContain('hunter2');
    expect(new CredentialStore(file, keys).get()).toBe('hunter2');
    store.clear();
    expect(existsSync(file)).toBe(false);
    expect(store.get()).toBeNull();
  });

  it('keeps the password in memory only when encryption is unavailable', () => {
    const keys: KeyStore = { ...memoryKeyStore(), isEncryptionAvailable: () => false };
    const file = join(dir, 'credentials.bin');
    const store = new CredentialStore(file, keys);
    expect(store.save('pw')).toEqual({ stored: false });
    expect(existsSync(file)).toBe(false);
    expect(store.get()).toBe('pw');
    expect(store.has()).toBe(true);
    expect(new CredentialStore(file, keys).get()).toBeNull();
  });

  it('treats undecryptable data as missing and rejects bad input', () => {
    const file = join(dir, 'credentials.bin');
    writeFileSync(file, 'garbage');
    const store = new CredentialStore(file, {
      ...memoryKeyStore(),
      decryptString: () => {
        throw new Error('keychain says no');
      },
    });
    expect(store.get()).toBeNull();
    expect(() => store.save('')).toThrow();
    expect(() => store.save('x'.repeat(1000))).toThrow();
  });
});

describe('HotkeyManager', () => {
  function fakeRegistry(taken: string[] = []) {
    const registered = new Map<string, () => void>();
    const registry: ShortcutRegistry = {
      register: (acc, cb) => {
        if (taken.includes(acc)) return false;
        registered.set(acc, cb);
        return true;
      },
      unregister: (acc) => void registered.delete(acc),
    };
    return { registry, registered };
  }

  it('registers bindings and routes presses to the action', () => {
    const { registry, registered } = fakeRegistry();
    const onAction = vi.fn();
    const manager = new HotkeyManager(registry, onAction);
    const result = manager.apply({ answer: 'ctrl+shift+a', hangup: 'Ctrl+Shift+H' });
    expect(result.registered.map((r) => r.accelerator)).toEqual(['Control+Shift+A', 'Control+Shift+H']);
    registered.get('Control+Shift+A')!();
    expect(onAction).toHaveBeenCalledWith('answer');
    manager.trigger('hangup');
    expect(onAction).toHaveBeenLastCalledWith('hangup');
  });

  it('reports shortcuts owned by other apps and re-applies cleanly', () => {
    const { registry, registered } = fakeRegistry(['Control+Shift+A']);
    const manager = new HotkeyManager(registry, () => {});
    const result = manager.apply({ answer: 'Ctrl+Shift+A', hangup: 'Ctrl+Shift+H', toggleMute: 'M' });
    expect(result.problems).toEqual([
      { action: 'toggleMute', accelerator: 'M', error: 'needsModifier' },
      { action: 'answer', accelerator: 'Control+Shift+A', error: 'unavailable' },
    ]);
    expect([...registered.keys()]).toEqual(['Control+Shift+H']);
    manager.apply({ hangup: 'Alt+H' });
    expect([...registered.keys()]).toEqual(['Alt+H']);
    manager.clear();
    expect(registered.size).toBe(0);
  });
});

describe('CommandBus', () => {
  it('queues until ready, keeps only the latest dial, then delivers directly', () => {
    const delivered: unknown[] = [];
    const bus = new CommandBus((c) => delivered.push(c));
    bus.send({ type: 'dial', target: '1', source: 'url' });
    bus.send({ type: 'answer' });
    bus.send({ type: 'dial', target: '2', source: 'url' });
    expect(delivered).toEqual([]);
    bus.ready();
    expect(delivered).toEqual([{ type: 'answer' }, { type: 'dial', target: '2', source: 'url' }]);
    bus.send({ type: 'hangup' });
    expect(delivered).toHaveLength(3);
    bus.reset();
    bus.send({ type: 'toggleDnd' });
    expect(delivered).toHaveLength(3);
    expect(bus.pending).toEqual([{ type: 'toggleDnd' }]);
  });

  it('bounds the queue', () => {
    const bus = new CommandBus(() => {});
    for (let i = 0; i < MAX_QUEUED_COMMANDS + 5; i++) bus.send({ type: 'toggleMute' });
    expect(bus.pending).toHaveLength(MAX_QUEUED_COMMANDS);
  });
});

describe('notification specs', () => {
  const strings = { incomingTitle: 'Incoming call', missedTitle: 'Missed call', answer: 'Answer', decline: 'Decline' };
  const call = { callId: 'mock-1', number: '5550100', displayName: 'Jane <Boss> & Co' };

  it('macOS: Answer action, close button declines', () => {
    const spec = incomingCallNotification('darwin', call, strings);
    expect(spec.options.actions).toEqual([{ type: 'button', text: 'Answer' }]);
    expect(spec.options.closeButtonText).toBe('Decline');
    expect(spec.answerActionIndex).toBe(0);
    expect(spec.closeMeansDecline).toBe(true);
    expect(spec.options.silent).toBe(true);
  });

  it('Windows: toast buttons activate app URLs with escaped text', () => {
    const spec = incomingCallNotification('win32', call, strings);
    const xml = spec.options.toastXml!;
    expect(xml).toContain('arguments="sipkit://answer?call=mock-1"');
    expect(xml).toContain('arguments="sipkit://decline?call=mock-1"');
    expect(xml).toContain('Jane &lt;Boss&gt; &amp; Co (5550100)');
    expect(xml).not.toContain('<Boss>');
    expect(spec.closeMeansDecline).toBe(false);
  });

  it('Linux: plain notification', () => {
    const spec = incomingCallNotification('linux', call, strings);
    expect(spec.options.actions).toBeUndefined();
    expect(spec.options.toastXml).toBeUndefined();
  });

  it('missed calls and labels', () => {
    expect(missedCallNotification({ callId: 'x', number: '1002' }, strings)).toMatchObject({ title: 'Missed call', body: '1002' });
    expect(callerLabel({ callId: 'x', number: '1002', displayName: '1002' })).toBe('1002');
    expect(escapeXml(`"'`)).toBe('&quot;&apos;');
  });
});

describe('updater config', () => {
  it('is off in dev and tests', () => {
    expect(resolveUpdateConfig({ isPackaged: false, hasBuildFeed: true, env: { SIPKIT_UPDATE_URL: 'https://u.test' } })).toMatchObject({ enabled: false, reason: 'dev' });
    expect(resolveUpdateConfig({ isPackaged: true, hasBuildFeed: true, env: { SIPKIT_DESKTOP_TEST: '1' } })).toMatchObject({ enabled: false, reason: 'test' });
    expect(resolveUpdateConfig({ isPackaged: true, hasBuildFeed: true, env: { SIPKIT_UPDATE_DISABLED: '1' } })).toMatchObject({ enabled: false });
  });

  it('uses the build-time feed unless overridden, and requires https', () => {
    expect(resolveUpdateConfig({ isPackaged: true, hasBuildFeed: true, env: {} })).toEqual({ enabled: true, feedUrl: null });
    expect(resolveUpdateConfig({ isPackaged: true, hasBuildFeed: false, env: {} })).toMatchObject({ enabled: false, reason: 'noFeed' });
    expect(resolveUpdateConfig({ isPackaged: true, hasBuildFeed: false, env: { SIPKIT_UPDATE_URL: 'https://updates.example.com/desktop/' } })).toEqual({
      enabled: true,
      feedUrl: 'https://updates.example.com/desktop/',
    });
    expect(resolveUpdateConfig({ isPackaged: true, hasBuildFeed: false, env: { SIPKIT_UPDATE_URL: 'http://evil.test/' } })).toMatchObject({
      enabled: false,
      reason: 'invalidUrl',
    });
    expect(resolveUpdateConfig({ isPackaged: true, hasBuildFeed: false, env: { SIPKIT_UPDATE_URL: 'http://localhost:8080/' } }).enabled).toBe(true);
  });

  it('does not load electron-updater when disabled', async () => {
    const states: unknown[] = [];
    const handle = await startAutoUpdates({ enabled: false, feedUrl: null, reason: 'dev' }, (s) => states.push(s));
    expect(states).toEqual([{ state: 'disabled' }]);
    handle.stop();
  });
});

describe('native engine host (V2-DESK-02 extension point)', () => {
  afterEach(() => registerNativeEngineHost(null));

  it('rejects until a host is registered, then forwards calls and events', async () => {
    await expect(invokeNativeEngine('register', [])).rejects.toThrow(NATIVE_ENGINE_UNAVAILABLE);
    const events: unknown[] = [];
    setNativeEngineEmitter((e) => events.push(e));
    registerNativeEngineHost({
      invoke: async (method, args) => ({ method, args }),
      attach: (emit) => emit({ listener: 'onRegistration', args: [{ state: 'registered' }] }),
    });
    await expect(invokeNativeEngine('call', ['1002'])).resolves.toEqual({ method: 'call', args: ['1002'] });
    expect(events).toEqual([{ listener: 'onRegistration', args: [{ state: 'registered' }] }]);
  });

  it('validates method names and arguments', async () => {
    registerNativeEngineHost({ invoke: async () => null, attach: () => {} });
    await expect(invokeNativeEngine('__proto__', [])).rejects.toThrow('Invalid engine method');
    await expect(invokeNativeEngine('call', 'x')).rejects.toThrow('Invalid engine arguments');
  });
});

describe('isAppUrl', () => {
  it('accepts only the app page or the dev server origin', () => {
    expect(isAppUrl('file:///Applications/X.app/Contents/Resources/app.asar/dist/renderer/index.html', undefined)).toBe(true);
    expect(isAppUrl('file:///etc/passwd', undefined)).toBe(false);
    expect(isAppUrl('https://evil.test/renderer/index.html', undefined)).toBe(false);
    expect(isAppUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
    expect(isAppUrl('http://localhost:5173.evil.test/', 'http://localhost:5173')).toBe(false);
    expect(isAppUrl('', undefined)).toBe(false);
  });
});

describe('png', () => {
  it('encodes a valid RGBA PNG', () => {
    const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect([...raw]).toEqual([0, 255, 0, 0, 255, 0, 0, 255, 128]);
  });

  it('draws a status icon', () => {
    const icon = circleIcon(32, [30, 41, 59], [22, 163, 74]);
    expect(icon.length).toBeGreaterThan(100);
  });
});
