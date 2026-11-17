/**
 * Public domain model and contracts for the softphone.
 *
 * This file is the single source of truth shared by the engine, the React
 * bindings and the UI library. Change it with care: every package depends
 * on it.
 */

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export type RegistrationState =
  | 'idle' // never attempted / stopped
  | 'connecting' // transport (WebSocket) connecting
  | 'registering'
  | 'registered'
  | 'unregistered'
  | 'failed';

export interface RegistrationStatus {
  state: RegistrationState;
  /** Human readable failure reason (only set when state === 'failed'). */
  reason?: string;
  /** SIP status code that caused a failure, when known (e.g. 401, 403, 408). */
  code?: number;
}

// ---------------------------------------------------------------------------
// Calls / lines
// ---------------------------------------------------------------------------

export type CallDirection = 'outgoing' | 'incoming';

export type CallState =
  | 'setup' // outgoing: INVITE sent / incoming: received, not yet ringing locally
  | 'ringing' // remote ringing (outgoing) or local ringing (incoming)
  | 'early' // early media playing (183 Session Progress)
  | 'connected'
  | 'held' // locally held
  | 'disconnected';

export type HoldState = 'none' | 'local' | 'remote' | 'both';

export type DisconnectReason =
  | 'local-hangup'
  | 'remote-hangup'
  | 'rejected'
  | 'busy'
  | 'no-answer'
  | 'cancelled'
  | 'transferred'
  | 'failed'
  | 'media-error'
  /** Incoming call rejected automatically because Do Not Disturb was on. */
  | 'dnd';

/** A unique, stable identifier for a call inside this client (not the SIP Call-ID). */
export type CallId = string;

export interface Call {
  id: CallId;
  /** Line number (1-based), as shown to the user. */
  line: number;
  /** SIP Call-ID header, once known. */
  sipCallId?: string;
  direction: CallDirection;
  state: CallState;
  /** Remote party user/number (e.g. "1002"). */
  remoteNumber: string;
  remoteDisplayName?: string;
  muted: boolean;
  hold: HoldState;
  /** Epoch ms when the call was created / connected / ended. */
  createdAt: number;
  connectedAt?: number;
  endedAt?: number;
  disconnectReason?: DisconnectReason;
  /** SIP status code that ended the call, if applicable. */
  disconnectCode?: number;
  /**
   * True while this call is part of a conference: a member of the local mix,
   * or your own leg into a server-side room (then {@link Call.conference} is set).
   */
  inConference: boolean;
  /**
   * Server conference mode only: set on your own leg into the PBX conference
   * room. Holds the roster the client knows about (the parties it transferred
   * in) and what the UI may offer. See `getConferenceView()`.
   */
  conference?: ServerConference;
  /**
   * Conference only: this party's audio is silenced for everyone (you and the
   * other parties). Absent/false = audible. Cleared when the call leaves the conference.
   */
  partyMuted?: boolean;
  /** Free-form per-call data plugins may attach (e.g. CRM lookup result). */
  meta: Record<string, unknown>;
  /** Latest media quality sample while connected (see `callQualityInterval`). */
  quality?: CallQuality;
  /**
   * Video (V2-VID-01, config `video.enabled`). The call carries a video stream;
   * while an incoming call rings: the caller offers video. Absent = audio only.
   */
  hasVideo?: boolean;
  /** Our camera is being sent. */
  cameraOn?: boolean;
  /** The remote party is sending video (negotiated, track live and, with quality monitoring, RTP flowing). */
  remoteVideo?: boolean;
  /**
   * Incoming only (V2-PUSH-01): PBX call id from the `X-Sipkit-Push-Id` INVITE header,
   * the same id the push notification carried. Absent when the PBX sends none.
   */
  pushId?: string;
  /**
   * Incoming only: the INVITE headers named in config `inviteHeaders`, by lower-cased name. Absent when
   * none of them was present.
   */
  inviteHeaders?: Record<string, string>;
  /**
   * Reload-safe calls (config `resume`, docs/resume.md): id of the PBX anchor
   * room this call lives in. Set on answered / placed calls while resume is on.
   */
  anchorId?: string;
  /**
   * True while a call restored after a page reload is rejoining its anchor room
   * (the UI shows "Reconnecting call…"). Cleared on `call:resumed`.
   */
  resuming?: boolean;
}

