import { Invitation, Inviter, SessionState, UserAgent, type Session } from 'sip.js';
import type { ResolvedConfig } from '../../config';
import type {
  CallVideoStreams,
  DisconnectReason,
  EngineCallInfo,
  EngineCallStats,
  EngineListener,
  EngineMessageResult,
  EngineStartOptions,
  Logger,
  PresenceEventPackage,
  SoftphoneEngine,
} from '../../types';
import { isMediaError } from '../../errors';
import { SipConnection } from './connection';
import { buildTargetUri, parseAutoAnswer, pickHeaders, parseInfoDtmf, reasonFromCode, sdpIndicatesHold } from './helpers';
import { RemoteAudio } from './remote-audio';
import { parseRtcStats } from './stats';
import { MwiSubscription, isMessageSummaryNotify } from './mwi';
import { PresenceSubscriptions } from './presence';
import { answerMessage, sendSipMessage, toIncomingMessage } from './messaging';
import {
  applyTrackState,
  audioSender,
  referAndWait,
  reinviteHold,
  sendDtmf,
  replaceMicrophoneTrack,
  webSdh,
} from './session-ops';
import {
  CallVideo,
  canSend,
  declineVideoModifier,
  sdpOffersVideo,
  stopVideo,
  swapLocalVideo,
  videoTransceiver,
} from './video';

interface Entry {
  session: Inviter | Invitation;
  established: boolean;
  localTerminate: boolean;
  remoteBye: boolean;
  remoteCancel: boolean;
  mediaError: boolean;
  failCode?: number;
  held: boolean;
  muted: boolean;
  remoteHeld: boolean;
  dtmf: AbortController;
  video: CallVideo;
}


/**
 * SoftphoneEngine on SIP.js 0.21 (UserAgent / Registerer / Inviter /
 * Invitation) over WebSocket + WebRTC, targeting Asterisk PJSIP (webrtc=yes).
 */
export class SipJsEngine implements SoftphoneEngine {
  readonly name = 'sipjs-webrtc';
  private cfg: ResolvedConfig | undefined;
  private listener: EngineListener | undefined;
  private logger: Logger | undefined;
  private connection: SipConnection | undefined;
  private audio: RemoteAudio | undefined;
  private entries = new Map<string, Entry>();
  private inputDeviceId: string | undefined;
  private audioSettings: ResolvedConfig['audioProcessing'] | undefined;
  private processMicrophone: EngineStartOptions['processMicrophone'];
  /** Per session description handler: stops the raw mic and disposes plugin processing. */
  private mediaCleanups = new WeakMap<object, () => void>();
  private cameraDeviceId: string | undefined;
  private outputDeviceId: string | undefined;
  private outputVolume = 1;
  private seq = 0;
  private mwi: MwiSubscription | undefined;
  private presence: PresenceSubscriptions | undefined;

  async start({ config, listener, logger, resume, processMicrophone }: EngineStartOptions): Promise<void> {
    if (this.connection) await this.stop();
    this.cfg = config;
    this.listener = listener;
    this.logger = logger;
    this.audioSettings = config.audioProcessing;
    this.processMicrophone = processMicrophone;
    this.audio = new RemoteAudio(logger.child('audio'));
    if (this.outputDeviceId) await this.audio.setSinkId(this.outputDeviceId);
    this.audio.setVolume(this.outputVolume);
    this.mwi = new MwiSubscription(
      {
        ua: () => (this.connection?.isConnected() ? this.connection.ua : undefined),
        domain: () => this.conn().domain,
        username: () => this.config().username,
        expires: () => this.config().voicemail.expires,
      },
      logger.child('mwi'),
      (summary) => this.listener?.onMessageSummary?.(summary),
    );
    const mwi = this.mwi;
    this.presence = new PresenceSubscriptions(
      {
        ua: () => (this.connection?.isConnected() ? this.connection.ua : undefined),
        domain: () => this.conn().domain,
      },
      logger.child('presence'),
      (update) => this.listener?.onPresence?.(update),
    );
    this.connection = new SipConnection(
      config,
      listener,
      logger.child('connection'),
      (inv) => this.onInvite(inv),
      (notification) => {
        if (!isMessageSummaryNotify(notification)) return false;
        mwi.handleNotify(notification);
        return true;
      },
      (message) => {
        const code = this.listener?.onMessage?.(toIncomingMessage(message)) ?? 200;
        answerMessage(message, code, logger);
      },
      resume,
      (constraints, sdh) => this.captureMedia(constraints, sdh),
    );
    await this.connection.start();
  }

