/**
 * One softphone per browser (docs/shared-instance.md):
 *
 * 1. Extension host: the sipkit browser extension runs the instance; this
 *    page is a remote client (`instance.preferExtension`).
 * 2. Web host: same-origin tabs elect a leader with the Web Locks API. The
 *    leader runs the real instance; other tabs are remote clients over
 *    BroadcastChannel. When the leader closes or reloads, the lock passes
 *    to another tab, which creates the instance (calling `resume()` when the
 *    instance has one) and the clients reattach.
 * 3. Plain local instance: `instance.mode: 'local'`, or no Web Locks /
 *    BroadcastChannel.
 */
import { resolveConfig, type ResolvedConfig, type SoftphoneConfigInput } from '../config';
import type { SoftphoneApi, Unsubscribe } from '../types';
import {
  BroadcastClientTransport,
  BroadcastLeaderTransport,
  isWebFrame,
  webFrame,
  type ChannelLike,
} from './broadcast';
import { connectExtension } from './extension-client';
import { createCdrLog, serveSoftphone, type CdrLog, type RemoteHostSession } from './host';
import { parseClientMessage, pickProvisioning, type RemoteHostInfo } from './protocol';
import { RemoteSoftphone } from './remote-softphone';
import { createLoopbackPair } from './transport';

/** Which host the shared softphone currently uses. */
export type SharedRole = 'extension' | 'leader' | 'client' | 'local';

/** Optional restore step a local instance may offer (reload continuity, see docs/shared-instance.md). */
export interface ResumableSoftphone extends SoftphoneApi {
  resume?(): Promise<void>;
}

export interface LocksLike {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>;
}

export interface CreateSharedSoftphoneOptions {
  config: SoftphoneConfigInput;
  /** Creates the real instance when this tab must host it (e.g. `(c) => createSoftphone({ config: c, plugins })`). */
  createLocal: (config: SoftphoneConfigInput) => SoftphoneApi | Promise<SoftphoneApi>;
  /** Debug helpers (mock engine) clients may call on the leader through `debug()`. */
  debugMethods?: string[];
  /** Overrides for tests / non-window environments. */
  env?: {
    window?: Window;
    locks?: LocksLike | null;
    createChannel?: ((name: string) => ChannelLike) | null;
  };
  /** Called whenever the role changes (also once with the first role). */
  onRoleChange?: (role: SharedRole) => void;
}

/** What `createSharedSoftphone` returns in shared mode: a remote client that can also lead. */
export interface SharedSoftphone extends RemoteSoftphone {
  readonly role: SharedRole;
  /** Number of local instances this tab created (tests: only one tab per browser should create one). */
  readonly instancesCreated: number;
  onRoleChange(listener: (role: SharedRole) => void): Unsubscribe;
  destroy(): Promise<void>;
}

function randomId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * Create the softphone for this page according to `config.instance`.
 * Mode 'local' (default) simply returns `createLocal(config)`.
 */
export async function createSharedSoftphone(options: CreateSharedSoftphoneOptions): Promise<SoftphoneApi | SharedSoftphone> {
  let cfg: ResolvedConfig;
  try {
    cfg = resolveConfig(options.config);
  } catch {
    return options.createLocal(options.config);
  }
  if (cfg.instance.mode !== 'shared') return options.createLocal(options.config);

  const win = options.env?.window ?? (typeof window !== 'undefined' ? window : undefined);
  const clientId = randomId();

  // 1. Extension host.
  if (cfg.instance.preferExtension && win) {
    const conn = await connectExtension({ window: win, clientId, timeoutMs: cfg.instance.extensionTimeoutMs });
    if (conn) {
      const remote = makeShared(new RemoteSoftphone({ clientId, initialConfig: options.config }), 'extension');
      try {
        await remote.connect(conn.transport, { timeoutMs: cfg.instance.extensionWelcomeTimeoutMs });
        await provisionIfNeeded(remote, options.config);
        return remote;
      } catch {
        remote.disconnect();
        /* fall through to the web host */
      }
    }
  }

  // 2. Web host (leader tab).
  const locks = options.env?.locks !== undefined ? options.env.locks : ((globalThis.navigator as Navigator | undefined)?.locks as unknown as LocksLike | undefined);
  const createChannel =
    options.env?.createChannel !== undefined
      ? options.env.createChannel
      : typeof BroadcastChannel !== 'undefined'
        ? (name: string) => new BroadcastChannel(name) as unknown as ChannelLike
        : null;
  if (!locks || !createChannel) return options.createLocal(options.config);

  return startWebHost({ ...options, cfg, clientId, locks, createChannel, win });
}