/** Reload-safe softphone state on the snapshot (config `resume`, docs/resume.md). */
export interface ResumeState {
  /**
   * 'idle': nothing to restore. 'resuming': restoring after a reload (registering
   * again, rejoining calls); UIs show "Reconnecting" instead of "Offline".
   */
  state: 'idle' | 'resuming';
  /** Calls still rejoining their anchor rooms. */
  pendingCalls: number;
}

/** One call in a persisted resume descriptor (sessionStorage). */
export interface ResumeCallDescriptor {
  id: CallId;
  anchorId: string;
  line: number;
  direction: CallDirection;
  remoteNumber: string;
  remoteDisplayName?: string;
  createdAt: number;
  connectedAt?: number;
  muted: boolean;
  held: boolean;
  sipCallId?: string;
  inviteHeaders?: Record<string, string>;
  pushId?: string;
}

/** What the softphone persists to survive a reload (`exportResumeState()` / `resume()`). */
export interface ResumeSnapshot {
  version: 1;
  /** Epoch ms when this was last written (the page may have gone right after). */
  savedAt: number;
  /** The account the calls belong to; ignored for another username. */
  username: string;
  activeCallId: CallId | null;
  calls: ResumeCallDescriptor[];
}

/** What the current conference supports. UIs check these instead of the conference mode. */
export interface ConferenceCapabilities {
  /** Silence one party for everyone (`setPartyMuted`). */
  partyMute: boolean;
  /** Take one party out but keep its call (`removeFromConference`). */
  removeParty: boolean;
  /** Hang up one party (`hangup(party call id)`). */
  hangupParty: boolean;
  /** Give every party its own line again (`splitConference`). */
  split: boolean;
  /** The other parties stay connected after you hang up. */
  survivesLeave: boolean;
}

/** A party in a server-side conference room, as known to this client. */
export interface ConferenceParticipant {
  /** Stable id (the id of the call that was transferred into the room). */
  id: string;
  remoteNumber: string;
  remoteDisplayName?: string;
  /** Epoch ms when the party was transferred into the room. */
  joinedAt: number;
}

/** Server conference details on your own room leg ({@link Call.conference}). */
export interface ServerConference {
  /** Extension dialled to reach the room, e.g. "71001". */
  room: string;
  participants: ConferenceParticipant[];
  capabilities: ConferenceCapabilities;
}

/** Call detail record emitted once per finished call. */
export interface Cdr {
  callId: CallId;
  sipCallId?: string;
  line: number;
  direction: CallDirection;
  caller: string;
  called: string;
  remoteDisplayName?: string;
  startedAt: number;
  connectedAt?: number;
  endedAt: number;
  /** Talk time in ms (0 if never connected). */
  durationMs: number;
  reason: DisconnectReason;
  code?: number;
  /** End-of-call media quality summary, when at least one quality sample was taken. */
  quality?: CallQualitySummary;
}

// ---------------------------------------------------------------------------
// Call quality (V2-QOS-01)
// ---------------------------------------------------------------------------

/** Coarse quality bucket derived from the MOS estimate (with hysteresis). */
export type QualityLevel = 'good' | 'fair' | 'poor';

/** Per-direction metrics for one sampling interval. Fields are absent when unknown. */
export interface CallQualityStream {
  /** Packet loss over the last interval, 0..100. Outbound loss comes from the remote RTCP report. */
  packetLossPct?: number;
  /** Interarrival jitter in ms (outbound: as reported by the remote end). */
  jitterMs?: number;
  /** Average RTP bitrate over the last interval, kbit/s. */
  bitrateKbps?: number;
}

/** One periodic call quality sample. */
export interface CallQuality {
  /** Epoch ms of the sample. */
  at: number;
  /** Smoothed level (degrades immediately, recovers after consecutive good samples). */
  level: QualityLevel;
  /** E-model (ITU-T G.107, simplified) MOS estimate for this interval, 1..4.5. Uses the worse direction. */
  mos: number;
  /** Round-trip time in ms (RTCP or ICE candidate pair). */
  rttMs?: number;
  /** Audio codec name, lower case (e.g. "opus", "pcmu"). */
  codec?: string;
  /** Media we receive. */
  inbound: CallQualityStream;
  /** Media we send. */
  outbound: CallQualityStream;
  /** Cumulative RTP counters since the call connected. */
  totals: { packetsSent: number; packetsReceived: number; packetsLost: number };
  /** Video streams of a video call (never affects `mos` / `level`). */
  video?: CallVideoQuality;
  /**
   * Set when no audio packets moved during this interval: `'receive'` (nothing arrives),
   * `'send'` (nothing leaves) or `'both'`. Usually a network that blocks UDP or a PBX that
   * advertises an unreachable address. `mos` is 1 and `level` is `'poor'` while it lasts.
   */
  noAudio?: 'receive' | 'send' | 'both';
}

