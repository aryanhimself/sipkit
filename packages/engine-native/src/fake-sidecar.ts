/**
 * In-memory sidecars that speak the native protocol and route calls between
 * each other, so `NativeSipEngine` can be tested (including the shared engine
 * contract) without baresip, Docker or a PBX. Also handy for UI work on the
 * desktop app.
 *
 *   const net = new FakeSidecarNetwork();
 *   net.addAccount('2001', 'secret');
 *   const engine = new NativeSipEngine({ transport: () => net.connect() });
 */
import type { DisconnectReason } from 'sipkit-core';
import {
  NATIVE_PROTOCOL_VERSION,
  type NativeAccount,
  type NativeErrorCode,
  type NativeEvent,
  type NativeRequest,
} from './protocol';
import { createMemoryTransportPair, type NativeSipTransport } from './transport';

type Peer = { sidecar: FakeSidecar; callId: string } | { service: string };

interface FakeCall {
  direction: 'incoming' | 'outgoing';
  established: boolean;
  peer?: Peer;
}

class FakeError extends Error {
  constructor(
    readonly code: NativeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const later = (fn: () => void) => setTimeout(fn, 0);

function reasonFor(code: number): DisconnectReason {
  if (code === 486 || code === 600) return 'busy';
  if (code === 408 || code === 480) return 'no-answer';
  if (code === 603) return 'rejected';
  return 'failed';
}

export class FakeSidecarNetwork {
  readonly accounts = new Map<string, string>();
  /** Dial strings answered by the network itself (blind transfer targets). */
  readonly services = new Set<string>(['600']);
  readonly registered = new Map<string, FakeSidecar>();
  /** Every request any sidecar received, oldest first. */
  readonly requests: NativeRequest[] = [];
  /** Commands the sidecars answer with `unsupported`. */
  readonly unsupported = new Set<string>(['attendedTransfer']);

  addAccount(username: string, password: string): void {
    this.accounts.set(username, password);
  }

  /** A fresh sidecar; returns the engine side of its transport. */
  connect(): NativeSipTransport {
    const [engineSide, sidecarSide] = createMemoryTransportPair();
    new FakeSidecar(this, sidecarSide);
    return engineSide;
  }
}

export class FakeSidecar {
  account: NativeAccount | undefined;
  readonly calls = new Map<string, FakeCall>();
  private seq = 0;

  constructor(
    private readonly network: FakeSidecarNetwork,
    private readonly transport: NativeSipTransport,
  ) {
    transport.onMessage((message) => {
      if (message.type !== 'request') return;
      network.requests.push(message);
      this.handle(message).then(
        (result) =>
          transport.send({
            type: 'response',
            id: message.id,
            ok: true,
            ...(result === undefined ? {} : { result }),
          }),
        (error: unknown) =>
          transport.send({
            type: 'response',
            id: message.id,
            ok: false,
            error: {
              code: error instanceof FakeError ? error.code : 'failed',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
    });
    transport.onClose(() => this.teardown());
  }

  emit(event: NativeEvent): void {
    this.transport.send({ type: 'event', ...event });
  }

  private get user(): string {
    return this.account?.username ?? '';
  }

  private async handle(request: NativeRequest): Promise<unknown> {
    if (this.network.unsupported.has(request.cmd))
      throw new FakeError('unsupported', `${request.cmd} is not supported`);
    switch (request.cmd) {
      case 'hello':
        return {
          protocol: NATIVE_PROTOCOL_VERSION,
          sidecar: 'fake-sidecar',
          capabilities: {
            attendedTransfer: !this.network.unsupported.has('attendedTransfer'),
            extraHeaders: true,
            tls: true,
          },
        };
      case 'start':
        this.account = request.account;
        this.emit({ event: 'transport', state: 'connecting' });
        this.emit({ event: 'transport', state: 'connected' });
        return undefined;
      case 'stop':
        this.teardown();
        return undefined;
      case 'register': {
        this.started();
        this.emit({ event: 'registration', state: 'registering' });
        const expected = this.network.accounts.get(this.user);
        later(() => {
          if (expected === undefined || expected !== this.account?.password) {
            this.emit({
              event: 'registration',
              state: 'failed',
              code: 401,
              reason: '401 Unauthorized',
            });
            return;
          }
          this.network.registered.set(this.user, this);
          this.emit({ event: 'registration', state: 'registered' });
        });
        return undefined;
      }
      case 'unregister':
        this.started();
        if (this.network.registered.get(this.user) === this)
          this.network.registered.delete(this.user);
        later(() => this.emit({ event: 'registration', state: 'unregistered' }));
        return undefined;
      case 'call':
        return this.dial(request.callId, request.target);
      case 'answer': {
        const call = this.call(request.callId);
        call.established = true;
        later(() => {
          this.emit({ event: 'connected', callId: request.callId });
          if (call.peer && 'sidecar' in call.peer)
            call.peer.sidecar.remoteConnected(call.peer.callId);
        });
        return undefined;
      }
      case 'reject': {
        const call = this.call(request.callId);
        this.end(request.callId, 'rejected', request.code);
        if (call.peer && 'sidecar' in call.peer) {
          const { sidecar, callId } = call.peer;
          later(() => sidecar.end(callId, reasonFor(request.code), request.code));
        }
        return undefined;
      }
      case 'hangup': {
        const call = this.calls.get(request.callId);
        if (!call) return undefined;
        this.end(
          request.callId,
          call.established
            ? 'local-hangup'
            : call.direction === 'incoming'
              ? 'rejected'
              : 'cancelled',
        );
        if (call.peer && 'sidecar' in call.peer) {
          const { sidecar, callId } = call.peer;
          later(() => sidecar.end(callId, call.established ? 'remote-hangup' : 'cancelled'));
        }
        return undefined;
      }
      case 'hold': {
        const call = this.call(request.callId);
        if (call.peer && 'sidecar' in call.peer) {
          const { sidecar, callId } = call.peer;
          later(() => sidecar.emit({ event: 'remote-hold', callId, held: request.hold }));
        }
        return undefined;
      }
      case 'mute':
        this.call(request.callId);
        return undefined;
      case 'dtmf': {
        const call = this.call(request.callId);
        if (call.peer && 'sidecar' in call.peer) {
          const { sidecar, callId } = call.peer;
          later(() =>
            [...request.tones].forEach((digit) => sidecar.emit({ event: 'dtmf', callId, digit })),
          );
        }
        return undefined;
      }
      case 'transfer': {
        const call = this.call(request.callId);
        const target = userOf(request.target);
        if (!this.network.services.has(target) && !this.network.registered.has(target)) {
          throw new FakeError('failed', 'Transfer failed: 404 Not Found');
        }
        if (call.peer && 'sidecar' in call.peer) {
          const peerCall = call.peer.sidecar.calls.get(call.peer.callId);
          if (peerCall) peerCall.peer = { service: target };
        }
        call.peer = undefined;
        later(() => this.end(request.callId, 'transferred'));
        return undefined;
      }
      case 'attendedTransfer':
        throw new FakeError('unsupported', 'attendedTransfer is not supported');
    }
  }

  private dial(callId: string, target: string): void {
    this.started();
    const call: FakeCall = { direction: 'outgoing', established: false };
    this.calls.set(callId, call);
    const user = userOf(target);
    later(() => {
      if (this.network.services.has(user)) {
        call.peer = { service: user };
        call.established = true;
        this.emit({ event: 'ringing', callId });
        this.emit({ event: 'connected', callId });
        return;
      }
      const peer = this.network.registered.get(user);
      if (!peer) {
        this.end(callId, 'failed', 404);
        return;
      }
      const inId = `fake-in-${++peer.seq}`;
      peer.calls.set(inId, {
        direction: 'incoming',
        established: false,
        peer: { sidecar: this, callId },
      });
      call.peer = { sidecar: peer, callId: inId };
      peer.emit({
        event: 'incoming',
        callId: inId,
        remoteNumber: this.user,
        sipCallId: `sip-${inId}`,
      });
      this.emit({ event: 'ringing', callId });
    });
  }

  /** The far end answered our outgoing call. */
  remoteConnected(callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    call.established = true;
    this.emit({ event: 'connected', callId });
  }

  end(callId: string, reason: DisconnectReason, code?: number): void {
    if (!this.calls.delete(callId)) return;
    this.emit({ event: 'ended', callId, reason, ...(code !== undefined ? { code } : {}) });
  }

  private teardown(): void {
    for (const [callId, call] of this.calls) {
      if (call.peer && 'sidecar' in call.peer)
        call.peer.sidecar.end(call.peer.callId, 'remote-hangup');
      this.calls.delete(callId);
    }
    if (this.network.registered.get(this.user) === this) this.network.registered.delete(this.user);
  }

  private call(callId: string): FakeCall {
    const call = this.calls.get(callId);
    if (!call) throw new FakeError('unknown-call', `Unknown call ${callId}`);
    return call;
  }

  private started(): void {
    if (!this.account) throw new FakeError('not-started', 'Sidecar not started');
  }
}

function userOf(target: string): string {
  return (target.replace(/^sips?:/i, '').split(/[@;]/)[0] ?? target).trim();
}