  async stop(): Promise<void> {
    for (const id of [...this.entries.keys()]) await this.hangup(id).catch(() => undefined);
    await this.mwi?.unsubscribe().catch(() => undefined);
    this.mwi = undefined;
    await this.presence?.unsubscribeAll().catch(() => undefined);
    this.presence = undefined;
    const connection = this.connection;
    this.connection = undefined;
    await connection?.stop();
    this.audio?.dispose();
    this.entries.clear();
  }

  register(): Promise<void> {
    return this.conn().register();
  }

  async unregister(): Promise<void> {
    await this.connection?.unregister();
  }

  async subscribeMessageSummary(target?: string): Promise<void> {
    if (!this.mwi) throw new Error('Engine not started');
    await this.mwi.subscribe(target);
  }

  async unsubscribeMessageSummary(): Promise<void> {
    await this.mwi?.unsubscribe();
  }

  async subscribePresence(target: string, event: PresenceEventPackage, expires: number): Promise<void> {
    if (!this.presence) throw new Error('Engine not started');
    await this.presence.subscribe(target, event, expires);
  }

  async unsubscribePresence(target: string, event: PresenceEventPackage): Promise<void> {
    await this.presence?.unsubscribe(target, event);
  }

  async sendMessage(
    target: string,
    body: string,
    options: { contentType: string; messageId: string },
  ): Promise<EngineMessageResult> {
    const conn = this.conn();
    if (!conn.ua || !conn.isConnected()) return { code: 503, reason: 'Not connected to the SIP server' };
    return sendSipMessage(conn.ua, conn.domain, target, body, options, this.logger!.child('chat'));
  }

  async call(engineCallId: string, target: string, options?: { extraHeaders?: string[]; video?: boolean }): Promise<void> {
    const conn = this.conn();
    if (!conn.ua || !conn.isConnected()) throw new Error('Not connected to the SIP server');
    const uri = UserAgent.makeURI(buildTargetUri(target, conn.domain));
    if (!uri) throw new Error(`Invalid call target "${target}"`);
    const inviter = new Inviter(conn.ua, uri, {
      extraHeaders: options?.extraHeaders,
      earlyMedia: this.config().earlyMedia,
      sessionDescriptionHandlerOptions: { constraints: this.constraints(options?.video) } as object,
    });
    const entry = this.track(engineCallId, inviter);
    entry.video.wanted = Boolean(options?.video);
    try {
      await inviter.invite({
        requestDelegate: {
          onProgress: (response) => {
            const code = response.message.statusCode;
            const early = code === 183 && this.config().earlyMedia && Boolean(response.message.body);
            if (code === 180 || code === 183) {
              this.listener?.onCallProgress(engineCallId, { type: early ? 'early-media' : 'ringing' });
            }
          },
          onReject: (response) => {
            entry.failCode = response.message.statusCode;
          },
        },
      });
    } catch (error) {
      if (isMediaError(error)) entry.mediaError = true;
      throw error;
    }
  }

  async answer(engineCallId: string, options?: { video?: boolean }): Promise<void> {
    const entry = this.entry(engineCallId);
    if (!(entry.session instanceof Invitation)) throw new Error('Not an incoming call');
    const offered = sdpOffersVideo(entry.session.request.body);
    const video = Boolean(options?.video) && offered;
    entry.video.wanted = video;
    try {
      await entry.session.accept({
        sessionDescriptionHandlerOptions: { constraints: this.constraints(video) } as object,
        // Audio-only answer to a video offer: decline the video stream (video.ts).
        ...(offered && !video ? { sessionDescriptionHandlerModifiers: [declineVideoModifier] } : {}),
      });
      if (offered && !video) stopVideo(webSdh(entry.session)?.peerConnection);
    } catch (error) {
      if (isMediaError(error)) entry.mediaError = true;
      throw error;
    }
  }

