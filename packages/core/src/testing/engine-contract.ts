/**
 * Shared engine contract suite (roadmap V1-TEST-02).
 *
 * Every `SoftphoneEngine` must pass it: two engine instances ("a" and "b")
 * register against the same server (or loopback network) and call each other.
 * The suite only talks to the `SoftphoneEngine` / `EngineListener` contract,
 * so it runs unchanged against `FakeEngine` (loopback), the native SIP engine
 * (baresip sidecars + Asterisk UDP endpoints 2001/2002) and, in a browser
 * runner, the SIP.js engine.
 *
 * It is test-framework agnostic: pass vitest's (or jest's) `describe`/`it`/
 * `afterEach`, so this module never imports a test runner into the dist.
 *
 *   import { describe, it, afterEach } from 'vitest';
 *   runEngineContract({ describe, it, afterEach }, harness);
 */
import type { ResolvedConfig } from '../config';
import type {
  DisconnectReason,
  EngineCallInfo,
  EngineListener,
  Logger,
  RegistrationStatus,
  SoftphoneEngine,
} from '../types';

export type ContractRole = 'a' | 'b';

/** What the engine (and the server between the parties) can do. Optional checks are skipped when false. */
export interface EngineContractCapabilities {
  /**
   * `getMediaStreams()` returns a remote `MediaStream` once connected
   * (browser/WebRTC engines). Native engines keep media in the native stack.
   */
  mediaStreams: boolean;
  /**
   * The far end is told about our hold (it receives the re-INVITE and reports
   * `remote-hold`). False behind a B2BUA such as Asterisk, which answers the
   * hold itself and plays music on hold instead of forwarding it.
   */
  remoteHoldSignalling: boolean;
  /** A wrong password makes `register()` report `failed` (needs a server that challenges). */
  registrationFailure: boolean;
}

export interface EngineContractParty {
  engine: SoftphoneEngine;
  config: ResolvedConfig;
}

export interface EngineContractHarness {
  /** Shown in the describe() title, e.g. "fake loopback" or "native (baresip) vs Asterisk". */
  name: string;
  /** Create a not-yet-started engine and its config for a party. `password` overrides the configured one. */
  createParty(
    role: ContractRole,
    overrides?: { password?: string },
  ): Promise<EngineContractParty> | EngineContractParty;
  /** Dial string that reaches a party (e.g. "2002"), passed to `engine.call()`. */
  address(role: ContractRole): string;
  /** A destination that answers and stays up, used as the blind transfer target (Asterisk dev PBX: "600"). */
  transferTarget: string;
  /**
   * DTMF digits to send. Keep to 0-9 behind Asterisk: the dev dialplan dials
   * with `Dial(...,tT)`, so `#` and `*` start feature codes and are swallowed.
   */
  dtmfDigits?: string;
  capabilities: EngineContractCapabilities;
  /** Timeout for each awaited engine event, ms (default 5000). */
  timeoutMs?: number;
  /** Called after each test once both parties are stopped (e.g. reset containers). */
  afterEach?(): Promise<void> | void;
}

/** The subset of a test framework the suite needs (vitest / jest compatible). */
export interface ContractTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>, timeoutMs?: number): void;
  afterEach(fn: () => Promise<void>, timeoutMs?: number): void;
}

/** An event reported by an engine through its listener. */
export type RecordedEngineEvent =
  | { kind: 'transport'; state: 'connecting' | 'connected' | 'disconnected'; reason?: string }
  | { kind: 'registration'; status: RegistrationStatus }
  | { kind: 'incoming'; id: string; info: EngineCallInfo }
  | { kind: 'ringing'; id: string }
  | { kind: 'early-media'; id: string }
  | { kind: 'connected'; id: string; sipCallId?: string }
  | { kind: 'remote-hold'; id: string; held: boolean }
  | { kind: 'ended'; id: string; reason: DisconnectReason; code?: number }
  | { kind: 'dtmf'; id: string; digit: string };

/** EngineListener that records every event and lets tests await them. */
export class RecordingListener implements EngineListener {
  readonly events: RecordedEngineEvent[] = [];
  private waiters = new Set<() => void>();

  constructor(
    private readonly label = 'engine',
    private readonly defaultTimeoutMs = 5000,
  ) {}

