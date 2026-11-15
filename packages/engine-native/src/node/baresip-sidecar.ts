/**
 * The sidecar side of the native SIP protocol, implemented on baresip.
 *
 * It answers `NativeRequest`s from the engine by driving a running baresip
 * through ctrl_tcp (netstring JSON) and turns baresip events into
 * `NativeEvent`s. One sidecar = one baresip process = one SIP account.
 *
 *   NativeSipEngine ──(transport: IPC / stdio / memory)── BaresipSidecar ──(ctrl_tcp)── baresip
 *
 * baresip quirks handled here (verified against baresip 4.12):
 * - `uareg` needs the UA index; we keep exactly one UA (index 0) via `uadelall` + `uanew`.
 * - Unregistering reports UNREGISTERING and then REGISTER_OK/REGISTER_FAIL for the
 *   REGISTER with Expires: 0, which we translate to `unregistered`.
 * - Call commands act on the "current call": `callfind <id>` selects it first,
 *   inside one exclusive command section.
 * - CALL_CLOSED's text ("Rejected by user", "Connection reset by peer") does not
 *   say who hung up, so we track local terminations ourselves. Outgoing failures
 *   carry the SIP status first ("486 Busy Here,Q.850;cause=17").
 * - `sndcode` with several digits drops digits after the first on some paths, so
 *   digits are sent one by one, paced by `dtmfIntervalMs`.
 */
import type { DisconnectReason } from 'sipkit-core';
import {
  NATIVE_PROTOCOL_VERSION,
  type NativeAccount,
  type NativeErrorCode,
  type NativeEvent,
  type NativeHello,
  type NativeMessage,
  type NativeRequest,
} from '../protocol';
import type { NativeSipTransport, Unsubscribe } from '../transport';
import { BaresipControl, type BaresipEvent } from './baresip-control';

export interface BaresipSidecarOptions {
  /** baresip ctrl_tcp address. */
  host: string;
  port: number;
  /** Timeout for each baresip command, ms (default 10000). */
  commandTimeoutMs?: number;
  /** How long to keep retrying the ctrl_tcp connection on start, ms (default 10000). */
  connectTimeoutMs?: number;
  /** Gap between DTMF digits, ms (default 250). */
  dtmfIntervalMs?: number;
  /** How long to wait for a blind transfer to complete, ms (default 10000). */
  transferTimeoutMs?: number;
  /** How long to wait for the un-REGISTER outcome before reporting unregistered anyway, ms (default 5000). */
  unregisterTimeoutMs?: number;
  /** Name reported in `hello` (default "baresip"). */
  name?: string;
}