  async reject(engineCallId: string, statusCode = 486): Promise<void> {
    const entry = this.entry(engineCallId);
    if (!(entry.session instanceof Invitation)) throw new Error('Not an incoming call');
    entry.localTerminate = true;
    entry.failCode = statusCode;
    await entry.session.reject({ statusCode });
  }

  async hangup(engineCallId: string): Promise<void> {
    const entry = this.entries.get(engineCallId);
    if (!entry) return;
    entry.localTerminate = true;
    entry.dtmf.abort();
    const { session } = entry;
    switch (session.state) {
      case SessionState.Initial:
      case SessionState.Establishing:
        if (session instanceof Inviter) await session.cancel();
        else await session.reject({ statusCode: 486 });
        return;
      case SessionState.Established:
        await session.bye();
        return;
      default:
        return;
    }
  }

  async setHold(engineCallId: string, hold: boolean): Promise<void> {
    const entry = this.entry(engineCallId);
    if (entry.held === hold) return;
    await reinviteHold(entry.session, hold);
    entry.held = hold;
    applyTrackState(entry.session, entry.held, entry.muted);
    this.reportVideo(engineCallId);
  }

  setMuted(engineCallId: string, muted: boolean): void {
    const entry = this.entries.get(engineCallId);
    if (!entry) return;
    entry.muted = muted;
    applyTrackState(entry.session, entry.held, entry.muted);
  }

  async sendDtmf(engineCallId: string, tones: string): Promise<void> {
    const entry = this.entry(engineCallId);
    await sendDtmf(entry.session, tones, this.config().dtmfMode, entry.dtmf.signal);
  }

  async blindTransfer(engineCallId: string, target: string): Promise<void> {
    const entry = this.entry(engineCallId);
    const uri = UserAgent.makeURI(buildTargetUri(target, this.conn().domain));
    if (!uri) throw new Error(`Invalid transfer target "${target}"`);
    await referAndWait(entry.session, uri);
  }

  async attendedTransfer(engineCallId: string, toEngineCallId: string): Promise<void> {
    // Passing a Session makes SIP.js build Refer-To with Replaces=<dialog of the consult call>.
    await referAndWait(this.entry(engineCallId).session, this.entry(toEngineCallId).session);
  }

  async forward(engineCallId: string, target: string): Promise<void> {
    const entry = this.entry(engineCallId);
    if (!(entry.session instanceof Invitation)) throw new Error('Not an incoming call');
    const contact = buildTargetUri(target, this.conn().domain);
    entry.localTerminate = true;
    entry.failCode = 302;
    await entry.session.reject({ statusCode: 302, extraHeaders: [`Contact: <${contact}>`] });
  }

  // ------------------------------------------------------------------ video (V2-VID-01)

  getVideoStreams(engineCallId: string): CallVideoStreams {
    const entry = this.entries.get(engineCallId);
    return entry ? entry.video.getStreams(entry.session) : {};
  }

