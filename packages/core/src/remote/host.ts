/**
 * Host side: serve one real SoftphoneApi to one remote client over a
 * RemoteTransport. A host runs one `serveSoftphone()` per attached client.
 */
import type { SoftphoneConfigInput } from '../config';
import type { Cdr, SoftphoneApi, SoftphoneEvents, Unsubscribe } from '../types';
import {
  REMOTE_EVENTS,
  parseClientMessage,
  pickProvisioning,
  publicConfig,
  remoteMessage,
  sanitizeSnapshot,
  type CommandMessage,
  type HostByeMessage,
  type ConfigMessage,
  type EventMessage,
  type RemoteHostInfo,
  type ResultMessage,
  type StateMessage,
  type WelcomeMessage,
} from './protocol';
import type { RemoteTransport } from './transport';

/** Recent CDRs of a host instance (shared by all its clients). */
export interface CdrLog {
  list(): Cdr[];
  dispose(): void;
}

/** Keep the last `max` CDRs (newest first), seeded from the `call-history` plugin when installed. */
export function createCdrLog(api: SoftphoneApi, max = 50): CdrLog {
  let items: Cdr[] = [];
  try {
    const plugin = api.plugin<{ list?: () => Cdr[] }>('call-history');
    const seeded = plugin?.list?.();
    if (Array.isArray(seeded)) items = seeded.slice(0, max);
  } catch {
    /* no plugin */
  }
  const off = api.on('cdr', (cdr) => {
    if (items.some((c) => c.callId === cdr.callId)) return;
    items = [cdr, ...items].slice(0, max);
  });
  return { list: () => items, dispose: off };
}

export interface RemoteHostOptions {
  host: RemoteHostInfo;
  /** Shared CDR log (create one per instance with {@link createCdrLog}). Default: none. */
  cdrLog?: CdrLog;
  /** Extra per-client filter on top of the protocol whitelist. */
  allow?: (name: CommandMessage['name']) => boolean;
  /**
   * Handles `updateConfig` from this client. Receives only provisioning keys
   * (credentials and transport, see `PROVISION_KEYS`). Default: apply them with
   * `api.updateConfig`. Throw to refuse (the client's promise rejects).
   */
  onUpdateConfig?: (patch: SoftphoneConfigInput) => Promise<void>;
  /** Commands per second before the client is throttled (default 30). */
  maxCommandsPerSecond?: number;
  /** Called once when the client went away or the host disposed the session. */
  onClose?: () => void;
}

export interface RemoteHostSession {
  readonly sessionId: string;
  dispose(reason?: string): void;
}

let seq = 0;
function newSessionId(): string {
  const rnd = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `s${++seq}-${rnd}`;
}

function toPlain(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v)) as unknown;
  } catch {
    return undefined;
  }
}

/** Serve `api` to the client at the other end of `transport`. Sends `welcome` at once. */
export function serveSoftphone(api: SoftphoneApi, transport: RemoteTransport, options: RemoteHostOptions): RemoteHostSession {
  const sessionId = newSessionId();
  const offs: Unsubscribe[] = [];
  const limit = options.maxCommandsPerSecond ?? 30;
  let windowStart = 0;
  let windowCount = 0;
  let lastConfig = api.config;
  let closed = false;

  const send = (m: unknown) => transport.send(m);
  const welcome = () =>
    send(
      remoteMessage<WelcomeMessage>({
        type: 'welcome',
        sessionId,
        host: options.host,
        snapshot: sanitizeSnapshot(api.getSnapshot()),
        config: publicConfig(api.config),
        cdrs: options.cdrLog?.list() ?? [],
      }),
    );

  offs.push(
    api.subscribe((snapshot) => {
      if (api.config !== lastConfig) {
        lastConfig = api.config;
        send(remoteMessage<ConfigMessage>({ type: 'config', config: publicConfig(api.config) }));
      }
      send(remoteMessage<StateMessage>({ type: 'state', snapshot: sanitizeSnapshot(snapshot) }));
    }),
  );
  for (const name of REMOTE_EVENTS) {
    offs.push(
      api.on(name, (payload: SoftphoneEvents[typeof name]) => {
        const plain = toPlain(payload);
        if (plain !== undefined) send(remoteMessage<EventMessage>({ type: 'event', name, payload: plain }));
      }),
    );
  }

  const reply = (id: number, ok: boolean, value?: unknown, error?: unknown) => {
    const err =
      error === undefined
        ? undefined
        : {
            message: error instanceof Error ? error.message : String(error),
            code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
          };
    send(remoteMessage<ResultMessage>({ type: 'result', id, ok, value: toPlain(value), error: err }));
  };

  async function execute(m: CommandMessage): Promise<unknown> {
    const a = m.args.map((x) => (x === null ? undefined : x)) as never[];
    switch (m.name) {
      case 'updateConfig': {
        const patch = pickProvisioning(m.args[0]);
        if (options.onUpdateConfig) await options.onUpdateConfig(patch);
        else await api.updateConfig(patch);
        return undefined;
      }
      case 'mute':
        api.mute(m.args[0] as boolean, (m.args[1] ?? undefined) as string | undefined);
        return undefined;
      case 'debug': {
        const [method, args] = m.args as [string, unknown[]];
        const fn = (api as unknown as Record<string, unknown>)[method];
        if (!options.host.debug?.includes(method) || typeof fn !== 'function') throw new Error(`debug ${method} not available`);
        return (fn as (...x: unknown[]) => unknown).apply(api, args);
      }
      default: {
        const fn = (api as unknown as Record<string, unknown>)[m.name];
        if (typeof fn !== 'function') throw new Error(`${m.name} is not supported by this host`);
        return (fn as (...x: unknown[]) => unknown).apply(api, a);
      }
    }
  }

  offs.push(
    transport.onMessage((raw) => {
      const m = parseClientMessage(raw);
      if (!m) {
        const id = (raw as { id?: unknown } | null)?.id;
        if ((raw as { type?: unknown } | null)?.type === 'command' && typeof id === 'number') reply(id, false, undefined, new Error('Command refused'));
        return;
      }
      if (m.type === 'hello') return welcome();
      if (m.type === 'bye') return dispose('client-bye');
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > limit) return reply(m.id, false, undefined, new Error('Too many commands'));
      if (options.allow && !options.allow(m.name)) return reply(m.id, false, undefined, new Error(`${m.name} not allowed`));
      Promise.resolve()
        .then(() => execute(m))
        .then(
          (value) => reply(m.id, true, value),
          (error: unknown) => reply(m.id, false, undefined, error),
        );
    }),
  );
  offs.push(transport.onClose(() => dispose('transport-closed')));

  function dispose(reason?: string): void {
    if (closed) return;
    closed = true;
    offs.forEach((off) => off());
    if (!transport.closed) {
      send(remoteMessage<HostByeMessage>({ type: 'host-bye', reason }));
      transport.close();
    }
    options.onClose?.();
  }

  welcome();
  return { sessionId, dispose };
}
