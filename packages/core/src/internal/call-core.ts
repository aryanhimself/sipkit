import type { ResolvedConfig } from '../config';
import type { AnswerOptions, Call, CallId, CallOptions, EngineCallInfo, EngineListener, HoldState, Logger, SoftphoneEngine, SoftphoneEvents } from '../types';
import { SoftphoneError, toEngineError } from '../errors';
import type { CallRecord, CallRegistry } from './call-registry';
import type { ConferenceController } from './conference';
import type { PluginHost } from './plugin-host';
import type { TimerRegistry } from './timers';
import type { VideoController } from './video';
import type { ResumeController } from './resume';
import { DTMF_PATTERN, applyTechPrefix, normalizeNumber, parseDialString } from './numbers';

export interface CallControlDeps {
  engine: SoftphoneEngine;
  calls: CallRegistry;
  conference: ConferenceController;
  timers: TimerRegistry;
  plugins: PluginHost;
  logger: Logger;
  config: () => ResolvedConfig;
  getActive: () => CallId | null;
  setActive: (id: CallId | null) => void;
  notify: (n: SoftphoneEvents['notification']) => void;
  /** Do Not Disturb is on: reject incoming calls without ringing. */
  isDnd?: () => boolean;
  /** Video calls (V2-VID-01). */
  video?: VideoController;
  /** Push (V2-PUSH-01): 'answer' when this call is the one the agent clicked "Answer" for on a notification. */
  pushDecision?: (call: Call) => 'answer' | undefined;
  /** Reload-safe calls (V2-RESUME-01, docs/resume.md). */
  resume?: ResumeController;
}

type Progress = Parameters<EngineListener['onCallProgress']>[1];

export const UNANSWERED = new Set<Call['state']>(['setup', 'ringing', 'early']);
export const ESTABLISHED = new Set<Call['state']>(['connected', 'held']);

function combineHold(local: boolean, remote: boolean): HoldState {
  if (local && remote) return 'both';
  if (local) return 'local';
  return remote ? 'remote' : 'none';
}
export const isLocalHeld = (h: HoldState) => h === 'local' || h === 'both';
const isRemoteHeld = (h: HoldState) => h === 'remote' || h === 'both';

/**
 * Core call orchestration (extended by CallControl with transfers/conference): line allocation, incoming-call policy, hold/mute,
 * DTMF, transfers and conference bookkeeping. The Softphone class guards
 * lifecycle (started/registered) before delegating here.
 */
export class CallCore {
  constructor(protected readonly d: CallControlDeps) {}

  protected get cfg(): ResolvedConfig {
    return this.d.config();
  }

  // ------------------------------------------------------------ lookup

  /** Resolve an explicit call id, or fall back to the active call. */
  protected resolve(callId?: CallId): CallRecord {
    if (callId !== undefined) {
      const record = this.d.calls.get(callId);
      if (!record) throw new SoftphoneError('CALL_NOT_FOUND', `No call with id "${callId}"`);
      return record;
    }
    const active = this.d.getActive();
    const record = active ? this.d.calls.get(active) : undefined;
    if (!record) throw new SoftphoneError('NO_ACTIVE_CALL', 'There is no active call');
    return record;
  }

  /** Explicit id, else the active call if it is ringing-in, else the oldest ringing incoming call. */
  private resolveIncoming(callId?: CallId): CallRecord {
    if (callId !== undefined) return this.resolve(callId);
    const ringing = this.d.calls.all().filter((r) => r.call.direction === 'incoming' && UNANSWERED.has(r.call.state));
    const active = ringing.find((r) => r.call.id === this.d.getActive());
    const record = active ?? ringing.sort((a, b) => a.call.createdAt - b.call.createdAt)[0];
    if (!record) throw new SoftphoneError('NO_ACTIVE_CALL', 'There is no incoming call to handle');
    return record;
  }

  protected requireState(record: CallRecord, allowed: Set<Call['state']>, action: string): void {
    if (!allowed.has(record.call.state)) {
      throw new SoftphoneError('INVALID_STATE', `Cannot ${action} a call in state "${record.call.state}"`);
    }
  }

  /** Reload-safe calls: no media yet while the call is rejoining its anchor room. */
  protected requireNotResuming(record: CallRecord): void {
    if (record.call.resuming) throw new SoftphoneError('INVALID_STATE', 'The call is reconnecting');
  }