/** Re-send the page's credentials when the extension instance is not set up for them. */
async function provisionIfNeeded(remote: RemoteSoftphone, config: SoftphoneConfigInput): Promise<void> {
  const patch = pickProvisioning(config);
  if (!patch.username && !patch.registerHeaders?.length) return;
  const reg = remote.getSnapshot().registration.state;
  const same = remote.config.username === patch.username;
  if (same && (reg === 'registered' || reg === 'registering' || reg === 'connecting')) return;
  try {
    await remote.updateConfig(patch);
  } catch {
    /* the extension may ask the user to approve this site first */
  }
}

type Mutable = { role: SharedRole; instancesCreated: number; roleListeners: Set<(r: SharedRole) => void> };

function makeShared(remote: RemoteSoftphone, role: SharedRole, destroy?: () => Promise<void>): SharedSoftphone {
  const state: Mutable = { role, instancesCreated: 0, roleListeners: new Set() };
  const shared = remote as SharedSoftphone & { __shared: Mutable };
  shared.__shared = state;
  Object.defineProperties(shared, {
    role: { get: () => state.role, configurable: true },
    instancesCreated: { get: () => state.instancesCreated, configurable: true },
  });
  shared.onRoleChange = (l) => {
    state.roleListeners.add(l);
    return () => state.roleListeners.delete(l);
  };
  shared.destroy =
    destroy ??
    (async () => {
      remote.disconnect();
    });
  return shared;
}

function setRole(shared: SharedSoftphone, role: SharedRole): void {
  const state = (shared as SharedSoftphone & { __shared: Mutable }).__shared;
  if (state.role === role) return;
  state.role = role;
  for (const l of [...state.roleListeners]) l(role);
}

interface WebHostOptions extends CreateSharedSoftphoneOptions {
  cfg: ResolvedConfig;
  clientId: string;
  locks: LocksLike;
  createChannel: (name: string) => ChannelLike;
  win: Window | undefined;
}