class SidecarError extends Error {
  constructor(
    readonly code: NativeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface CallState {
  callId: string;
  /** baresip call id (= SIP Call-ID), once known. */
  bid?: string;
  direction: 'incoming' | 'outgoing';
  established: boolean;
  localTerminate: boolean;
  rejectCode?: number;
  transfer?: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  transferred: boolean;
}

type RegState = 'idle' | 'registering' | 'registered' | 'failed';

/** SIP status -> DisconnectReason (same mapping as the SIP.js engine). */
export function reasonFromSipCode(code: number | undefined): DisconnectReason {
  switch (code) {
    case 486:
    case 600:
      return 'busy';
    case 603:
      return 'rejected';
    case 408:
    case 480:
      return 'no-answer';
    case 487:
      return 'cancelled';
    default:
      return 'failed';
  }
}

/** "sip:2001@pbx;transport=udp" -> "2001" (host when there is no user part). */
export function userOfUri(uri: string | undefined): string {
  if (!uri) return '';
  const bare =
    uri
      .replace(/^<|>$/g, '')
      .replace(/^sips?:/i, '')
      .split(';')[0] ?? '';
  const at = bare.indexOf('@');
  return at >= 0 ? bare.slice(0, at) : bare;
}

const UNSAFE_URI_PART = /[\s;<>"@\\,]/;
const UNSAFE_VALUE = /[\s;<>"\\]/;

/** baresip account line for `uanew`. Throws SidecarError('invalid') for values baresip cannot carry. */
export function baresipAccountLine(account: NativeAccount): string {
  const check = (name: string, value: string | undefined, pattern: RegExp, required = true) => {
    if (!value) {
      if (required) throw new SidecarError('invalid', `account.${name} is required`);
      return;
    }
    if (pattern.test(value))
      throw new SidecarError('invalid', `account.${name} contains characters baresip cannot carry`);
  };
  check('username', account.username, UNSAFE_URI_PART);
  check('domain', account.domain, UNSAFE_URI_PART);
  check('server', account.server, /[\s<>"\\,@]/);
  check('authUsername', account.authUsername, UNSAFE_VALUE, false);
  check('password', account.password, UNSAFE_VALUE, false);
  check('outboundProxy', account.outboundProxy, /[\s<>"\\,@]/, false);
  if (account.displayName && /["\\\r\n]/.test(account.displayName)) {
    throw new SidecarError(
      'invalid',
      'account.displayName contains characters baresip cannot carry',
    );
  }
  if (!['udp', 'tcp', 'tls'].includes(account.transport))
    throw new SidecarError('invalid', 'account.transport must be udp, tcp or tls');

  const transport = account.transport;
  const route = (account.outboundProxy || account.server).replace(/^sips?:/i, '').split(';')[0];
  const aor = `<sip:${account.username}@${account.domain};transport=${transport}>`;
  const params = [
    account.authUsername ? `auth_user=${account.authUsername}` : '',
    account.password ? `auth_pass=${account.password}` : '',
    `outbound="sip:${route};transport=${transport}"`,
    account.dtmfMode === 'info'
      ? 'dtmfmode=info'
      : account.dtmfMode === 'rfc2833'
        ? 'dtmfmode=rtpevent'
        : '',
    'answermode=manual',
    // Created unregistered: register() / unregister() drive REGISTER explicitly.
    'regint=0',
  ].filter(Boolean);
  const name = account.displayName ? `"${account.displayName}" ` : '';
  return `${name}${aor};${params.join(';')}`;
}

/** Drives one baresip instance on behalf of one NativeSipEngine. */
export class BaresipSidecar {
  private control: BaresipControl | undefined;
  private account: NativeAccount | undefined;
  private aor = '';
  private reg: RegState = 'idle';
  private unregistering: { timer: ReturnType<typeof setTimeout> } | undefined;
  private readonly calls = new Map<string, CallState>();
  private readonly byBid = new Map<string, CallState>();
  private inSeq = 0;
  /** While a `dial` is in flight: events for not-yet-mapped outgoing calls. */
  private dialBuffer: BaresipEvent[] | undefined;
  private readonly offs: Unsubscribe[] = [];
  private controlOffs: Array<() => void> = [];
  private readonly opts: Required<Omit<BaresipSidecarOptions, 'host' | 'port'>>;

  constructor(
    private readonly transport: NativeSipTransport,
    private readonly options: BaresipSidecarOptions,
  ) {
    this.opts = {
      commandTimeoutMs: 10_000,
      connectTimeoutMs: 10_000,
      dtmfIntervalMs: 250,
      transferTimeoutMs: 10_000,
      unregisterTimeoutMs: 5_000,
      name: 'baresip',
      ...stripUndefined(options),
    };
    this.offs.push(
      transport.onMessage((message) => this.onMessage(message)),
      transport.onClose(() => void this.dispose()),
    );
  }

  /** Stop serving: hang up, drop the account and close the baresip connection. */
  async dispose(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    await this.shutdown().catch(() => undefined);
  }

  // ------------------------------------------------------------------ protocol

  private onMessage(message: NativeMessage): void {
    if (message.type !== 'request') return;
    this.handle(message).then(
      (result) =>
        this.transport.send({
          type: 'response',
          id: message.id,
          ok: true,
          ...(result === undefined ? {} : { result }),
        }),
      (error: unknown) =>
        this.transport.send({
          type: 'response',
          id: message.id,
          ok: false,
          error: {
            code: error instanceof SidecarError ? error.code : 'failed',
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    );
  }

  private emit(event: NativeEvent): void {
    this.transport.send({ type: 'event', ...event });
  }

  private async handle(request: NativeRequest): Promise<unknown> {
    switch (request.cmd) {
      case 'hello':
        return {
          protocol: NATIVE_PROTOCOL_VERSION,
          sidecar: this.opts.name,
          capabilities: { attendedTransfer: false, extraHeaders: true, tls: true },
        } satisfies NativeHello;
      case 'start':
        return this.start(request.account);
      case 'stop':
        return this.shutdown();
      case 'register':
        return this.register();
      case 'unregister':
        return this.unregister();
      case 'call':
        return this.dial(request.callId, request.target, request.headers);
      case 'answer': {
        const call = this.call(request.callId);
        if (call.direction !== 'incoming' || call.established)
          throw new SidecarError('invalid', 'Not an unanswered incoming call');
        return this.ok(await this.ctl().command('accept', call.bid));
      }
      case 'reject': {
        const call = this.call(request.callId);
        if (call.direction !== 'incoming')
          throw new SidecarError('invalid', 'Not an incoming call');
        const code = request.code >= 400 && request.code <= 699 ? Math.trunc(request.code) : 486;
        call.localTerminate = true;
        call.rejectCode = code;
        return this.ok(await this.ctl().command('hangup', `${call.bid} scode=${code}`));
      }
      case 'hangup': {
        const call = this.calls.get(request.callId);
        if (!call?.bid) return undefined;
        call.localTerminate = true;
        return this.ok(await this.ctl().command('hangup', call.bid));
      }
      case 'hold': {
        const call = this.call(request.callId);
        return this.ok(await this.ctl().command(request.hold ? 'hold' : 'resume', call.bid));
      }
      case 'mute': {
        const call = this.call(request.callId);
        return this.onCall(call, (run) => run('mute', request.muted ? 'yes' : 'no'));
      }
      case 'dtmf':
        return this.dtmf(this.call(request.callId), request.tones);
      case 'transfer':
        return this.transfer(this.call(request.callId), request.target);
      case 'attendedTransfer':
        throw new SidecarError(
          'unsupported',
          'Attended transfer between two existing calls is not supported by the baresip sidecar',
        );
    }
  }

  // ------------------------------------------------------------------ commands

  private async start(account: NativeAccount): Promise<void> {
    const line = baresipAccountLine(account);
    if (this.account) await this.shutdown();
    this.emit({ event: 'transport', state: 'connecting' });
    const control = new BaresipControl(
      this.options.host,
      this.options.port,
      this.opts.commandTimeoutMs,
    );
    try {
      await control.connect(this.opts.connectTimeoutMs);
    } catch (error) {
      this.emit({
        event: 'transport',
        state: 'disconnected',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new SidecarError('transport', error instanceof Error ? error.message : String(error));
    }
    this.control = control;
    this.controlOffs = [
      control.onEvent((event) => this.onBaresipEvent(event)),
      control.onClose((reason) => this.onControlClose(reason)),
    ];
    // One UA per sidecar, always index 0.
    this.ok(await control.command('uadelall'));
    this.ok(await control.command('uanew', line));
    this.account = account;
    this.aor = `sip:${account.username}@${account.domain}`;
    this.reg = 'idle';
    this.emit({ event: 'transport', state: 'connected' });
  }

  private async shutdown(): Promise<void> {
    const control = this.control;
    this.clearUnregistering();
    for (const call of this.calls.values()) {
      call.localTerminate = true;
      this.settleTransfer(call, new Error('Sidecar stopped'));
    }
    this.calls.clear();
    this.byBid.clear();
    this.account = undefined;
    this.reg = 'idle';
    if (!control) return;
    for (const off of this.controlOffs.splice(0)) off();
    this.control = undefined;
    if (control.connected) await control.command('uadelall').catch(() => undefined);
    control.close();
  }

  private async register(): Promise<void> {
    const account = this.started();
    this.clearUnregistering();
    this.ok(await this.ctl().command('uareg', `${account.registerExpires} 0`));
  }

  private async unregister(): Promise<void> {
    this.started();
    if (this.reg === 'idle' || this.reg === 'failed') {
      // Nothing registered (or the registrar refused us): stop retries, report at once.
      await this.ctl()
        .command('uareg', '0 0')
        .catch(() => undefined);
      this.reg = 'idle';
      this.emit({ event: 'registration', state: 'unregistered' });
      return;
    }
    this.clearUnregistering();
    this.unregistering = {
      timer: setTimeout(() => this.finishUnregister(), this.opts.unregisterTimeoutMs),
    };
    this.ok(await this.ctl().command('uareg', '0 0'));
  }

  private async dial(callId: string, target: string, headers?: string[]): Promise<void> {
    this.started();
    if (this.calls.has(callId)) throw new SidecarError('invalid', `Call ${callId} already exists`);
    if (!/^sips?:[^\s<>"]+$/i.test(target))
      throw new SidecarError('invalid', `Invalid SIP target "${target}"`);
    const call: CallState = {
      callId,
      direction: 'outgoing',
      established: false,
      localTerminate: false,
      transferred: false,
    };
    this.calls.set(callId, call);
    const added = parseHeaders(headers);
    let bid: string | undefined;
    try {
      bid = await this.ctl().exclusive(async (run) => {
        for (const h of added)
          this.ok(await run('uaaddheader', `${h.name}=${encodeURIComponent(h.value)} 0`));
        this.dialBuffer = [];
        try {
          const response = this.ok(await run('dial', target));
          return /call id:\s*(\S+)/i.exec(response.data)?.[1];
        } finally {
          for (const h of added) await run('uarmheader', `${h.name} 0`).catch(() => undefined);
        }
      });
    } catch (error) {
      this.dialBuffer = undefined;
      this.calls.delete(callId);
      throw error;
    }
    const buffered = this.dialBuffer ?? [];
    this.dialBuffer = undefined;
    if (!bid) {
      this.calls.delete(callId);
      throw new SidecarError('failed', 'baresip did not report a call id for the dial');
    }
    call.bid = bid;
    this.byBid.set(bid, call);
    for (const event of buffered) if (event.id === bid) this.onCallEvent(call, event);
  }

  private async dtmf(call: CallState, tones: string): Promise<void> {
    if (!/^[0-9A-D*#]+$/i.test(tones))
      throw new SidecarError('invalid', `Invalid DTMF "${tones}" (0-9, A-D, * and # only)`);
    const digits = [...tones.toUpperCase()];
    for (let i = 0; i < digits.length; i++) {
      if (!this.calls.has(call.callId))
        throw new SidecarError('unknown-call', 'Call ended while sending DTMF');
      await this.onCall(call, (run) => run('sndcode', digits[i]));
      if (i < digits.length - 1) await sleep(this.opts.dtmfIntervalMs);
    }
  }

  private async transfer(call: CallState, target: string): Promise<void> {
    if (!/^sips?:[^\s<>"]+$/i.test(target))
      throw new SidecarError('invalid', `Invalid SIP target "${target}"`);
    if (!call.established)
      throw new SidecarError('invalid', 'Only connected calls can be transferred');
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        call.transfer = undefined;
        reject(new SidecarError('timeout', 'Transfer did not complete in time'));
      }, this.opts.transferTimeoutMs);
      call.transfer = { resolve, reject, timer };
    });
    try {
      await this.onCall(call, (run) => run('transfer', target));
    } catch (error) {
      this.settleTransfer(call);
      throw error;
    }
    try {
      await done;
    } catch (error) {
      // baresip put the call on hold before the REFER; take it back off hold.
      if (this.calls.has(call.callId))
        await this.ctl()
          .command('resume', call.bid)
          .catch(() => undefined);
      throw error;
    }
  }

  // ------------------------------------------------------------------ baresip events

  private onBaresipEvent(event: BaresipEvent): void {
    if (event.class === 'ua' || event.class === 'register') return this.onUaEvent(event);
    if (event.class !== 'call' || !event.id) return;
    const call = this.byBid.get(event.id);
    if (call) return this.onCallEvent(call, event);
    if (event.type === 'CALL_INCOMING' && event.direction === 'incoming')
      return this.onIncoming(event);
    if (this.dialBuffer && event.direction === 'outgoing') this.dialBuffer.push(event);
  }

  private onUaEvent(event: BaresipEvent): void {
    if (event.accountaor && this.aor && event.accountaor !== this.aor) return;
    const status = parseStatus(event.param);
    switch (event.type) {
      case 'REGISTERING':
        if (this.unregistering) return;
        this.reg = 'registering';
        return this.emit({ event: 'registration', state: 'registering' });
      case 'REGISTER_OK':
        if (this.unregistering) return this.finishUnregister();
        if (this.reg === 'registered') return; // refresh
        this.reg = 'registered';
        return this.emit({ event: 'registration', state: 'registered' });
      case 'REGISTER_FAIL':
        if (this.unregistering) return this.finishUnregister();
        this.reg = 'failed';
        return this.emit({
          event: 'registration',
          state: 'failed',
          ...(status.code !== undefined ? { code: status.code } : {}),
          reason: status.text || 'Registration failed',
        });
      default:
        return;
    }
  }

  private onIncoming(event: BaresipEvent): void {
    if (!this.account || !event.id) return;
    const callId = `native-in-${++this.inSeq}`;
    const call: CallState = {
      callId,
      bid: event.id,
      direction: 'incoming',
      established: false,
      localTerminate: false,
      transferred: false,
    };
    this.calls.set(callId, call);
    this.byBid.set(event.id, call);
    this.emit({
      event: 'incoming',
      callId,
      remoteNumber: userOfUri(event.peeruri),
      ...(event.peerdisplayname ? { remoteDisplayName: event.peerdisplayname } : {}),
      sipCallId: event.id,
    });
  }

  private onCallEvent(call: CallState, event: BaresipEvent): void {
    switch (event.type) {
      case 'CALL_RINGING':
        if (call.direction === 'outgoing' && !call.established)
          this.emit({ event: 'ringing', callId: call.callId });
        return;
      case 'CALL_PROGRESS':
        if (call.direction === 'outgoing' && !call.established)
          this.emit({ event: 'early-media', callId: call.callId });
        return;
      case 'CALL_ESTABLISHED':
        if (call.established) return;
        call.established = true;
        this.emit({ event: 'connected', callId: call.callId, sipCallId: call.bid });
        return;
      case 'CALL_HOLD':
      case 'CALL_RESUME':
        this.emit({ event: 'remote-hold', callId: call.callId, held: event.type === 'CALL_HOLD' });
        return;
      case 'CALL_DTMF_START':
        if (event.param) this.emit({ event: 'dtmf', callId: call.callId, digit: event.param });
        return;
      case 'CALL_TRANSFER_FAILED':
        this.settleTransfer(
          call,
          new SidecarError('failed', `Transfer failed${event.param ? `: ${event.param}` : ''}`),
        );
        return;
      case 'CALL_CLOSED': {
        if (call.transfer) {
          call.transferred = true;
          this.settleTransfer(call);
        }
        const { reason, code } = this.endReason(call, event.param);
        this.calls.delete(call.callId);
        if (call.bid) this.byBid.delete(call.bid);
        this.emit({
          event: 'ended',
          callId: call.callId,
          reason,
          ...(code !== undefined ? { code } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  private endReason(
    call: CallState,
    param: string | undefined,
  ): { reason: DisconnectReason; code?: number } {
    if (call.transferred) return { reason: 'transferred' };
    if (call.localTerminate) {
      if (call.established) return { reason: 'local-hangup' };
      if (call.direction === 'incoming')
        return { reason: 'rejected', code: call.rejectCode ?? 486 };
      return { reason: 'cancelled' };
    }
    if (call.established) return { reason: 'remote-hangup' };
    if (call.direction === 'incoming') return { reason: 'cancelled' };
    const { code } = parseStatus(param);
    if (code !== undefined) return { reason: reasonFromSipCode(code), code };
    return { reason: 'failed' };
  }

  private onControlClose(reason: string): void {
    for (const off of this.controlOffs.splice(0)) off();
    this.control = undefined;
    this.clearUnregistering();
    for (const call of [...this.calls.values()]) {
      this.settleTransfer(call, new SidecarError('transport', reason));
      this.emit({ event: 'ended', callId: call.callId, reason: 'failed' });
    }
    this.calls.clear();
    this.byBid.clear();
    if (this.account) {
      this.reg = 'idle';
      this.emit({ event: 'transport', state: 'disconnected', reason });
      this.emit({ event: 'registration', state: 'failed', reason });
    }
  }

  // ------------------------------------------------------------------ helpers

  private finishUnregister(): void {
    if (!this.unregistering) return;
    this.clearUnregistering();
    this.reg = 'idle';
    this.emit({ event: 'registration', state: 'unregistered' });
  }

  private clearUnregistering(): void {
    if (this.unregistering) clearTimeout(this.unregistering.timer);
    this.unregistering = undefined;
  }

  private settleTransfer(call: CallState, error?: Error): void {
    const transfer = call.transfer;
    if (!transfer) return;
    call.transfer = undefined;
    clearTimeout(transfer.timer);
    if (error) transfer.reject(error);
    else transfer.resolve();
  }

  /** Select the call as baresip's current call, then run commands on it. */
  private async onCall(
    call: CallState,
    fn: (
      run: (c: string, p?: string) => Promise<{ ok: boolean; data: string }>,
    ) => Promise<unknown>,
  ): Promise<void> {
    await this.ctl().exclusive(async (run) => {
      this.ok(await run('callfind', call.bid));
      this.ok((await fn(run)) as { ok: boolean; data: string });
    });
  }

  private ok<T extends { ok: boolean; data: string }>(response: T): T {
    if (!response.ok)
      throw new SidecarError('failed', `baresip: ${response.data.trim() || 'command failed'}`);
    return response;
  }

  private call(callId: string): CallState & { bid: string } {
    const call = this.calls.get(callId);
    if (!call?.bid) throw new SidecarError('unknown-call', `Unknown call ${callId}`);
    return call as CallState & { bid: string };
  }

  private started(): NativeAccount {
    if (!this.account || !this.control)
      throw new SidecarError('not-started', 'Sidecar not started');
    return this.account;
  }

  private ctl(): BaresipControl {
    if (!this.control) throw new SidecarError('transport', 'Not connected to baresip');
    return this.control;
  }
}

function parseStatus(param: string | undefined): { code?: number; text: string } {
  const text = (param ?? '').trim();
  const match = /^(\d{3})\b/.exec(text);
  return match ? { code: Number(match[1]), text } : { text };
}

function parseHeaders(headers: string[] | undefined): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const header of headers ?? []) {
    const colon = header.indexOf(':');
    if (colon <= 0) throw new SidecarError('invalid', `Invalid header "${header}"`);
    const name = header.slice(0, colon).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name))
      throw new SidecarError('invalid', `Invalid header name "${name}"`);
    out.push({ name, value: header.slice(colon + 1).trim() });
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