  /** Transfers and server conferences of an anchored call are not supported (docs/resume.md). */
  protected requireNotAnchored(record: CallRecord, action: string): void {
    if (record.call.anchorId) {
      throw new SoftphoneError('NOT_SUPPORTED', `Cannot ${action} a reload-safe (anchored) call; see docs/resume.md`);
    }
  }

  private requireUnansweredIncoming(record: CallRecord, action: string): void {
    if (record.call.direction !== 'incoming' || !UNANSWERED.has(record.call.state)) {
      throw new SoftphoneError('INVALID_STATE', `Can only ${action} an unanswered incoming call`);
    }
  }

  // ------------------------------------------------------------ number handling

  /** normalize → plugin beforeDial → techPrefix. */
  async prepareTarget(input: string): Promise<{ target: string; display: string; postDial: string }> {
    if (typeof input !== 'string') throw new SoftphoneError('INVALID_NUMBER', 'Number must be a string');
    const { number, postDial } = parseDialString(input);
    if (postDial && !DTMF_PATTERN.test(postDial)) {
      throw new SoftphoneError('INVALID_NUMBER', `Invalid post-dial DTMF "${postDial}"`);
    }
    const normalized = this.cfg.normalizeNumbers ? normalizeNumber(number) : number.trim();
    const display = (await this.d.plugins.beforeDial(normalized)).trim();
    if (!display) throw new SoftphoneError('INVALID_NUMBER', 'Number is empty');
    return { target: applyTechPrefix(display, this.cfg.techPrefix), display, postDial };
  }

  // ------------------------------------------------------------ outgoing

  async call(number: string, options?: CallOptions): Promise<Call> {
    const video = this.d.video?.wantsVideo(options?.video) ?? false;
    const { target, display, postDial } = await this.prepareTarget(number);
    if (this.d.calls.freeLine(this.cfg.maxLines) === undefined) {
      throw new SoftphoneError('MAX_LINES', `All ${this.cfg.maxLines} lines are busy`);
    }
    if (this.cfg.autoHoldOtherLines) await this.holdOthers([]);
    const line = this.d.calls.freeLine(this.cfg.maxLines);
    if (line === undefined) throw new SoftphoneError('MAX_LINES', `All ${this.cfg.maxLines} lines are busy`);
    this.d.logger.info(`Dialing ${target} on line ${line}`);
    const anchor = this.d.resume?.outgoing();
    const record = this.d.calls.create({
      direction: 'outgoing',
      state: 'setup',
      line,
      remoteNumber: display,
      postDial,
      ...(video ? { hasVideo: true, cameraOn: true } : {}),
      ...(anchor ? { anchorId: anchor.anchorId } : {}),
    });
    const id = record.call.id;
    this.d.setActive(id);
    this.d.timers.set(`${id}:ring`, this.cfg.ringTimeout * 1000, () => this.onRingTimeout(id));
    try {
      const headers = [...this.cfg.extraHeaders, ...(anchor?.headers ?? [])];
      const extraHeaders = headers.length ? headers : undefined;
      const opts = { ...(extraHeaders ? { extraHeaders } : {}), ...(video ? { video: true } : {}) };
      await this.d.engine.call(record.engineId, target, Object.keys(opts).length ? opts : undefined);
    } catch (error) {
      this.end(id, 'failed');
      throw toEngineError(error, 'Call');
    }
    return this.d.calls.get(id)?.call ?? record.call;
  }

  // ------------------------------------------------------------ incoming

  handleIncoming(engineId: string, info: EngineCallInfo, started: boolean): void {
    if (started && this.d.isDnd?.()) {
      const code = this.cfg.dnd.rejectCode;
      this.d.engine.reject(engineId, code).catch((e: unknown) => this.d.logger.warn('DND reject failed', e));
      this.emitMissed(info, code, 'dnd');
      return;
    }
    const busy = this.cfg.rejectOnBusy && this.d.calls.size > 0;
    const line = this.d.calls.freeLine(this.cfg.maxLines);
    if (!started || busy || line === undefined) {
      const code = started ? 486 : 480;
      this.d.engine.reject(engineId, code).catch((e: unknown) => this.d.logger.warn('Auto-reject failed', e));
      this.emitMissed(info, code);
      return;
    }
    const record = this.d.calls.create({
      engineId,
      direction: 'incoming',
      state: 'ringing',
      line,
      remoteNumber: info.remoteNumber,
      remoteDisplayName: info.remoteDisplayName,
      sipCallId: info.sipCallId,
      ...(info.pushId ? { pushId: info.pushId } : {}),
      ...(info.inviteHeaders ? { inviteHeaders: info.inviteHeaders } : {}),
      ...(this.d.resume?.incoming(info.anchorId) ? { anchorId: info.anchorId } : {}),
      ...(info.video && this.d.video?.enabled && this.d.video.supported ? { hasVideo: true, cameraOn: false } : {}),
    });
    const id = record.call.id;
    if (!this.d.getActive()) this.d.setActive(id);
    this.d.timers.set(`${id}:ring`, this.cfg.ringTimeout * 1000, () => this.onRingTimeout(id));
    this.decideIncoming(id, info).catch((e: unknown) => this.d.logger.error('Incoming call handling failed', e));
  }

