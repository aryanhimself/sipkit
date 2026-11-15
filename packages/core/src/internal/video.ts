import type { ResolvedConfig } from '../config';
import type { CallId, CallQuality, CallVideoStreams, EngineVideoState, Logger, SoftphoneEngine, SoftphoneEvents } from '../types';
import { SoftphoneError, toEngineError } from '../errors';
import type { CallRecord, CallRegistry } from './call-registry';

export interface VideoDeps {
  engine: SoftphoneEngine;
  calls: CallRegistry;
  config: () => ResolvedConfig;
  logger: Logger;
  getActive: () => CallId | null;
  emit: (payload: SoftphoneEvents['call:video']) => void;
}

const ESTABLISHED = new Set(['connected', 'held']);

/**
 * 1:1 video (V2-VID-01). Folds engine video facts into `Call.hasVideo /
 * cameraOn / remoteVideo`, emits `call:video`, turns the camera on/off and
 * keeps conferences audio-only. MediaStreams never enter the snapshot; they
 * are fetched with {@link getStreams}.
 */
export class VideoController {
  /** Remote video RTP seen in the last quality sample, per call (undefined = unknown). */
  private flowing = new Map<CallId, boolean>();
  /** Last engine report per call (remoteVideo before the RTP-flow check). */
  private reported = new Map<CallId, EngineVideoState>();

  constructor(private readonly d: VideoDeps) {}

  get enabled(): boolean {
    return this.d.config().video.enabled;
  }

  /** The engine can do video at all. */
  get supported(): boolean {
    return typeof this.d.engine.getVideoStreams === 'function';
  }

  /** Whether a new outgoing call should use video. Throws when video was asked for but is unavailable. */
  wantsVideo(requested: boolean | undefined): boolean {
    const video = requested ?? (this.enabled && this.d.config().video.defaultOn);
    if (!video) return false;
    if (!this.enabled) throw new SoftphoneError('NOT_SUPPORTED', 'Video is disabled (config video.enabled)');
    if (!this.supported) throw new SoftphoneError('NOT_SUPPORTED', `Engine "${this.d.engine.name}" has no video support`);
    return true;
  }

  /** Whether to answer this call with video. */
  answerWithVideo(record: CallRecord, requested: boolean | undefined): boolean {
    if (!this.enabled || !this.supported || !record.call.hasVideo) return false;
    return requested ?? this.d.config().video.defaultOn;
  }

  /** Engine reported new video facts. */
  handleEngine(engineId: string, state: EngineVideoState): void {
    const record = this.d.calls.byEngineId(engineId);
    if (!record || !this.enabled) return;
    // Audio-only calls keep their shape (no video fields) until video actually appears.
    if (record.call.hasVideo === undefined && !state.hasVideo && !state.cameraOn && !state.remoteVideo) return;
    this.reported.set(record.call.id, state);
    this.publish(record.call.id);
  }

  /** Quality sample: tells whether remote video RTP is actually flowing (camera off = no RTP). */
  handleQuality(callId: CallId, quality: CallQuality): void {
    const rate = quality.video?.inbound.bitrateKbps;
    if (rate === undefined) return;
    const flowing = rate > 1;
    if (this.flowing.get(callId) === flowing) return;
    this.flowing.set(callId, flowing);
    if (this.reported.has(callId)) this.publish(callId);
  }

  forget(callId: CallId): void {
    this.flowing.delete(callId);
    this.reported.delete(callId);
  }

  async setVideo(on: boolean, callId?: CallId): Promise<void> {
    const record = this.resolve(callId);
    if (!ESTABLISHED.has(record.call.state)) {
      throw new SoftphoneError('INVALID_STATE', `Cannot change video on a call in state "${record.call.state}"`);
    }
    if (on && !this.enabled) throw new SoftphoneError('NOT_SUPPORTED', 'Video is disabled (config video.enabled)');
    if (on && record.call.inConference) {
      throw new SoftphoneError('INVALID_STATE', 'Conferences are audio-only');
    }
    const engine = this.d.engine;
    if (!engine.setVideo) throw new SoftphoneError('NOT_SUPPORTED', `Engine "${engine.name}" has no video support`);
    if (Boolean(record.call.cameraOn) === on && (!on || record.call.hasVideo)) return;
    try {
      await engine.setVideo(record.engineId, on);
    } catch (error) {
      throw toEngineError(error, on ? 'Camera on' : 'Camera off');
    }
    // Engines report facts through onCallVideo; make the intent visible even if they do not.
    const current = this.d.calls.get(record.call.id)?.call;
    if (current && Boolean(current.cameraOn) !== on) {
      this.d.calls.patch(current.id, { cameraOn: on, hasVideo: Boolean(current.hasVideo) || on });
      this.emitFor(current.id);
    }
  }

  /** Conferences are audio-only: switch the cameras of the given calls off. Failures are logged. */
  async dropForConference(records: CallRecord[]): Promise<void> {
    await Promise.all(
      records
        .filter((r) => r.call.cameraOn)
        .map((r) =>
          this.setVideo(false, r.call.id).catch((e: unknown) =>
            this.d.logger.warn(`Turning the camera off for the conference failed (${r.call.id})`, e),
          ),
        ),
    );
  }

  getStreams(callId?: CallId): CallVideoStreams {
    const id = callId ?? this.d.getActive();
    const record = id ? this.d.calls.get(id) : undefined;
    if (!record || !this.enabled) return {};
    return this.d.engine.getVideoStreams?.(record.engineId) ?? {};
  }

  private publish(callId: CallId): void {
    const state = this.reported.get(callId);
    const record = this.d.calls.get(callId);
    if (!state || !record) return;
    const remoteVideo = state.remoteVideo && this.flowing.get(callId) !== false;
    this.d.calls.patch(callId, { hasVideo: state.hasVideo, cameraOn: state.cameraOn, remoteVideo });
    this.emitFor(callId);
  }

  private emitFor(callId: CallId): void {
    const call = this.d.calls.get(callId)?.call;
    if (!call) return;
    this.d.emit({
      callId,
      hasVideo: Boolean(call.hasVideo),
      cameraOn: Boolean(call.cameraOn),
      remoteVideo: Boolean(call.remoteVideo),
    });
  }

  private resolve(callId?: CallId): CallRecord {
    const id = callId ?? this.d.getActive();
    const record = id ? this.d.calls.get(id) : undefined;
    if (!record) {
      throw callId !== undefined
        ? new SoftphoneError('CALL_NOT_FOUND', `No call with id "${callId}"`)
        : new SoftphoneError('NO_ACTIVE_CALL', 'There is no active call');
    }
    return record;
  }
}