  async setVideo(engineCallId: string, on: boolean): Promise<void> {
    const entry = this.entry(engineCallId);
    const sdh = webSdh(entry.session);
    const pc = sdh?.peerConnection;
    if (!entry.established || !sdh || !pc) throw new Error('Call has no media yet');
    entry.video.wanted = on;
    let tx = videoTransceiver(pc);
    if (!on) {
      const track = tx?.sender.track;
      if (tx && track) await tx.sender.replaceTrack(null);
      swapLocalVideo(entry.session, undefined);
      track?.stop();
      this.reportVideo(engineCallId);
      return;
    }
    const track = await this.openCamera();
    track.enabled = !entry.held;
    try {
      if (tx && canSend(tx)) {
        // Negotiated and allowed to send: just swap the track (no re-INVITE).
        const old = tx.sender.track;
        await tx.sender.replaceTrack(track);
        swapLocalVideo(entry.session, track);
        if (old && old !== track) old.stop();
        this.reportVideo(engineCallId);
        return;
      }
      if (tx) {
        await tx.sender.replaceTrack(track);
        tx.direction = 'sendrecv';
      } else {
        pc.addTrack(track, sdh.localMediaStream);
        tx = videoTransceiver(pc);
      }
      swapLocalVideo(entry.session, track);
      // One re-INVITE adds (or re-opens) the video stream; keeps the hold state.
      await reinviteHold(entry.session, entry.held);
    } catch (error) {
      track.stop();
      if (tx?.sender.track === track) await tx.sender.replaceTrack(null).catch(() => undefined);
      swapLocalVideo(entry.session, undefined);
      entry.video.wanted = false;
      this.reportVideo(engineCallId);
      throw error;
    }
    this.reportVideo(engineCallId);
  }

  async setVideoDevice(deviceId: string): Promise<void> {
    this.cameraDeviceId = deviceId;
    for (const [id, entry] of this.entries) {
      const tx = videoTransceiver(webSdh(entry.session)?.peerConnection);
      const old = tx?.sender.track;
      if (!tx || !old || old.readyState !== 'live') continue;
      try {
        const track = await this.openCamera();
        track.enabled = old.enabled;
        await tx.sender.replaceTrack(track);
        swapLocalVideo(entry.session, track);
        old.stop();
        this.reportVideo(id);
      } catch (error) {
        this.logger?.warn('Switching camera failed', error);
      }
    }
  }