async function startWebHost(o: WebHostOptions): Promise<SharedSoftphone> {
  const name = o.cfg.instance.channel;
  const channel = o.createChannel(name);
  const myId = o.clientId;
  const abort = new AbortController();
  let destroyed = false;
  let releaseLock: (() => void) | null = null;
  /** Latest provisioning (credentials) shared by the leader, for a takeover. */
  let handover: SoftphoneConfigInput = {};
  let local: SoftphoneApi | null = null;
  let leaderCleanup: (() => Promise<void>) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connecting = false;

  const remote = new RemoteSoftphone({ clientId: myId, initialConfig: o.config });
  const shared = makeShared(remote, 'client', destroy);
  if (o.onRoleChange) shared.onRoleChange(o.onRoleChange);
  const state = (shared as SharedSoftphone & { __shared: Mutable }).__shared;

  const onFrame = (e: MessageEvent) => {
    const f: unknown = e.data;
    if (!isWebFrame(f) || f.from === myId) return;
    if (f.kind === 'handover' && f.data && typeof f.data === 'object') handover = pickProvisioning(f.data);
    if (f.kind === 'leader' && state.role === 'client' && remote.status !== 'connected') scheduleConnect(0);
  };
  channel.addEventListener('message', onFrame);

  // ---- client path ----------------------------------------------------------
  function scheduleConnect(delay: number): void {
    if (destroyed || state.role !== 'client') return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connectAsClient(), delay);
  }

  async function connectAsClient(): Promise<void> {
    if (destroyed || state.role !== 'client' || connecting) return;
    connecting = true;
    const transport = new BroadcastClientTransport(channel, myId);
    transport.onClose(() => {
      if (!destroyed && state.role === 'client') scheduleConnect(50);
    });
    try {
      await remote.connect(transport, { timeoutMs: 1_500 });
    } catch {
      transport.close();
      scheduleConnect(300);
    } finally {
      connecting = false;
    }
  }

  // ---- leader path ----------------------------------------------------------
  async function becomeLeader(): Promise<void> {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    setRole(shared, 'leader');
    const merged: SoftphoneConfigInput = { ...o.config, ...handover };
    // Leader-tab takeover keeps anchored calls (V2-RESUME-01): the resume descriptor
    // must be visible to whichever tab leads next, so it lives in localStorage here.
    const config: SoftphoneConfigInput = { ...merged, resume: { ...merged.resume, storage: 'local' } };
    const api = (await o.createLocal(config)) as ResumableSoftphone;
    state.instancesCreated++;
    local = api;
    const cdrLog: CdrLog = createCdrLog(api);
    const hostInfo: RemoteHostInfo = { kind: 'web', engine: api.getSnapshot().engine, debug: o.debugMethods };
    const sessions = new Map<string, { transport: BroadcastLeaderTransport; session: RemoteHostSession }>();

    const shareHandover = (patch: SoftphoneConfigInput) => {
      handover = { ...handover, ...patch };
      channel.postMessage(webFrame(myId, '*', 'handover', handover));
    };
    const onUpdateConfig = async (patch: SoftphoneConfigInput) => {
      await api.updateConfig(patch);
      shareHandover(patch);
    };

    const onLeaderFrame = (e: MessageEvent) => {
      const f: unknown = e.data;
      if (!isWebFrame(f) || f.from === myId) return;
      if (f.kind === 'leave') {
        const s = sessions.get(f.from);
        s?.transport.remoteClosed();
        return;
      }
      if (f.kind !== 'data' || (f.to !== 'leader' && f.to !== myId)) return;
      const msg = parseClientMessage(f.data);
      const existing = sessions.get(f.from);
      if (msg?.type === 'hello') {
        // A (re)connecting client: start a fresh session (serve sends the welcome).
        existing?.session.dispose('replaced');
        const transport = new BroadcastLeaderTransport(channel, myId, f.from, () => sessions.delete(f.from));
        const session = serveSoftphone(api, transport, {
          host: hostInfo,
          cdrLog,
          onUpdateConfig,
          onClose: () => sessions.delete(f.from),
        });
        sessions.set(f.from, { transport, session });
        // A tab that opened after the sign-in needs the credentials for a later takeover.
        if (Object.keys(handover).length) channel.postMessage(webFrame(myId, f.from, 'handover', handover));
        return;
      }
      existing?.transport.push(f.data);
    };
    channel.addEventListener('message', onLeaderFrame);
    const ping = setInterval(() => channel.postMessage(webFrame(myId, '*', 'ping')), 2_000);

    // Our own UI talks to the instance through a loopback.
    const [clientEnd, hostEnd] = createLoopbackPair();
    const ownSession = serveSoftphone(api, hostEnd, { host: hostInfo, cdrLog, onUpdateConfig });

    leaderCleanup = async () => {
      clearInterval(ping);
      channel.removeEventListener('message', onLeaderFrame);
      for (const s of sessions.values()) s.session.dispose('leader-leaving');
      sessions.clear();
      ownSession.dispose('leader-leaving');
      cdrLog.dispose();
      local = null;
      const d = api as SoftphoneApi & { destroy?: () => Promise<void> };
      await (d.destroy ? d.destroy() : api.stop()).catch(() => undefined);
    };

    await remote.connect(clientEnd, { local: api, timeoutMs: 5_000 });
    channel.postMessage(webFrame(myId, '*', 'leader'));
    try {
      // Reload continuity hook (core, separate work): restore the previous session when supported.
      if (typeof api.resume === 'function') await api.resume();
      else if (api.getSnapshot().app !== 'started') await api.start();
    } catch {
      /* registration errors surface through the snapshot / notifications */
    }
  }

  // Ask for leadership; until granted, be a client of the current leader.
  void o.locks
    .request(`${name}-host`, { signal: abort.signal }, async () => {
      if (destroyed) return;
      await becomeLeader();
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    })
    .catch(() => undefined);

  const onPageHide = () => {
    channel.postMessage(webFrame(myId, '*', 'leave'));
  };
  o.win?.addEventListener('pagehide', onPageHide);

  async function destroy(): Promise<void> {
    if (destroyed) return;
    destroyed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    o.win?.removeEventListener('pagehide', onPageHide);
    channel.postMessage(webFrame(myId, '*', 'leave'));
    abort.abort();
    remote.disconnect();
    await leaderCleanup?.();
    leaderCleanup = null;
    releaseLock?.();
    channel.removeEventListener('message', onFrame);
    channel.close();
  }

  // Wait briefly for a first state: either we lead (lock granted at once) or a leader welcomes us.
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 2_000);
    const off = remote.onStatus((s) => {
      if (s === 'connected') {
        clearTimeout(t);
        off();
        resolve();
      }
    });
    // Give the lock a tick to be granted before trying the client path.
    setTimeout(() => {
      if (state.role === 'client') void connectAsClient();
    }, 50);
  });
  void local;
  return shared;
}
