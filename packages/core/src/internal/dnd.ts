import type { ResolvedConfig } from '../config';
import type { PluginStorage } from '../plugin';
import type { Logger, RegistrationState, SoftphoneEvents } from '../types';
import { SoftphoneError } from '../errors';
import type { ServiceCallResult, ServiceCalls } from './service-call';

export interface DndDeps {
  config: () => ResolvedConfig;
  logger: Logger;
  storage: PluginStorage;
  service: ServiceCalls;
  get: () => boolean;
  /** Publish a new DND state (snapshot + `dnd:changed`). */
  set: (dnd: boolean) => void;
  setPending: (pending: boolean) => void;
  notify: (n: SoftphoneEvents['notification']) => void;
  isRegistered: () => boolean;
}

const STORAGE_KEY = 'dnd';

const isServerMode = (cfg: ResolvedConfig) => cfg.dnd.mode !== 'local';

function describe(result: ServiceCallResult): string {
  if (result.answered) return 'ok';
  if (result.code) return `SIP ${result.code}`;
  if (result.error instanceof Error) return result.error.message;
  return result.reason;
}

/**
 * Do Not Disturb (V2-FWD-01). Local mode only flips the flag the incoming-call
 * policy reads. Server modes also dial the PBX feature codes (`dnd.serverOn` /
 * `dnd.serverOff`) as silent service calls, re-apply (or query) the state on
 * every registration, and revert the toggle when the PBX did not accept it.
 */
export class DndController {
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private registered = false;
  /** Changed while unregistered: push (don't query) on the next registration. */
  private unsynced = false;

  constructor(private readonly d: DndDeps) {}

  /** Initial state: the remembered toggle (persist, server mode or resume), else `dnd.enabled`. */
  static initial(cfg: ResolvedConfig, storage: PluginStorage): boolean {
    const stored = cfg.dnd.persist || isServerMode(cfg) || cfg.resume.enabled ? storage.get<boolean>(STORAGE_KEY) : undefined;
    return typeof stored === 'boolean' ? stored : cfg.dnd.enabled;
  }

  private get cfg(): ResolvedConfig {
    return this.d.config();
  }

  /** The browser should auto-reject incoming calls (DND on and mode 'local' | 'both'). */
  rejectsLocally(): boolean {
    return this.d.get() && this.cfg.dnd.mode !== 'server';
  }

  set(on: boolean): Promise<void> {
    const dnd = Boolean(on);
    const previous = this.d.get();
    this.remember(dnd);
    if (previous !== dnd) {
      this.d.logger.info(`Do Not Disturb ${dnd ? 'on' : 'off'}`);
      this.d.set(dnd);
    }
    if (!isServerMode(this.cfg) || (previous === dnd && !this.unsynced)) return Promise.resolve();
    if (!this.d.isRegistered()) {
      this.unsynced = true;
      this.d.logger.info('Not registered: server-side DND is applied on the next registration');
      return Promise.resolve();
    }
    return this.enqueue(() => this.push(dnd, { revertTo: previous }));
  }

  /** Feed every registration state change. */
  onRegistration(state: RegistrationState): void {
    const was = this.registered;
    this.registered = state === 'registered';
    if (!this.registered || was) return;
    if (!isServerMode(this.cfg) || !this.cfg.dnd.syncOnRegister) return;
    this.enqueue(() => this.sync()).catch(() => undefined);
  }

  /** Config changed: entering a server mode while registered pushes the current state. */
  reconcile(previous: ResolvedConfig): void {
    if (isServerMode(previous) || !isServerMode(this.cfg) || !this.registered) return;
    this.remember(this.d.get());
    this.enqueue(() => this.push(this.d.get(), {})).catch(() => undefined);
  }

  private remember(dnd: boolean): void {
    if (this.cfg.dnd.persist || isServerMode(this.cfg) || this.cfg.resume.enabled) this.d.storage.set(STORAGE_KEY, dnd);
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async dial(code: string): Promise<ServiceCallResult> {
    if (++this.inFlight === 1) this.d.setPending(true);
    try {
      return await this.d.service.dial(code, this.cfg.dnd.serverTimeout * 1000);
    } finally {
      if (--this.inFlight === 0) this.d.setPending(false);
    }
  }

  /** Dial the on/off code. `revertTo` = user toggle: undo it and throw on failure. */
  private async push(dnd: boolean, { revertTo }: { revertTo?: boolean }): Promise<void> {
    const code = (dnd ? this.cfg.dnd.serverOn : this.cfg.dnd.serverOff).trim();
    if (!code) throw new SoftphoneError('INVALID_STATE', `No DND feature code configured (dnd.${dnd ? 'serverOn' : 'serverOff'})`);
    const result = await this.dial(code);
    if (result.answered) {
      this.unsynced = false;
      this.d.logger.info(`Server-side DND ${dnd ? 'on' : 'off'} (${code})`);
      return;
    }
    const detail = describe(result);
    this.d.logger.warn(`Server-side DND ${dnd ? 'on' : 'off'} failed (${code}: ${detail})`);
    if (revertTo !== undefined && this.d.get() === dnd && revertTo !== dnd) {
      this.remember(revertTo);
      this.d.set(revertTo);
    }
    this.d.notify({
      level: 'error',
      title: 'Do Not Disturb',
      message: `Could not turn Do Not Disturb ${dnd ? 'on' : 'off'} on the server (${detail})`,
      code: 'dndServerFailed',
      params: { state: dnd ? 'on' : 'off', reason: detail },
    });
    throw new SoftphoneError('ENGINE_ERROR', `Server-side DND ${dnd ? 'on' : 'off'} failed: ${detail}`, {
      cause: result.answered ? undefined : result.error,
    });
  }

  /** On registration: adopt the server's state (query code) or push ours. */
  private async sync(): Promise<void> {
    const query = this.cfg.dnd.serverQuery.trim();
    if (!query || this.unsynced) {
      await this.push(this.d.get(), {});
      return;
    }
    const result = await this.dial(query);
    let serverState: boolean | undefined;
    if (result.answered) serverState = false;
    else if (result.code === 486 || result.reason === 'busy') serverState = true;
    if (serverState === undefined) {
      this.d.logger.warn(`DND query ${query} failed (${describe(result)}); keeping the local state`);
      return;
    }
    if (serverState !== this.d.get()) {
      this.d.logger.info(`Server reports Do Not Disturb ${serverState ? 'on' : 'off'}`);
      this.remember(serverState);
      this.d.set(serverState);
    }
  }
}