  private emitMissed(info: EngineCallInfo, code: number, reason: 'busy' | 'dnd' = 'busy'): void {
    const now = Date.now();
    const call: Call = {
      id: this.d.calls.newId(), line: 0, sipCallId: info.sipCallId, direction: 'incoming', state: 'disconnected',
      remoteNumber: info.remoteNumber, remoteDisplayName: info.remoteDisplayName, muted: false, hold: 'none',
      createdAt: now, endedAt: now, disconnectReason: reason, disconnectCode: code, inConference: false, meta: {},
    };
    this.d.calls.emitCdr(call);
    const why = reason === 'dnd' ? 'Do Not Disturb' : 'busy';
    const from = info.remoteDisplayName ?? info.remoteNumber;
    this.d.notify({
      level: 'info',
      title: 'Missed call',
      message: `${from} (${why})`,
      code: 'missedCall',
      params: { from, reason },
    });
  }

  private async decideIncoming(id: CallId, info: EngineCallInfo): Promise<void> {
    const record = this.d.calls.get(id);
    if (!record) return;
    const decision = await this.d.plugins.onIncomingCall(record.call);
    if (!this.d.calls.get(id)) return; // cancelled while plugins ran
    switch (decision?.action) {
      case 'answer':
        return this.answer(id);
      case 'reject':
        return this.reject(id, decision.statusCode);
      case 'forward':
        return this.forward(decision.target, id);
      default:
        break;
    }
    if (this.d.pushDecision?.(record.call) === 'answer') return this.answer(id);
    if (this.cfg.autoAnswer) return this.answer(id);
    if (this.cfg.autoAnswerOnHeader && typeof info.autoAnswerDelay === 'number') {
      const delayMs = Math.max(0, info.autoAnswerDelay) * 1000;
      this.d.timers.set(`${id}:autoanswer`, delayMs, () => {
        this.answer(id).catch((e: unknown) => this.d.logger.warn('Header auto-answer failed', e));
      });
    }
  }

  async answer(callId?: CallId, options?: AnswerOptions): Promise<void> {
    const record = this.resolveIncoming(callId);
    this.requireUnansweredIncoming(record, 'answer');
    const id = record.call.id;
    const video = this.d.video?.answerWithVideo(record, options?.video) ?? false;
    this.d.timers.clear(`${id}:autoanswer`);
    if (this.cfg.autoHoldOtherLines) await this.holdOthers([id]);
    try {
      if (video) await this.d.engine.answer(record.engineId, { video: true });
      else await this.d.engine.answer(record.engineId);
    } catch (error) {
      throw toEngineError(error, 'Answer');
    }
    // Answered audio-only: the offered video is declined (engines report facts later anyway).
    if (record.call.hasVideo) this.d.calls.patch(id, video ? { cameraOn: true } : { hasVideo: false, cameraOn: false, remoteVideo: false });
    this.d.timers.clear(`${id}:ring`);
    if (this.d.calls.get(id)) this.d.setActive(id);
  }

  async reject(callId?: CallId, statusCode?: number): Promise<void> {
    const record = this.resolveIncoming(callId);
    this.requireUnansweredIncoming(record, 'reject');
    try {
      await this.d.engine.reject(record.engineId, statusCode);
    } finally {
      this.end(record.call.id, 'rejected', statusCode ?? 486);
    }
  }

  async forward(target: string, callId?: CallId): Promise<void> {
    const record = this.resolveIncoming(callId);
    this.requireUnansweredIncoming(record, 'forward');
    if (!this.d.engine.forward) throw new SoftphoneError('NOT_SUPPORTED', 'Engine does not support forwarding');
    const { target: dest } = await this.prepareTarget(target);
    try {
      await this.d.engine.forward(record.engineId, dest);
    } catch (error) {
      throw toEngineError(error, 'Forward');
    }
    this.end(record.call.id, 'transferred', 302);
  }