  onTransportState(state: 'connecting' | 'connected' | 'disconnected', reason?: string): void {
    this.push({ kind: 'transport', state, reason });
  }
  onRegistration(status: RegistrationStatus): void {
    this.push({ kind: 'registration', status });
  }
  onIncomingCall(id: string, info: EngineCallInfo): void {
    this.push({ kind: 'incoming', id, info });
  }
  onCallProgress(id: string, progress: Parameters<EngineListener['onCallProgress']>[1]): void {
    switch (progress.type) {
      case 'ringing':
      case 'early-media':
        return this.push({ kind: progress.type, id });
      case 'connected':
        return this.push({ kind: 'connected', id, sipCallId: progress.sipCallId });
      case 'remote-hold':
        return this.push({ kind: 'remote-hold', id, held: progress.held });
      case 'ended':
        return this.push({ kind: 'ended', id, reason: progress.reason, code: progress.code });
    }
  }
  onDtmf(id: string, digit: string): void {
    this.push({ kind: 'dtmf', id, digit });
  }

  /** Events of one kind (optionally for one call). */
  of<K extends RecordedEngineEvent['kind']>(
    kind: K,
    id?: string,
  ): Extract<RecordedEngineEvent, { kind: K }>[] {
    return this.events.filter(
      (e): e is Extract<RecordedEngineEvent, { kind: K }> =>
        e.kind === kind && (id === undefined || ('id' in e && e.id === id)),
    );
  }

  /** Resolve with the first recorded event (past or future) matching `predicate`. */
  waitFor<K extends RecordedEngineEvent['kind']>(
    kind: K,
    predicate: (event: Extract<RecordedEngineEvent, { kind: K }>) => boolean = () => true,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<Extract<RecordedEngineEvent, { kind: K }>> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const hit = this.of(kind).find(predicate);
        if (!hit) return false;
        cleanup();
        resolve(hit);
        return true;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `[${this.label}] timed out after ${timeoutMs} ms waiting for a "${kind}" event. Events so far: ${JSON.stringify(this.events)}`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
      };
      const waiter = () => void check();
      if (check()) return;
      this.waiters.add(waiter);
    });
  }

  private push(event: RecordedEngineEvent): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) waiter();
  }
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Engine contract violated: ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LiveParty extends EngineContractParty {
  role: ContractRole;
  events: RecordingListener;
  started: boolean;
}

/**
 * Register the contract tests with the given test framework. Each test starts
 * fresh engines and stops them afterwards (hanging up anything left over).
 */
