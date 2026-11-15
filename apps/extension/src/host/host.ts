/**
 * The one softphone instance of the browser. Runs in the Chrome offscreen
 * document or the Firefox background page and serves every client (pages
 * through the content-script relay, the popup) over runtime ports.
 */
import {
  callHistoryPlugin,
  createSoftphone,
  ringtonePlugin,
  type Cdr,
  type SoftphoneApi,
  type SoftphoneConfigInput,
  type SoftphoneSnapshot,
} from 'sipkit-core';
import {
  createCdrLog,
  serveSoftphone,
  validateCommand,
  type CdrLog,
  type RemoteHostSession,
} from 'sipkit-core/remote';
import { MockSoftphone } from 'sipkit-react/testing';
import { RuntimePortTransport, type HostSummary } from '../shared/ext';
import { buildConfig, isConfigured, sanitizeSecrets, sanitizeSettings, type Secrets, type Settings } from '../shared/settings';

/** Mock helpers clients may call when the mock engine runs (dev / e2e). */
export const MOCK_DEBUG = ['simulateIncomingCall', 'simulateRemoteHangup'];

export interface HostLink {
  /** A client asked to provision credentials; resolves once stored and applied, rejects when refused. */
  provision(origin: string, trusted: boolean, patch: SoftphoneConfigInput): Promise<void>;
  onSummary(summary: HostSummary): void;
  onCdr(cdr: Cdr): void;
}

export interface ExtensionHost {
  configure(settings: unknown, secrets: unknown): Promise<void>;
  /** Serve a connected client. `origin` is the browser-reported sender origin. */
  attach(port: chrome.runtime.Port, origin: string, trusted: boolean): void;
  command(name: string, args: unknown[]): Promise<unknown>;
  debug(method: string, args: unknown[]): Promise<unknown>;
  readonly settings: Settings;
  readonly api: SoftphoneApi | null;
}

export function summarize(snapshot: SoftphoneSnapshot, configured: boolean): HostSummary {
  return {
    configured,
    registration: snapshot.registration.state,
    dnd: snapshot.dnd,
    calls: snapshot.calls
      .filter((c) => c.state !== 'disconnected')
      .map((c) => ({
        id: c.id,
        state: c.state,
        direction: c.direction,
        remoteNumber: c.remoteNumber,
        remoteDisplayName: c.remoteDisplayName,
        connectedAt: c.connectedAt,
      })),
  };
}

export function createExtensionHost(link: HostLink, options: { version: string }): ExtensionHost {
  let settings: Settings = sanitizeSettings(undefined);
  let secrets: Secrets = sanitizeSecrets(undefined);
  let api: SoftphoneApi | null = null;
  let engine: Settings['engine'] | null = null;
  let appliedConfig = '';
  let cdrLog: CdrLog | null = null;
  let offs: (() => void)[] = [];
  let lastSummary = '';
  const sessions = new Set<RemoteHostSession>();
  let queue: Promise<void> = Promise.resolve();

  function emitSummary(): void {
    if (!api) return;
    const summary = summarize(api.getSnapshot(), isConfigured(settings, secrets));
    const key = JSON.stringify(summary);
    if (key === lastSummary) return;
    lastSummary = key;
    link.onSummary(summary);
  }

  async function destroyInstance(): Promise<void> {
    for (const s of [...sessions]) s.dispose('instance-replaced');
    sessions.clear();
    offs.forEach((off) => off());
    offs = [];
    cdrLog?.dispose();
    cdrLog = null;
    const old = api as (SoftphoneApi & { destroy?: () => Promise<void> }) | null;
    api = null;
    if (old) await (old.destroy ? old.destroy() : old.stop()).catch(() => undefined);
  }

  async function createInstance(config: SoftphoneConfigInput): Promise<void> {
    const instance: SoftphoneApi =
      settings.engine === 'mock'
        ? new MockSoftphone(config, { plugins: [callHistoryPlugin()], engineName: 'mock-engine' })
        : createSoftphone({ config, plugins: [callHistoryPlugin(), ringtonePlugin()] });
    api = instance;
    engine = settings.engine;
    cdrLog = createCdrLog(instance);
    offs.push(
      instance.subscribe(() => emitSummary()),
      instance.on('cdr', (cdr) => link.onCdr(JSON.parse(JSON.stringify(cdr)) as Cdr)),
    );
    await instance.start().catch(() => undefined);
    emitSummary();
  }

  async function apply(): Promise<void> {
    const config = buildConfig(settings, secrets);
    const key = JSON.stringify(config);
    if (!api || engine !== settings.engine) {
      await destroyInstance();
      appliedConfig = key;
      await createInstance(config);
      return;
    }
    if (key === appliedConfig) return emitSummary();
    appliedConfig = key;
    await api.updateConfig(config).catch(() => undefined);
    const state = api.getSnapshot().registration.state;
    if (isConfigured(settings, secrets) && state !== 'registered' && state !== 'registering') await api.register().catch(() => undefined);
    lastSummary = '';
    emitSummary();
  }

  const host: ExtensionHost = {
    get settings() {
      return settings;
    },
    get api() {
      return api;
    },
    configure(rawSettings, rawSecrets) {
      settings = sanitizeSettings(rawSettings);
      secrets = sanitizeSecrets(rawSecrets);
      queue = queue.then(apply, apply);
      return queue;
    },
    attach(port, origin, trusted) {
      const instance = api;
      if (!instance) {
        port.disconnect();
        return;
      }
      const transport = new RuntimePortTransport(port);
      const session = serveSoftphone(instance, transport, {
        host: {
          kind: 'extension',
          engine: instance.getSnapshot().engine,
          version: options.version,
          debug: settings.engine === 'mock' ? MOCK_DEBUG : undefined,
        },
        cdrLog: cdrLog ?? undefined,
        onUpdateConfig: (patch) => link.provision(origin, trusted, patch),
        onClose: () => sessions.delete(session),
      });
      sessions.add(session);
    },
    async command(name, args) {
      if (!api) throw new Error('Softphone not running');
      if (!validateCommand(name, args) || name === 'updateConfig' || name === 'debug') throw new Error('Command refused');
      const fn = (api as unknown as Record<string, unknown>)[name];
      if (typeof fn !== 'function') throw new Error(`${name} not supported`);
      return (fn as (...a: unknown[]) => unknown).apply(api, args);
    },
    async debug(method, args) {
      if (!api || settings.engine !== 'mock' || !MOCK_DEBUG.includes(method)) throw new Error('debug not available');
      const fn = (api as unknown as Record<string, unknown>)[method] as (...a: unknown[]) => unknown;
      return fn.apply(api, args);
    },
  };
  return host;
}
