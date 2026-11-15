/**
 * In-memory "PBX" that links FakeEngine instances, so the shared engine
 * contract suite (engine-contract.ts) can run against the fake: a call from
 * one engine rings the other, answer/hangup/hold/DTMF/transfer reach the peer.
 */
import { resolveConfig, type ResolvedConfig, type SoftphoneConfigInput } from '../config';
import { reasonFromCode } from '../engines/sipjs/helpers';
import type { EngineContractHarness } from './engine-contract';
import { FakeEngine } from './fake-engine';

type Leg = { engine: LoopbackEngine; id: string } | { service: string };

/** Accounts and services of the loopback network. */
export class LoopbackNetwork {
  /** username -> password */
  readonly accounts = new Map<string, string>();
  /** Dial strings answered by the network itself (e.g. "600" echo test). */
  readonly services = new Set<string>(['600']);
  readonly registered = new Map<string, LoopbackEngine>();
  /** Per engine: engine call id -> the other leg */
  private readonly links = new Map<LoopbackEngine, Map<string, Leg>>();

  addAccount(username: string, password: string): void {
    this.accounts.set(username, password);
  }

  link(engine: LoopbackEngine, id: string, peer: Leg): void {
    if (!this.links.has(engine)) this.links.set(engine, new Map());
    this.links.get(engine)!.set(id, peer);
  }

  peerOf(engine: LoopbackEngine, id: string): Leg | undefined {
    return this.links.get(engine)?.get(id);
  }

  unlink(engine: LoopbackEngine, id: string): void {
    this.links.get(engine)?.delete(id);
  }
}

const later = (fn: () => void) => setTimeout(fn, 0);

/** A FakeEngine whose calls travel over a {@link LoopbackNetwork}. */
export class LoopbackEngine extends FakeEngine {
  constructor(private readonly network: LoopbackNetwork) {
    super({ autoRegister: false, connectOnAnswer: false, endOnLocalTermination: true });
  }

  private get user(): string {
    return this.config?.username ?? '';
  }

  override async stop(): Promise<void> {
    for (const id of [...this.calls.keys()]) await this.hangup(id);
    if (this.network.registered.get(this.user) === this) this.network.registered.delete(this.user);
    await super.stop();
  }

  override async register(): Promise<void> {
    await super.register();
    const expected = this.network.accounts.get(this.user);
    later(() => {
      if (expected === undefined || expected !== this.config?.password) {
        this.simulateRegistrationFailure(expected === undefined ? 404 : 401, 'Unauthorized');
        return;
      }
      this.network.registered.set(this.user, this);
      this.simulateRegistered();
    });
  }

  override async unregister(): Promise<void> {
    if (this.network.registered.get(this.user) === this) this.network.registered.delete(this.user);
    await super.unregister();
  }

  override async call(
    engineCallId: string,
    target: string,
    options?: { extraHeaders?: string[]; video?: boolean },
  ): Promise<void> {
    await super.call(engineCallId, target, options);
    const user = target.replace(/^sips?:/, '').split('@')[0] ?? target;
    later(() => {
      if (this.network.services.has(user)) {
        this.network.link(this, engineCallId, { service: user });
        this.simulateRinging(engineCallId);
        this.simulateRemoteAnswer(engineCallId);
        return;
      }
      const peer = this.network.registered.get(user);
      if (!peer || !peer.started) {
        this.simulateCallEnded(engineCallId, 'failed', 404);
        return;
      }
      const inId = peer.simulateIncomingCall({ remoteNumber: this.user });
      this.network.link(this, engineCallId, { engine: peer, id: inId });
      this.network.link(peer, inId, { engine: this, id: engineCallId });
      this.simulateRinging(engineCallId);
    });
  }

  override async answer(engineCallId: string, options?: { video?: boolean }): Promise<void> {
    await super.answer(engineCallId, options);
    const peer = this.network.peerOf(this, engineCallId);
    this.simulateRemoteAnswer(engineCallId);
    if (peer && 'engine' in peer) later(() => peer.engine.simulateRemoteAnswer(peer.id));
  }