/** Per-direction video metrics for one sampling interval. */
export interface CallVideoQualityStream {
  bitrateKbps?: number;
  packetLossPct?: number;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
}

/** Video part of a {@link CallQuality} sample (V2-VID-01). */
export interface CallVideoQuality {
  /** Video codec name, lower case (e.g. "vp8", "h264"). */
  codec?: string;
  inbound: CallVideoQualityStream;
  outbound: CallVideoQualityStream;
}

/** End-of-call aggregate attached to {@link Cdr.quality}. Loss/jitter use the worse direction per sample. */
export interface CallQualitySummary {
  samples: number;
  avgLossPct?: number;
  maxLossPct?: number;
  avgJitterMs?: number;
  maxJitterMs?: number;
  avgRttMs?: number;
  maxRttMs?: number;
  avgMos: number;
  minMos: number;
  /** Worst smoothed level seen during the call. */
  worstLevel: QualityLevel;
  codec?: string;
}

/**
 * Raw, engine-agnostic RTP statistics for one call (cumulative counters).
 * Engines translate their native stats (e.g. WebRTC `getStats()`) into this.
 */
export interface EngineCallStats {
  /** Sample time, epoch ms. */
  timestamp: number;
  /** Our receive stream (WebRTC inbound-rtp). */
  inbound?: {
    packetsReceived: number;
    packetsLost: number;
    bytesReceived?: number;
    jitterMs?: number;
    codec?: string;
  };
  /** Our send stream (WebRTC outbound-rtp). */
  outbound?: { packetsSent: number; bytesSent?: number; codec?: string };
  /** The remote end's receiver report about our send stream (WebRTC remote-inbound-rtp). */
  remoteInbound?: {
    packetsLost?: number;
    jitterMs?: number;
    /** Fraction lost since the previous report, 0..1. */
    fractionLost?: number;
    rttMs?: number;
  };
  /** Transport round-trip time in ms (e.g. selected ICE candidate pair). */
  rttMs?: number;
  /** Video RTP counters (video calls only). */
  video?: {
    inbound?: {
      packetsReceived: number;
      packetsLost: number;
      bytesReceived?: number;
      framesPerSecond?: number;
      frameWidth?: number;
      frameHeight?: number;
      codec?: string;
    };
    outbound?: {
      packetsSent: number;
      bytesSent?: number;
      framesPerSecond?: number;
      frameWidth?: number;
      frameHeight?: number;
      codec?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Video (V2-VID-01)
// ---------------------------------------------------------------------------

/** Options for {@link SoftphoneApi.call}. */
export interface CallOptions {
  /** Place a video call. Default: `video.enabled && video.defaultOn`. */
  video?: boolean;
}

/** Options for {@link SoftphoneApi.answer}. */
export interface AnswerOptions {
  /** Answer an incoming video call with our camera. Default: `video.defaultOn`. Ignored for audio-only offers. */
  video?: boolean;
}

/**
 * Live video MediaStreams of a call (video tracks only; audio plays through
 * the engine). Kept out of the snapshot because MediaStreams are not serialisable.
 * The same stream objects are returned for the life of a call; listen to
 * `call:video` to learn when their tracks change.
 */
export interface CallVideoStreams {
  /** Our camera (for a local preview). Absent while the camera is off. */
  local?: MediaStream;
  /** The remote party's video. */
  remote?: MediaStream;
}

/** Video facts an engine reports for a call. */
export interface EngineVideoState {
  hasVideo: boolean;
  cameraOn: boolean;
  remoteVideo: boolean;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** Media device kinds. 'camera' (video input) is used by video calls (V2-VID-01). */
export type AudioDeviceKind = 'microphone' | 'speaker' | 'ringer' | 'camera';

export interface AudioDevice {
  id: string;
  label: string;
  kind: AudioDeviceKind;
}

// ---------------------------------------------------------------------------
// Voicemail / message waiting indication (RFC 3842 message-summary)
// ---------------------------------------------------------------------------

/** Parsed `application/simple-message-summary` body (voice messages only). */
export interface MessageSummary {
  /** `Messages-Waiting: yes` */
  waiting: boolean;
  /** New (unheard) voice messages. */
  new: number;
  /** Old (heard) voice messages. */
  old: number;
  /** Urgent subset of `new` / `old`, when the server reports it. */
  urgentNew: number;
  urgentOld: number;
  /** `Message-Account` URI, e.g. "sip:*97@pbx.example.com" (the voicemail access number on Asterisk). */
  account?: string;
}

/** Voicemail state on the snapshot. All zero until the first NOTIFY (or when voicemail is disabled). */
export type VoicemailState = MessageSummary;

// ---------------------------------------------------------------------------
// Presence / busy lamp field (V2-PRES-01, V2-BLF-01)
// ---------------------------------------------------------------------------

/**
 * Normalised state of a watched extension:
 * - `idle`: registered, no call
 * - `ringing`: an incoming call is ringing there (pick it up with `pickup()`)
 * - `busy`: on a call (or dialing out)
 * - `held`: every call there is on hold (when the server reports it)
 * - `unavailable`: not registered / offline (PIDF `closed`)
 * - `unknown`: not subscribed yet, or the server refused (403/404/489...)
 */
export type PresenceState = 'idle' | 'ringing' | 'busy' | 'held' | 'unavailable' | 'unknown';

/** SIP event package used for a presence subscription. */
export type PresenceEventPackage = 'dialog' | 'presence';

/** What one NOTIFY (or a subscription failure) says about an extension. */
export interface PresenceReport {
  state: PresenceState;
  /** The other party of a ringing/active call, when the server tells us (dialog-info `<remote>`). */
  remoteNumber?: string;
  remoteDisplayName?: string;
  /** Direction of the reported call from the watched extension's point of view. */
  direction?: 'incoming' | 'outgoing';
  /** Free-form status text (PIDF `<note>`), e.g. "On the phone". */
  note?: string;
}

/** Presence of one watched extension on the snapshot. */
export interface PresenceInfo extends PresenceReport {
  /** The watched extension / URI as passed to `watch()`. */
  target: string;
  /** Epoch ms of the last change. */
  updatedAt: number;
  /** SIP status of the last failed SUBSCRIBE (state is then `unknown`). */
  errorCode?: number;
}

/** Engine → orchestrator: a presence NOTIFY or a subscription state change. */
export interface EnginePresenceUpdate {
  target: string;
  event: PresenceEventPackage;
  /** Parsed NOTIFY body. Absent when only the subscription ended. */
  report?: PresenceReport;
  /** The subscription ended (rejected, timed out, terminated by the server). */
  terminated?: boolean;
  /** SIP status of the failure (403, 404, 489...), when known. */
  code?: number;
}

// ---------------------------------------------------------------------------
// Snapshot of the whole softphone state (what UIs render from)
// ---------------------------------------------------------------------------

export type AppState = 'loading' | 'ready' | 'started' | 'stopped' | 'error';

export interface SoftphoneSnapshot {
  app: AppState;
  registration: RegistrationStatus;
  calls: Call[];
  /** Id of the call the user is currently interacting with. */
  activeCallId: CallId | null;
  devices: {
    available: AudioDevice[];
    selected: Partial<Record<AudioDeviceKind, string>>;
    /** Per-kind volume 0..1 set via setVolume (absent = 1). 0 mutes playback/ringing. */
    volume?: Partial<Record<AudioDeviceKind, number>>;
  };
  /** Name of the engine in use, e.g. "sipjs-webrtc". */
  engine: string;
  /** Message waiting indication (config `voicemail.enabled`). */
  voicemail: VoicemailState;
  /** Do Not Disturb: incoming calls are rejected automatically (config `dnd`). */
  dnd: boolean;
  /** Server-side DND (config `dnd.mode`): a feature-code call is applying `dnd` right now. */
  dndPending?: boolean;
  /** Watched extensions keyed by target (config `presence`). Empty when presence is off. */
  presence: Record<string, PresenceInfo>;
  /** 1:1 chat conversations (config `chat.enabled`; empty while disabled). */
  chat: ChatState;
  /** Voicemail list (V2-VM-02, config `voicemail.api`); status `disabled` while off. Optional for other implementations. */
  voicemailList?: VoicemailListState;
  /** Web Push for incoming calls (config `push`, V2-PUSH-01). Optional so other implementations keep compiling. */
  push?: PushState;
  /** Reload-safe softphone (config `resume`, V2-RESUME-01). Optional so other implementations keep compiling. */
  resume?: ResumeState;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A user-facing message. `title`/`message` are English; UIs translate by `code` + `params`. */
export interface SoftphoneNotification {
  level: 'info' | 'warning' | 'error';
  title: string;
  message?: string;
  /** Stable id for translation, e.g. 'missedCall', 'registrationFailed', 'conferenceMixingUnavailable'. */
  code?: string;
  /** Values for the translated message (e.g. `{ from, reason }`). */
  params?: Record<string, string | number>;
}

export interface SoftphoneEvents {
  'app:state': { state: AppState };
  'registration:state': RegistrationStatus;
  'call:created': { call: Call };
  'call:updated': { call: Call; previous: Call };
  'call:ended': { call: Call };
  'call:dtmf-received': { callId: CallId; digit: string };
  /** Periodic media quality sample for a connected call (every `callQualityInterval` seconds). */
  'call:quality': { callId: CallId; quality: CallQuality };
  cdr: Cdr;
  /** A message that should be shown to the end user (toast). */
  notification: SoftphoneNotification;
  log: LogEntry;
  'state:changed': { snapshot: SoftphoneSnapshot };
  /** Voicemail counts changed (message-summary NOTIFY). */
  'voicemail:updated': { voicemail: VoicemailState; previous: VoicemailState };
  /** The voicemail list (V2-VM-02) changed: loaded, marked read, deleted, failed. */
  'voicemail:list': { list: VoicemailListState };
  'dnd:changed': { dnd: boolean };
  /** A watched extension changed state (or was added / removed: `presence` undefined). */
  'presence:changed': { target: string; presence?: PresenceInfo; previous?: PresenceInfo };
  /** A chat message (SIP MESSAGE) arrived. */
  'message:received': { message: ChatMessage; conversation: ChatConversation };
  /** An outgoing chat message was created (`previous` undefined) or changed status (sent / failed). */
  'message:status': { message: ChatMessage; previous: ChatMessageStatus | undefined };
  /** A conversation's unread count was cleared. */
  'conversation:read': { peer: string };
  /** A call's video state or video streams changed (V2-VID-01). Re-read `getVideoStreams()`. */
  'call:video': { callId: CallId; hasVideo: boolean; cameraOn: boolean; remoteVideo: boolean };
  /** Push state changed: permission, subscription, pending notification click (V2-PUSH-01). */
  'push:changed': { push: PushState };
  /**
   * The agent clicked a call notification (deep link or service worker message):
   * emitted when the click arrives (`callId` undefined) and again when it is
   * matched to the ringing call (`callId` set; answered when `launch.action` is 'answer').
   */
  'push:action': { launch: PushLaunch; callId?: CallId };
  /**
   * Reload-safe softphone (V2-RESUME-01): the page came back with something to
   * restore and is registering again / rejoining `calls`. Followed by
   * `call:resumed` (or `call:ended`) per call.
   */
  'registration:resuming': { calls: CallId[] };
  /** A call restored after a reload is talking again (same id, original start time). */
  'call:resumed': { call: Call };
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
  at: number;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(scope: string): Logger;
}

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Engine contract — implemented by SIP.js (WebRTC), fakes for tests, and in
// the future native/desktop engines. The Softphone orchestrator owns state;
// engines only translate commands <-> signalling/media and report facts.
// ---------------------------------------------------------------------------

export interface EngineCallInfo {
  sipCallId?: string;
  remoteNumber: string;
  remoteDisplayName?: string;
  /**
   * Set when the INVITE asked to be auto-answered (Call-Info answer-after,
   * Alert-Info auto-answer, Answer-Mode, X-P-Auto-Answer...). Seconds to wait
   * before answering (0 = immediately). Honoured when `autoAnswerOnHeader`.
   */
  autoAnswerDelay?: number;
  /** The INVITE offers a video stream. */
  video?: boolean;
  /** `X-Sipkit-Push-Id` header: PBX call id of a push notification (V2-PUSH-01). */
  pushId?: string;
  /** Values of the INVITE headers named in config `inviteHeaders` (lower-cased names). */
  inviteHeaders?: Record<string, string>;
  /** `X-Sipkit-Anchor` header: the PBX anchored this call for reload safety (docs/resume.md). */
  anchorId?: string;
}

export interface EngineListener {
  onTransportState(state: 'connecting' | 'connected' | 'disconnected', reason?: string): void;
  onRegistration(status: RegistrationStatus): void;
  /** A new incoming call. The engine assigns `engineCallId`. */
  onIncomingCall(engineCallId: string, info: EngineCallInfo): void;
  onCallProgress(
    engineCallId: string,
    progress:
      | { type: 'ringing' }
      | { type: 'early-media' }
      | { type: 'connected'; sipCallId?: string }
      | { type: 'remote-hold'; held: boolean }
      | { type: 'ended'; reason: DisconnectReason; code?: number },
  ): void;
  onDtmf(engineCallId: string, digit: string): void;
  /**
   * A message-summary (RFC 3842) NOTIFY arrived, from a subscription or
   * unsolicited. Engines without MWI support never call it.
   */
  onMessageSummary?(summary: MessageSummary): void;
  /** A presence/dialog NOTIFY arrived or a presence subscription ended. */
  onPresence?(update: EnginePresenceUpdate): void;
  /**
   * An out-of-dialog MESSAGE arrived. Returns the SIP status to answer with
   * (default 200). Engines without chat support never call it.
   */
  onMessage?(message: EngineIncomingMessage): number | void;
  /** Video state or video tracks of a call changed (engines with video support). */
  onCallVideo?(engineCallId: string, state: EngineVideoState): void;
}

export interface EngineStartOptions {
  config: ResolvedConfig;
  listener: EngineListener;
  logger: Logger;
  /**
   * Reload-safe softphone (config `resume.enabled`, docs/resume.md). Engines that
   * register should use `instanceId` as a stable `+sip.instance` (RFC 5626) and
   * advertise `rejoinTimeoutSec` to the PBX (SIP.js: Contact `;sipkit-resume=<s>`).
   */
  resume?: { instanceId: string; rejoinTimeoutSec: number };
}

export interface SoftphoneEngine {
  readonly name: string;
  start(options: EngineStartOptions): Promise<void>;
  stop(): Promise<void>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  /** Place an outgoing call to an already-normalized SIP target (user or URI). */
  call(engineCallId: string, target: string, options?: { extraHeaders?: string[]; video?: boolean }): Promise<void>;
  answer(engineCallId: string, options?: { video?: boolean }): Promise<void>;
  /** Reject an incoming unanswered call with a SIP status (default 486 Busy Here). */
  reject(engineCallId: string, statusCode?: number): Promise<void>;
  hangup(engineCallId: string): Promise<void>;
  setHold(engineCallId: string, hold: boolean): Promise<void>;
  setMuted(engineCallId: string, muted: boolean): void;
  sendDtmf(engineCallId: string, tones: string): Promise<void>;
  /** Blind transfer (REFER). */
  blindTransfer(engineCallId: string, target: string): Promise<void>;
  /** Attended transfer: REFER `engineCallId` with Replaces pointing at `toEngineCallId`. */
  attendedTransfer(engineCallId: string, toEngineCallId: string): Promise<void>;
  /** Redirect an unanswered incoming call (302). */
  forward?(engineCallId: string, target: string): Promise<void>;
  /** Remote/local media streams, for conference mixing and playback. */
  getMediaStreams(engineCallId: string): { local?: MediaStream; remote?: MediaStream };
  /** Replace the outgoing audio track (device change, conference mix). */
  replaceOutgoingTrack?(engineCallId: string, track: MediaStreamTrack): Promise<void>;
  setOutputDevice?(deviceId: string): Promise<void>;
  /** Remote audio playback volume 0..1 (0 = muted). */
  setOutputVolume?(volume: number): void;
  setInputDevice?(deviceId: string): Promise<void>;
  /** Raw RTP statistics for a call, or undefined when there is no media yet. Enables call quality monitoring. */
  getCallStats?(engineCallId: string): Promise<EngineCallStats | undefined>;
  /**
   * Subscribe to the `message-summary` event package for `target` (a user or
   * SIP URI; default: the own AOR). Replaces an existing subscription.
   * NOTIFYs are reported through `EngineListener.onMessageSummary`.
   */
  subscribeMessageSummary?(target?: string): Promise<void>;
  /** End the message-summary subscription (best effort; never throws for a dead transport). */
  unsubscribeMessageSummary?(): Promise<void>;
  /**
   * SUBSCRIBE to `event` for `target` (user or SIP URI), replacing an existing
   * subscription for the same pair. Resolves once the request is sent; the
   * outcome arrives through `EngineListener.onPresence`.
   */
  subscribePresence?(target: string, event: PresenceEventPackage, expires: number): Promise<void>;
  /** End a presence subscription (best effort; never throws for a dead transport). */
  unsubscribePresence?(target: string, event: PresenceEventPackage): Promise<void>;
  /**
   * Send an out-of-dialog SIP MESSAGE to `target` (user or SIP URI). Resolves
   * with the final response, including failures (4xx-6xx, synthesized 408/503).
   */
  sendMessage?(
    target: string,
    body: string,
    options: { contentType: string; messageId: string },
  ): Promise<EngineMessageResult>;
  /**
   * Turn our camera on/off on an established call. On adds a video stream by
   * re-INVITE when none is negotiated yet; otherwise the camera track is swapped
   * on the existing sender (no renegotiation). Off stops the camera.
   */
  setVideo?(engineCallId: string, on: boolean): Promise<void>;
  /** Video-only local/remote streams of a call (stable objects per call). Enables video support. */
  getVideoStreams?(engineCallId: string): CallVideoStreams;
  /** Camera used for video calls (applies to live calls too). */
  setVideoDevice?(deviceId: string): Promise<void>;
}

export type EngineFactory = () => SoftphoneEngine;

// ---------------------------------------------------------------------------
// Public API surface (implemented by the Softphone class).
// UI / React / remote layers should depend on this interface, not the class.
// ---------------------------------------------------------------------------

export interface SoftphoneApi {
  readonly config: ResolvedConfig;
  getSnapshot(): SoftphoneSnapshot;
  subscribe(listener: (snapshot: SoftphoneSnapshot) => void): Unsubscribe;
  on<K extends keyof SoftphoneEvents>(
    event: K,
    handler: (payload: SoftphoneEvents[K]) => void,
  ): Unsubscribe;

  start(): Promise<void>;
  stop(): Promise<void>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  /** Update config at runtime (e.g. credentials from a login form). Restarts engine if needed. */
  updateConfig(patch: SoftphoneConfigInput): Promise<void>;

  /** Dial a number. Supports "123,456" (dial 123, then DTMF 456 when connected). */
  call(number: string, options?: CallOptions): Promise<Call>;
  answer(callId?: CallId, options?: AnswerOptions): Promise<void>;
  /** Reject an unanswered incoming call (default SIP 486 Busy Here). */
  reject(callId?: CallId, statusCode?: number): Promise<void>;
  /** Redirect an unanswered incoming call (SIP 302) via the engine's optional forward. */
  forward(target: string, callId?: CallId): Promise<void>;
  hangup(callId?: CallId): Promise<void>;
  hangupAll(): Promise<void>;
  hold(hold: boolean, callId?: CallId): Promise<void>;
  mute(muted: boolean, callId?: CallId): void;
  sendDtmf(tones: string, callId?: CallId): Promise<void>;
  /** Blind transfer the given (or active) call. */
  transfer(target: string, callId?: CallId): Promise<void>;
  /** Start an attended transfer: holds current call, dials target, returns consult call. */
  startAttendedTransfer(target: string, callId?: CallId): Promise<Call>;
  /** Complete an attended transfer between the original and consult calls. */
  completeAttendedTransfer(originalCallId: CallId, consultCallId: CallId): Promise<void>;
  /**
   * Merge the given calls (default: all live calls) into a conference: the
   * local browser mix, or with `conference.mode: 'server'` an Asterisk
   * ConfBridge room the parties are transferred into (docs/server-features.md).
   */
  conference(callIds?: CallId[]): Promise<void>;
  /**
   * Take one party out of the conference. It stays connected as a separate,
   * held call. If fewer than two parties remain mixed, the conference ends and
   * the remaining party becomes a plain call.
   */
  removeFromConference(callId: CallId): Promise<void>;
  /**
   * Break the conference apart:
   * every party gets its own audio back, `keepCallId` (default: the active
   * call, else the first party) stays connected and all others are put on hold.
   */
  splitConference(keepCallId?: CallId): Promise<void>;
  /** Silence (or restore) one conference party for everyone. See {@link Call.partyMuted}. */
  setPartyMuted(callId: CallId, muted: boolean): void;
  setActiveCall(callId: CallId): void;

  /**
   * Turn Do Not Disturb on/off. While on, incoming calls are rejected (config
   * `dnd.rejectCode`) and/or the PBX returns busy (config `dnd.mode`). The
   * snapshot changes at once; in server modes the promise settles when the
   * feature-code call finished and rejects (after reverting the toggle and
   * emitting a `dndServerFailed` notification) when it failed.
   */
  setDnd(on: boolean): Promise<void>;
  /** Dial the voicemail access number (config `voicemail.number`, else the server's Message-Account). */
  callVoicemail(): Promise<Call>;

  /** Start watching extensions (presence / BLF). Requires `presence.enabled`. */
  watch(targets: string | string[]): void;
  /** Stop watching extensions. */
  unwatch(targets: string | string[]): void;
  /** Directed call pickup: answer the call ringing at `extension` (dials `presence.pickupPrefix` + extension). */
  pickup(extension: string): Promise<Call>;
  /**
   * Send a chat message (SIP MESSAGE, `text/plain`) to a user or SIP URI.
   * Resolves with the final message: status `sent` (2xx) or `failed`.
   * Throws when chat is disabled, not registered, or the text is empty / too long.
   */
  sendMessage(to: string, body: string): Promise<ChatMessage>;
  /** Clear the unread count of a conversation (peer key or target). */
  markConversationRead(peer: string): void;
  /** Remove a conversation and its history. */
  deleteConversation(peer: string): void;

  listDevices(): Promise<AudioDevice[]>;
  setDevice(kind: AudioDeviceKind, deviceId: string): Promise<void>;
  /**
   * Set a volume 0..1. 'speaker' = remote call audio, 'ringer' = ringtone,
   * 'microphone' = stored only (engines may ignore it). 0 mutes playback.
   */
  setVolume(kind: AudioDeviceKind, volume: number): void;

  /** Access a plugin's public API by its id. */
  plugin<T = unknown>(id: string): T | undefined;

  /**
   * Video (V2-VID-01; optional so other implementations keep compiling).
   * Turn the camera on/off for the given (or active) call.
   */
  setVideo?(on: boolean, callId?: CallId): Promise<void>;
  /** Local/remote video streams of the given (or active) call; `{}` without video. */
  getVideoStreams?(callId?: CallId): CallVideoStreams;

  /**
   * Voicemail list (V2-VM-02; needs `voicemail.api`, see docs/voicemail.md;
   * optional so other implementations keep compiling). Reload the list.
   */
  refreshVoicemails?(): Promise<VoicemailMessage[]>;
  /** Move a voicemail to Old (heard). The PBX then publishes new MWI counts. */
  markVoicemailRead?(id: string): Promise<void>;
  /** Delete a voicemail. */
  deleteVoicemail?(id: string): Promise<void>;
  /** Download a recording (bearer auth). Play it with `URL.createObjectURL(blob)`. */
  getVoicemailAudio?(id: string): Promise<Blob>;
  /**
   * Web Push (V2-PUSH-01; optional so other implementations keep compiling).
   * Ask for notification permission if needed (call from a click), subscribe
   * this browser and register the subscription at `push.serviceUrl`.
   */
  subscribePush?(): Promise<PushState>;
  /** Remove this browser's subscription from the push service and the browser. */
  unsubscribePush?(): Promise<PushState>;
  /** Localised notification texts for the service worker (`{caller}` placeholder). */
  setPushLabels?(labels: Partial<PushWorkerLabels>): void;
  /**
   * Reload-safe softphone (V2-RESUME-01; optional so other implementations keep
   * compiling). Rejoin the calls of `state` (default: the descriptor persisted by
   * this page, restored automatically by `start()`). A leader-tab takeover passes
   * the state exported by the old leader.
   */
  resume?(state?: ResumeSnapshot): Promise<void>;
  /** The descriptor that `resume()` would restore: anchored calls, or null when there are none. */
  exportResumeState?(): ResumeSnapshot | null;
}

// Chat types live in chat/types.ts.
import type {
  ChatConversation,
  ChatMessage,
  ChatMessageStatus,
  ChatState,
  EngineIncomingMessage,
  EngineMessageResult,
} from './chat/types';
export type * from './chat/types';

// Voicemail list types live in voicemail-list/types.ts.
import type { VoicemailListState, VoicemailMessage } from './voicemail-list/types';
export type * from './voicemail-list/types';
// Push types live in push/types.ts.
import type { PushLaunch, PushState, PushWorkerLabels } from './push/types';
export type * from './push/types';

// Config types live in config.ts but are re-exported here for convenience.
import type { ResolvedConfig, SoftphoneConfigInput } from './config';
export type { ResolvedConfig, SoftphoneConfigInput };