  private async openCamera(): Promise<MediaStreamTrack> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) throw new Error('Media devices unavailable');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: this.videoConstraints() });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('No camera track');
    return track;
  }

  /** Report changed video facts for a call to the orchestrator. */
  private reportVideo(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const state = entry.video.update(entry.session, entry.held);
    if (state) this.listener?.onCallVideo?.(id, state);
  }

  getMediaStreams(engineCallId: string): { local?: MediaStream; remote?: MediaStream } {
    const entry = this.entries.get(engineCallId);
    const sdh = entry ? webSdh(entry.session) : undefined;
    return sdh ? { local: sdh.localMediaStream, remote: sdh.remoteMediaStream } : {};
  }

  async replaceOutgoingTrack(engineCallId: string, track: MediaStreamTrack): Promise<void> {
    const sender = audioSender(this.entry(engineCallId).session);
    if (!sender) throw new Error('No audio sender on this call');
    await sender.replaceTrack(track);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    await this.audio?.setSinkId(deviceId);
  }

  setOutputVolume(volume: number): void {
    this.outputVolume = volume;
    this.audio?.setVolume(volume);
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.inputDeviceId = deviceId;
    await this.refreshMicrophones();
  }

  async setAudioProcessing(settings: ResolvedConfig['audioProcessing']): Promise<void> {
    this.audioSettings = settings;
    await this.refreshMicrophones();
  }

  /** Re-capture the mic on every established call with the current device and voice processing. */
  private async refreshMicrophones(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (!entry.established) continue;
      const sdh = webSdh(entry.session);
      if (!sdh) continue;
      try {
        const stream = await this.captureMedia({ audio: this.audioConstraints(), video: false }, sdh);
        const track = stream.getAudioTracks()[0];
        if (track) await replaceMicrophoneTrack(entry.session, track, !entry.held && !entry.muted);
      } catch (error) {
        this.logger?.warn('Switching microphone failed', error);
      }
    }
  }

  /**
   * Media for a call: getUserMedia with the configured voice processing, then plugin
   * processing (noise removal). Raw mic tracks that SIP.js does not own are stopped
   * when the call ends or the mic is captured again.
   */
  private async captureMedia(constraints: MediaStreamConstraints, sdh: object): Promise<MediaStream> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) throw new Error('Media devices are not available');
    if (!constraints.audio && !constraints.video) return new MediaStream();
    const raw = await navigator.mediaDevices.getUserMedia(constraints);
    const previous = this.mediaCleanups.get(sdh);
    this.mediaCleanups.delete(sdh);
    const audio = raw.getAudioTracks();
    if (!this.processMicrophone || !audio.length) {
      previous?.();
      return raw;
    }
    const input = new MediaStream(audio);
    const { stream, dispose } = await this.processMicrophone(input);
    if (stream === input) {
      dispose();
      previous?.();
      return raw;
    }
    previous?.();
    this.mediaCleanups.set(sdh, () => {
      for (const t of audio) t.stop();
      dispose();
    });
    return new MediaStream([...stream.getAudioTracks(), ...raw.getVideoTracks()]);
  }

  private releaseMedia(session: Session): void {
    const sdh = webSdh(session);
    if (!sdh) return;
    this.mediaCleanups.get(sdh)?.();
    this.mediaCleanups.delete(sdh);
  }

  async getCallStats(engineCallId: string): Promise<EngineCallStats | undefined> {
    const entry = this.entries.get(engineCallId);
    const pc = entry?.established ? webSdh(entry.session)?.peerConnection : undefined;
    if (!pc || pc.connectionState === 'closed') return undefined;
    return parseRtcStats(await pc.getStats());
  }

  // ------------------------------------------------------------------ internals

  private onInvite(invitation: Invitation): void {
    const id = `sip-in-${++this.seq}`;
    this.track(id, invitation);
    const identity = invitation.remoteIdentity;
    const request = invitation.request;
    const info: EngineCallInfo = {
      sipCallId: request.callId,
      remoteNumber: identity.uri.user ?? identity.uri.host,
      remoteDisplayName: identity.displayName || undefined,
      autoAnswerDelay: parseAutoAnswer((name) => request.getHeader(name)),
      video: sdpOffersVideo(request.body),
    };
    const pushId = request.getHeader('X-Sipkit-Push-Id')?.trim();
    if (pushId) info.pushId = pushId.slice(0, 128);
    // Reload-safe calls (docs/resume.md): the PBX anchored this call in a room we can rejoin.
    const anchorId = request.getHeader('X-Sipkit-Anchor')?.trim();
    if (anchorId && /^\d{6,32}$/.test(anchorId)) info.anchorId = anchorId;
    const headers = pickHeaders(this.config().inviteHeaders, (name) => request.getHeader(name));
    if (headers) info.inviteHeaders = headers;
    this.listener?.onIncomingCall(id, info);
  }

  /** Register an entry and wire SIP.js delegates/state to EngineListener callbacks. */
  private track(id: string, session: Inviter | Invitation): Entry {
    const entry: Entry = {
      session,
      established: false,
      localTerminate: false,
      remoteBye: false,
      remoteCancel: false,
      mediaError: false,
      held: false,
      muted: false,
      remoteHeld: false,
      dtmf: new AbortController(),
      video: new CallVideo(() => this.reportVideo(id)),
    };
    this.entries.set(id, entry);
    session.delegate = {
      onBye: () => {
        entry.remoteBye = true;
      },
      onCancel: () => {
        entry.remoteCancel = true;
      },
      onInfo: (info) => {
        const digit = parseInfoDtmf(info.request.body, info.request.getHeader('Content-Type'));
        info.accept().catch(() => undefined);
        if (digit) this.listener?.onDtmf(id, digit);
      },
      onInvite: (request) => {
        // A remote re-INVITE may add/remove video (answered by SIP.js already).
        queueMicrotask(() => this.reportVideo(id));
        const held = sdpIndicatesHold(request.body);
        if (held === undefined || held === entry.remoteHeld) return;
        entry.remoteHeld = held;
        this.listener?.onCallProgress(id, { type: 'remote-hold', held });
      },
      onSessionDescriptionHandler: () => this.playRemote(id, session),
    };
    session.stateChange.addListener((state) => {
      if (state === SessionState.Established) {
        entry.established = true;
        this.playRemote(id, session);
        this.reportVideo(id);
        this.listener?.onCallProgress(id, { type: 'connected', sipCallId: session.dialog?.callId });
      } else if (state === SessionState.Terminated) {
        entry.dtmf.abort();
        this.audio?.detach(id);
        this.releaseMedia(session);
        this.entries.delete(id);
        // SIP.js transitions to Terminated *before* invoking requestDelegate.onReject
        // (Inviter.onReject → stateTransition, then the delegate), so the final
        // status code isn't known yet. A getUserMedia failure also terminates the
        // session before invite()/accept() rejects, so mediaError is only set a few
        // microtasks later. Classify on the next macrotask, after both have run.
        setTimeout(() => {
          const { reason, code } = this.endReason(entry);
          this.listener?.onCallProgress(id, { type: 'ended', reason, code });
        }, 0);
      }
    });
    return entry;
  }

  /** Attach remote audio (also used for 183 early media) and re-attach on late tracks. */
  private playRemote(id: string, session: Session): void {
    const sdh = webSdh(session);
    if (!sdh || !this.audio) return;
    this.audio.attach(id, sdh.remoteMediaStream);
    sdh.peerConnectionDelegate = {
      ontrack: () => {
        this.audio?.attach(id, sdh.remoteMediaStream);
        this.reportVideo(id);
      },
      onsignalingstatechange: () => {
        if (sdh.peerConnection?.signalingState === 'stable') this.reportVideo(id);
      },
    };
  }

  private endReason(entry: Entry): { reason: DisconnectReason; code?: number } {
    if (entry.mediaError) return { reason: 'media-error' };
    if (entry.localTerminate) {
      if (entry.established) return { reason: 'local-hangup' };
      if (entry.failCode === 302) return { reason: 'transferred', code: 302 };
      return entry.session instanceof Inviter ? { reason: 'cancelled' } : { reason: 'rejected', code: entry.failCode };
    }
    if (entry.remoteBye || entry.established) return { reason: 'remote-hangup' };
    if (entry.remoteCancel) return { reason: 'cancelled' };
    if (entry.failCode) return { reason: reasonFromCode(entry.failCode), code: entry.failCode };
    return { reason: 'failed' };
  }

  private constraints(video = false): MediaStreamConstraints {
    return {
      audio: this.audioConstraints(),
      video: video ? this.videoConstraints() : false,
    };
  }

  /** Selected mic plus the browser's voice processing (config `audioProcessing`). */
  private audioConstraints(): MediaTrackConstraints {
    const ap = this.audioSettings ?? this.cfg?.audioProcessing;
    const c: MediaTrackConstraints & { voiceIsolation?: boolean } = {};
    if (this.inputDeviceId) c.deviceId = { exact: this.inputDeviceId };
    if (ap) {
      c.echoCancellation = ap.echoCancellation;
      c.noiseSuppression = ap.noiseSuppression;
      c.autoGainControl = ap.autoGainControl;
      // Non-standard (Chrome); only sent when wanted so other browsers never see it.
      if (ap.voiceIsolation) c.voiceIsolation = true;
    }
    return c;
  }

  /** Configured video constraints plus the selected camera. */
  private videoConstraints(): MediaTrackConstraints | true {
    const base = (this.cfg?.video.constraints ?? {}) as MediaTrackConstraints;
    const constraints: MediaTrackConstraints = this.cameraDeviceId
      ? { ...base, deviceId: { exact: this.cameraDeviceId } }
      : { ...base };
    return Object.keys(constraints).length ? constraints : true;
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown call ${id}`);
    return entry;
  }

  private conn(): SipConnection {
    if (!this.connection) throw new Error('Engine not started');
    return this.connection;
  }

  private config(): ResolvedConfig {
    if (!this.cfg) throw new Error('Engine not started');
    return this.cfg;
  }
}