  // ------------------------------------------------------------ engine progress

  handleProgress(engineId: string, progress: Progress): void {
    const record = this.d.calls.byEngineId(engineId);
    if (!record) return;
    const { call } = record;
    if (call.resuming) {
      // Restored after a reload: this is the *85 rejoin call into the anchor room.
      if (progress.type === 'connected') {
        if (progress.sipCallId) this.d.calls.patch(call.id, { sipCallId: progress.sipCallId });
        void this.d.resume?.onRejoined(record);
      } else if (progress.type === 'ended') {
        this.d.resume?.onRejoinFailed(record, progress.code);
        this.end(call.id, 'failed', progress.code);
      }
      return;
    }
    switch (progress.type) {
      case 'ringing':
        if (call.direction === 'outgoing' && call.state === 'setup') this.d.calls.patch(call.id, { state: 'ringing' });
        return;
      case 'early-media':
        if (call.direction === 'outgoing' && UNANSWERED.has(call.state)) this.d.calls.patch(call.id, { state: 'early' });
        return;
      case 'connected':
        return this.onConnected(record, progress.sipCallId);
      case 'remote-hold':
        this.d.calls.patch(call.id, { hold: combineHold(isLocalHeld(call.hold), progress.held) });
        return;
      case 'ended':
        this.end(call.id, progress.reason, progress.code);
        return;
    }
  }

  private onConnected(record: CallRecord, sipCallId?: string): void {
    const { call } = record;
    this.d.timers.clear(`${call.id}:ring`);
    this.d.timers.clear(`${call.id}:autoanswer`);
    if (ESTABLISHED.has(call.state)) return;
    this.d.calls.patch(call.id, {
      state: 'connected',
      connectedAt: Date.now(),
      sipCallId: sipCallId ?? call.sipCallId,
    });
    if (record.postDial) {
      const tones = record.postDial;
      record.postDial = '';
      this.d.engine.sendDtmf(record.engineId, tones).catch((e: unknown) => this.d.logger.warn('Post-dial DTMF failed', e));
    }
  }

  private onRingTimeout(id: CallId): void {
    const record = this.d.calls.get(id);
    if (!record || !UNANSWERED.has(record.call.state)) return;
    this.d.logger.info(`Ring timeout on ${id}`);
    // Finalise first so the engine's own 'ended' report cannot override the reason.
    this.end(id, 'no-answer');
    const op =
      record.call.direction === 'incoming'
        ? this.d.engine.reject(record.engineId, 480)
        : this.d.engine.hangup(record.engineId);
    op.catch((e: unknown) => this.d.logger.warn('Ring-timeout teardown failed', e));
  }

  /** Finalise a call from outside call control (e.g. a failed reload rejoin). Idempotent. */
  finish(id: CallId, reason: Parameters<CallRegistry['finalize']>[1], code?: number): void {
    this.end(id, reason, code);
  }

  /** Finalise a call locally (idempotent) and fix up active call / conference / timers. */
  protected end(id: CallId, reason: Parameters<CallRegistry['finalize']>[1], code?: number): void {
    const record = this.d.calls.get(id);
    if (!record) return;
    this.d.timers.clearPrefix(`${id}:`);
    if (this.d.conference.has(record.engineId)) {
      this.d.conference
        .leave(record.engineId)
        .then((remaining) => this.afterConferenceChange(remaining))
        .catch((e: unknown) => this.d.logger.warn('Leaving conference failed', e));
    }
    this.d.video?.forget(id);
    this.d.resume?.forget(id);
    this.d.logger.info(`Call ${id} ended: ${reason}${code ? ` (${code})` : ''}`);
    this.d.calls.finalize(id, reason, code);
    if (this.d.getActive() === id) this.d.setActive(this.pickNextActive());
  }

  private pickNextActive(): CallId | null {
    const all = this.d.calls.all();
    const best =
      all.find((r) => r.call.state === 'connected') ??
      all.find((r) => r.call.direction === 'incoming' && UNANSWERED.has(r.call.state)) ??
      all[0];
    return best?.call.id ?? null;
  }

  // ------------------------------------------------------------ in-call controls