export function runEngineContract(api: ContractTestApi, harness: EngineContractHarness): void {
  const timeout = harness.timeoutMs ?? 5000;
  // Per test: a handful of sequential waits plus start/stop.
  const testTimeout = timeout * 8 + 10_000;
  const caps = harness.capabilities;
  let live: LiveParty[] = [];
  let seq = 0;

  async function party(role: ContractRole, overrides?: { password?: string }): Promise<LiveParty> {
    const created = await harness.createParty(role, overrides);
    const p: LiveParty = {
      ...created,
      role,
      events: new RecordingListener(`${harness.name}:${role}`, timeout),
      started: false,
    };
    live.push(p);
    return p;
  }

  async function start(p: LiveParty): Promise<void> {
    await p.engine.start({ config: p.config, listener: p.events, logger: silentLogger });
    p.started = true;
    await p.events.waitFor('transport', (e) => e.state === 'connected');
  }

  async function registered(role: ContractRole): Promise<LiveParty> {
    const p = await party(role);
    await start(p);
    await p.engine.register();
    await p.events.waitFor('registration', (e) => e.status.state === 'registered');
    return p;
  }

  /** a calls b; resolves once b has the incoming call and a hears ringing. */
  async function ring(a: LiveParty, b: LiveParty): Promise<{ outId: string; inId: string }> {
    const outId = `contract-${++seq}`;
    await a.engine.call(outId, harness.address(b.role));
    const incoming = await b.events.waitFor('incoming');
    await a.events.waitFor('ringing', (e) => e.id === outId);
    return { outId, inId: incoming.id };
  }

  async function connect(a: LiveParty, b: LiveParty): Promise<{ outId: string; inId: string }> {
    const ids = await ring(a, b);
    await b.engine.answer(ids.inId);
    await a.events.waitFor('connected', (e) => e.id === ids.outId);
    await b.events.waitFor('connected', (e) => e.id === ids.inId);
    return ids;
  }

  function ended(p: LiveParty, id: string) {
    return p.events.waitFor('ended', (e) => e.id === id);
  }

  api.describe(`engine contract (V1-TEST-02): ${harness.name}`, () => {
    api.afterEach(async () => {
      const parties = live;
      live = [];
      for (const p of parties) {
        if (!p.started) continue;
        // Hang up whatever a failed test left behind, then stop.
        const open = new Set<string>();
        for (const e of p.events.events) {
          if (e.kind === 'incoming') open.add(e.id);
          if (e.kind === 'ringing' || e.kind === 'connected') open.add(e.id);
          if (e.kind === 'ended') open.delete(e.id);
        }
        for (const id of open) await p.engine.hangup(id).catch(() => undefined);
        await p.engine.unregister().catch(() => undefined);
        await p.engine.stop().catch(() => undefined);
      }
      await harness.afterEach?.();
    }, testTimeout);

    api.it(
      'start() reports a connected transport and the engine has a name',
      async () => {
        const a = await party('a');
        check(
          typeof a.engine.name === 'string' && a.engine.name.length > 0,
          'engine.name is a non-empty string',
        );
        await start(a);
      },
      testTimeout,
    );

    api.it(
      'register() reports registered, unregister() reports unregistered',
      async () => {
        const a = await registered('a');
        await a.engine.unregister();
        await a.events.waitFor('registration', (e) => e.status.state === 'unregistered');
      },
      testTimeout,
    );

    if (caps.registrationFailure) {
      api.it(
        'a wrong password reports a failed registration',
        async () => {
          const a = await party('a', { password: 'definitely-wrong-password' });
          await start(a);
          await a.engine.register();
          const failed = await a.events.waitFor('registration', (e) => e.status.state === 'failed');
          check(
            failed.status.code === undefined ||
              (failed.status.code >= 400 && failed.status.code < 700),
            `failure code is a SIP error status (got ${failed.status.code})`,
          );
          check(
            !a.events.of('registration').some((e) => e.status.state === 'registered'),
            'never reported registered',
          );
        },
        testTimeout,
      );
    }

    api.it(
      'outgoing call: ringing, incoming info, answer connects both sides, local hangup',
      async () => {
        const a = await registered('a');
        const b = await registered('b');
        const { outId, inId } = await ring(a, b);
        const incoming = b.events.of('incoming', inId)[0];
        check(incoming, 'callee got onIncomingCall');
        check(
          incoming.info.remoteNumber === a.config.username,
          `incoming remoteNumber is the caller's user (expected ${a.config.username}, got ${incoming.info.remoteNumber})`,
        );
        check(inId !== outId || a.engine !== b.engine, 'engine call ids are per engine');
        await b.engine.answer(inId);
        await a.events.waitFor('connected', (e) => e.id === outId);
        await b.events.waitFor('connected', (e) => e.id === inId);
        await a.engine.hangup(outId);
        const localEnd = await ended(a, outId);
        const remoteEnd = await ended(b, inId);
        check(
          localEnd.reason === 'local-hangup',
          `caller ended local-hangup (got ${localEnd.reason})`,
        );
        check(
          remoteEnd.reason === 'remote-hangup',
          `callee ended remote-hangup (got ${remoteEnd.reason})`,
        );
      },
      testTimeout,
    );

    api.it(
      'remote hangup of a connected call is reported as remote-hangup',
      async () => {
        const a = await registered('a');
        const b = await registered('b');
        const { outId, inId } = await connect(a, b);
        await b.engine.hangup(inId);
        const callerEnd = await ended(a, outId);
        const calleeEnd = await ended(b, inId);
        check(
          callerEnd.reason === 'remote-hangup',
          `caller ended remote-hangup (got ${callerEnd.reason})`,
        );
        check(
          calleeEnd.reason === 'local-hangup',
          `callee ended local-hangup (got ${calleeEnd.reason})`,
        );
      },
      testTimeout,
    );

    api.it(
      'reject(486): callee ends rejected, caller ends busy with code 486',
      async () => {
        const a = await registered('a');
        const b = await registered('b');
        const { outId, inId } = await ring(a, b);
        await b.engine.reject(inId, 486);
        const calleeEnd = await ended(b, inId);
        const callerEnd = await ended(a, outId);
        check(calleeEnd.reason === 'rejected', `callee ended rejected (got ${calleeEnd.reason})`);
        check(callerEnd.reason === 'busy', `caller ended busy (got ${callerEnd.reason})`);
        check(callerEnd.code === 486, `caller end code 486 (got ${callerEnd.code})`);
        check(!a.events.of('connected', outId).length, 'caller never connected');
      },
      testTimeout,
    );

    api.it(
      'hangup() before answer cancels: both sides end cancelled',
      async () => {
        const a = await registered('a');
        const b = await registered('b');
        const { outId, inId } = await ring(a, b);
        await a.engine.hangup(outId);
        const callerEnd = await ended(a, outId);
        const calleeEnd = await ended(b, inId);
        check(callerEnd.reason === 'cancelled', `caller ended cancelled (got ${callerEnd.reason})`);
        check(calleeEnd.reason === 'cancelled', `callee ended cancelled (got ${calleeEnd.reason})`);
      },
      testTimeout,
    );

    api.it(
      `hold / unhold keep the call up${caps.remoteHoldSignalling ? ' and the far end sees remote-hold' : ''}`,
      async () => {
        const a = await registered('a');
        const b = await registered('b');
        const { outId, inId } = await connect(a, b);
        await a.engine.setHold(outId, true);
        if (caps.remoteHoldSignalling)
          await b.events.waitFor('remote-hold', (e) => e.id === inId && e.held);
        await a.engine.setHold(outId, false);
        if (caps.remoteHoldSignalling)
          await b.events.waitFor('remote-hold', (e) => e.id === inId && !e.held);
        await delay(300);
        check(
          !a.events.of('ended', outId).length && !b.events.of('ended', inId).length,
          'call still up after hold/unhold',
        );
        await a.engine.hangup(outId);
        await ended(b, inId);
      },
      testTimeout,
    );

    api.it(
      'mute / unmute is local only and keeps the call up',
      async () => {
        const a = await registered('a');
        const b = await registered('b');
        const { outId, inId } = await connect(a, b);
        a.engine.setMuted(outId, true);
        a.engine.setMuted(outId, false);
        a.engine.setMuted('no-such-call', true); // must not throw
        await delay(300);
        check(
          !a.events.of('ended', outId).length && !b.events.of('ended', inId).length,
          'call still up after mute',
        );
        check(!b.events.of('remote-hold', inId).length, 'mute is not signalled as hold');
        await a.engine.hangup(outId);
        await ended(b, inId);
      },
      testTimeout,
    );

    api.it(
      'DTMF digits arrive at the far end in order',
      async () => {
        const digits = harness.dtmfDigits ?? '1590';
        const a = await registered('a');
        const b = await registered('b');
        const { outId, inId } = await connect(a, b);
        await a.engine.sendDtmf(outId, digits);
        await b.events.waitFor(
          'dtmf',
          () => b.events.of('dtmf', inId).length >= digits.length,
          timeout * 2,
        );
        const got = b.events
          .of('dtmf', inId)
          .map((e) => e.digit)
          .join('');
        check(got === digits, `received DTMF "${got}", expected "${digits}"`);
        await a.engine.hangup(outId);
        await ended(b, inId);
      },
      testTimeout,
    );

    api.it(
      'blind transfer hands the far end over to the target and ends our leg',
      async () => {
        const a = await registered('a');
        const b = await registered('b');
        const { outId, inId } = await connect(a, b);
        await a.engine.blindTransfer(outId, harness.transferTarget);
        const ourEnd = await ended(a, outId);
        check(
          ['remote-hangup', 'local-hangup', 'transferred'].includes(ourEnd.reason),
          `transferor leg ended normally (got ${ourEnd.reason})`,
        );
        await delay(1000);
        check(
          !b.events.of('ended', inId).length,
          'the transferred party stays connected (now to the target)',
        );
        await b.engine.hangup(inId);
        await ended(b, inId);
      },
      testTimeout,
    );

    api.it(
      'operations on unknown call ids do not throw for hangup/mute; getMediaStreams returns an object',
      async () => {
        const a = await registered('a');
        await a.engine.hangup('no-such-call');
        a.engine.setMuted('no-such-call', true);
        const streams = a.engine.getMediaStreams('no-such-call');
        check(typeof streams === 'object' && streams !== null, 'getMediaStreams returns an object');
        check(!streams.remote, 'no remote stream for an unknown call');
      },
      testTimeout,
    );

    if (caps.mediaStreams) {
      api.it(
        'getMediaStreams() exposes the remote stream of a connected call',
        async () => {
          const a = await registered('a');
          const b = await registered('b');
          const { outId, inId } = await connect(a, b);
          check(a.engine.getMediaStreams(outId).remote, 'caller has a remote MediaStream');
          await a.engine.hangup(outId);
          await ended(b, inId);
        },
        testTimeout,
      );
    }

    api.it(
      'stop() after a call leaves the engine restartable',
      async () => {
        const a = await registered('a');
        await a.engine.unregister();
        await a.events.waitFor('registration', (e) => e.status.state === 'unregistered');
        await a.engine.stop();
        a.started = false;
        // Same instance, started again: the orchestrator restarts engines on config changes.
        const events = new RecordingListener(`${harness.name}:a(restart)`, timeout);
        a.events = events;
        await start(a);
        await a.engine.register();
        await events.waitFor('registration', (e) => e.status.state === 'registered');
      },
      testTimeout,
    );
  });
}