  override async reject(engineCallId: string, statusCode = 486): Promise<void> {
    const peer = this.network.peerOf(this, engineCallId);
    await super.reject(engineCallId, statusCode);
    this.drop(engineCallId);
    if (peer && 'engine' in peer) {
      later(() => peer.engine.endFromNetwork(peer.id, reasonFromCode(statusCode), statusCode));
    }
  }

  override async hangup(engineCallId: string): Promise<void> {
    const call = this.calls.get(engineCallId);
    if (!call) return;
    const peer = this.network.peerOf(this, engineCallId);
    await super.hangup(engineCallId);
    this.drop(engineCallId);
    if (peer && 'engine' in peer) {
      later(() =>
        peer.engine.endFromNetwork(peer.id, call.connected ? 'remote-hangup' : 'cancelled'),
      );
    }
  }

  override async setHold(engineCallId: string, hold: boolean): Promise<void> {
    await super.setHold(engineCallId, hold);
    const peer = this.network.peerOf(this, engineCallId);
    if (peer && 'engine' in peer) later(() => peer.engine.simulateRemoteHold(peer.id, hold));
  }

  override async sendDtmf(engineCallId: string, tones: string): Promise<void> {
    await super.sendDtmf(engineCallId, tones);
    const peer = this.network.peerOf(this, engineCallId);
    if (peer && 'engine' in peer)
      later(() => [...tones].forEach((d) => peer.engine.simulateDtmf(peer.id, d)));
  }

  override async blindTransfer(engineCallId: string, target: string): Promise<void> {
    await super.blindTransfer(engineCallId, target);
    const peer = this.network.peerOf(this, engineCallId);
    if (!peer || !('engine' in peer)) throw new Error('Nothing to transfer');
    if (!this.network.services.has(target) && !this.network.registered.has(target)) {
      throw new Error(`REFER rejected (404)`);
    }
    // Like a B2BUA: the peer leg is re-bridged to the target, our leg gets a BYE.
    this.network.link(peer.engine, peer.id, { service: target });
    this.drop(engineCallId);
    later(() => this.endFromNetwork(engineCallId, 'remote-hangup'));
  }

  override async attendedTransfer(engineCallId: string, toEngineCallId: string): Promise<void> {
    await super.attendedTransfer(engineCallId, toEngineCallId);
    const a = this.network.peerOf(this, engineCallId);
    const b = this.network.peerOf(this, toEngineCallId);
    if (!a || !b) throw new Error('Nothing to transfer');
    if ('engine' in a) this.network.link(a.engine, a.id, b);
    if ('engine' in b) this.network.link(b.engine, b.id, a);
    this.drop(engineCallId);
    this.drop(toEngineCallId);
    later(() => {
      this.endFromNetwork(engineCallId, 'remote-hangup');
      this.endFromNetwork(toEngineCallId, 'remote-hangup');
    });
  }

  /** The network ended this leg (peer hung up, rejected, transfer completed). */
  endFromNetwork(
    engineCallId: string,
    reason: Parameters<FakeEngine['simulateCallEnded']>[1],
    code?: number,
  ): void {
    if (!this.calls.has(engineCallId)) return;
    this.drop(engineCallId);
    this.simulateCallEnded(engineCallId, reason, code);
  }

  private drop(engineCallId: string): void {
    this.network.unlink(this, engineCallId);
  }
}

/**
 * Contract harness over a loopback network: party "a" is 2001, "b" is 2002,
 * "600" answers (transfer target). Remote hold is signalled (no B2BUA).
 */
export function createLoopbackHarness(config: SoftphoneConfigInput = {}): EngineContractHarness {
  const network = new LoopbackNetwork();
  const users = { a: '2001', b: '2002' } as const;
  for (const user of Object.values(users)) network.addAccount(user, 'secret');
  return {
    name: 'FakeEngine over a loopback network',
    createParty(role, overrides) {
      const cfg: ResolvedConfig = resolveConfig({
        username: users[role],
        password: overrides?.password ?? 'secret',
        transportMode: 'native',
        sipServer: 'loopback.test',
        ...config,
      });
      return { engine: new LoopbackEngine(network), config: cfg };
    },
    address: (role) => users[role],
    transferTarget: '600',
    dtmfDigits: '12#*90',
    capabilities: { mediaStreams: false, remoteHoldSignalling: true, registrationFailure: true },
    timeoutMs: 1000,
  };
}