  async hangup(callId?: CallId): Promise<void> {
    const record = this.resolve(callId);
    const { call } = record;
    if (call.direction === 'incoming' && UNANSWERED.has(call.state) && !call.resuming) return this.reject(call.id);
    // A real hangup of a reload-safe call ends its PBX anchor room too (docs/resume.md).
    if (call.anchorId && (ESTABLISHED.has(call.state) || call.resuming)) this.d.resume?.onLocalHangup(call);
    try {
      await this.d.engine.hangup(record.engineId);
    } catch (error) {
      this.d.logger.warn('Engine hangup failed; ending call locally', error);
    }
    this.end(call.id, ESTABLISHED.has(call.state) ? 'local-hangup' : 'cancelled');
  }

  async hangupAll(): Promise<void> {
    const ids = this.d.calls.all().map((r) => r.call.id);
    await Promise.all(ids.map((id) => this.hangup(id).catch((e: unknown) => this.d.logger.warn(`Hangup of ${id} failed`, e))));
  }

  async hold(hold: boolean, callId?: CallId): Promise<void> {
    const record = this.resolve(callId);
    this.requireState(record, ESTABLISHED, hold ? 'hold' : 'resume');
    this.requireNotResuming(record);
    if (!hold && this.cfg.autoHoldOtherLines) {
      const keep = record.call.inConference ? this.conferenceCallIds() : [record.call.id];
      await this.holdOthers(keep);
    }
    await this.setHold(record, hold);
    if (!hold && this.d.calls.get(record.call.id)) this.d.setActive(record.call.id);
  }

  protected async setHold(record: CallRecord, hold: boolean): Promise<void> {
    if (isLocalHeld(record.call.hold) === hold) return;
    try {
      await this.d.engine.setHold(record.engineId, hold);
    } catch (error) {
      throw toEngineError(error, hold ? 'Hold' : 'Resume');
    }
    const current = this.d.calls.get(record.call.id)?.call;
    if (!current) return;
    this.d.calls.patch(current.id, {
      hold: combineHold(hold, isRemoteHeld(current.hold)),
      state: hold ? 'held' : 'connected',
    });
  }

  /** Locally hold every connected call except `keep`. Failures are logged. */
  private async holdOthers(keep: CallId[]): Promise<void> {
    const targets = this.d.calls
      .all()
      .filter((r) => !keep.includes(r.call.id) && r.call.state === 'connected' && !isLocalHeld(r.call.hold));
    await Promise.all(
      targets.map((r) => this.setHold(r, true).catch((e: unknown) => this.d.logger.warn(`Auto-hold of ${r.call.id} failed`, e))),
    );
  }

  mute(muted: boolean, callId?: CallId): void {
    const record = this.resolve(callId);
    if (record.call.inConference) {
      this.d.conference.setMicMuted(muted);
      for (const id of this.conferenceCallIds()) this.d.calls.patch(id, { muted });
      if (this.d.conference.mixing) return;
      for (const id of this.conferenceCallIds()) {
        const r = this.d.calls.get(id);
        if (r) this.d.engine.setMuted(r.engineId, muted);
      }
      return;
    }
    this.d.engine.setMuted(record.engineId, muted);
    this.d.calls.patch(record.call.id, { muted });
  }

  async sendDtmf(tones: string, callId?: CallId): Promise<void> {
    if (typeof tones !== 'string' || !DTMF_PATTERN.test(tones)) {
      throw new SoftphoneError('INVALID_ARGUMENT', `Invalid DTMF "${String(tones)}" (allowed: 0-9 A-D * # ,)`);
    }
    const record = this.resolve(callId);
    this.requireState(record, new Set(['connected', 'early']), 'send DTMF on');
    try {
      await this.d.engine.sendDtmf(record.engineId, tones);
    } catch (error) {
      throw toEngineError(error, 'DTMF');
    }
  }

  // ------------------------------------------------------------ conference helpers

  protected conferenceCallIds(): CallId[] {
    return this.d.calls.all().filter((r) => r.call.inConference).map((r) => r.call.id);
  }

  protected afterConferenceChange(remainingEngineIds: string[]): void {
    if (this.d.conference.memberIds.length > 0) return;
    for (const engineId of remainingEngineIds) {
      const record = this.d.calls.byEngineId(engineId);
      if (!record) continue;
      this.d.calls.patch(record.call.id, { inConference: false, partyMuted: false });
      if (record.call.muted) this.d.engine.setMuted(engineId, true);
    }
  }

}
