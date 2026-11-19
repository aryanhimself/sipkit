import { z } from 'zod';
import type { PushTokenProvider } from './push/types';

/**
 * Softphone configuration.
 *
 * Explicit names and validated types. Every field has a safe default so a
 * host only needs to supply credentials + server.
 */

export const transportModeSchema = z.enum([
  /** Browser speaks SIP over WSS directly to Asterisk (PJSIP webrtc=yes). */
  'webrtc',
  /**
   * Browser speaks SIP over WSS to a WebRTC<->SIP gateway (e.g. the bundled
   * Asterisk/Kamailio gateway in infra/) which bridges to a plain SIP
   * (UDP/TCP/TLS) server given by `sipServer`.
   */
  'sip-gateway',
  /**
   * A native SIP stack (desktop engine, V2-DESK-02, `sipkit-engine-native`)
   * speaks plain SIP over UDP/TCP/TLS straight to `sipServer` using
   * `sipTransport`. No WebSocket, no gateway, no WebRTC.
   */
  'native',
]);
export type TransportMode = z.infer<typeof transportModeSchema>;

const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export const configSchema = z.object({
  // --- account -------------------------------------------------------------
  username: z.string().default(''),
  password: z.string().default(''),
  /** Auth username if different from `username`. */
  authUsername: z.string().optional(),
  displayName: z.string().optional(),
  /** SIP domain / realm, e.g. "pbx.example.com". Derived from server if empty. */
  domain: z.string().default(''),

  // --- transport -------------------------------------------------------------
  transportMode: transportModeSchema.default('webrtc'),
  /** One or more WebSocket URLs (failover in order), e.g. wss://pbx:8089/ws */
  websocketUrls: z.array(z.string().url()).default([]),
  /** sip-gateway mode: the plain SIP server behind the gateway (host[:port]). native mode: the SIP server the native stack registers with. */
  sipServer: z.string().optional(),
  /** sip-gateway mode: transport used gateway -> sipServer. native mode: transport of the native stack. */
  sipTransport: z.enum(['udp', 'tcp', 'tls']).default('udp'),
  /** Optional outbound proxy (host[:port]). */
  outboundProxy: z.string().optional(),
  /** WebSocket keepalive interval (seconds). */
  keepAliveInterval: z.number().int().min(0).default(30),
  /** Reconnect attempts before giving up (0 = infinite). */
  reconnectionAttempts: z.number().int().min(0).default(0),
  reconnectionDelay: z.number().int().min(1).default(4),

  // --- registration ------------------------------------------------------------
  autoRegister: z.boolean().default(true),
  /** REGISTER Expires in seconds. */
  registerExpires: z.number().int().min(30).max(3600).default(300),

  // --- media / ICE ---------------------------------------------------------------
  iceServers: z.array(iceServerSchema).default([{ urls: 'stun:stun.l.google.com:19302' }]),
  iceGatheringTimeoutMs: z.number().int().min(100).default(2000),

  // --- call behaviour ------------------------------------------------------------
  /** Prefix prepended to dialed numbers (e.g. `9` or `0` for an outside line). Never added to SIP URIs. */
  techPrefix: z.string().default(''),
  /**
   * Only add {@link techPrefix} when the number has at least this many digits, so short
   * internal extensions (e.g. `1001`) are dialled as-is. `0` = always add it.
   */
  techPrefixMinDigits: z.number().int().min(0).max(32).default(0),
  /** Strip spaces, dashes, brackets from dialed numbers. */
  normalizeNumbers: z.boolean().default(true),
  /** DTMF method. `auto` picks the best method the call supports. */
  dtmfMode: z.enum(['auto', 'rfc2833', 'info']).default('auto'),
  /** Default transfer type. */
  defaultTransferType: z.enum(['blind', 'attended']).default('blind'),
  /** Reject new incoming calls while in a call. */
  rejectOnBusy: z.boolean().default(false),
  /** Auto answer incoming calls. */
  autoAnswer: z.boolean().default(false),
  /** Honour server auto-answer headers (Call-Info answer-after, Alert-Info). */
  autoAnswerOnHeader: z.boolean().default(true),
  /** Play early media on 183. */
  earlyMedia: z.boolean().default(true),
  /** Hold (or mute) other lines when a new call starts. */
  autoHoldOtherLines: z.boolean().default(true),
  /** Max concurrent lines. */
  maxLines: z.number().int().min(1).max(8).default(2),
  /** Seconds before unanswered outgoing call is cancelled. */
  ringTimeout: z.number().int().min(5).default(90),
  /** Extra SIP headers on every INVITE, e.g. ["X-Agent: 42"]. */
  extraHeaders: z.array(z.string()).default([]),
  /**
   * Extra SIP headers on every REGISTER, e.g. ["Authorization: Bearer <token>"] for a PBX that takes a
   * token instead of (or as well as) digest auth. Treated as credentials: changing them re-registers and
   * they are never logged.
   */
  registerHeaders: z.array(z.string()).default([]),
  /**
   * Names of incoming INVITE headers the host wants to read, e.g. ["X-Taskbirt-Call-Id"]. Their values are
   * copied to `Call.inviteHeaders` (lower-cased names, values trimmed, at most 256 characters). Empty = none.
   */
  inviteHeaders: z.array(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)).max(20).default([]),

  // --- voicemail / DND -------------------------------------------------------------
  /** Message waiting indication (RFC 3842) and the voicemail button (V2-VM-01). */
  voicemail: z
    .object({
      /** Track voicemail counts and show the voicemail badge. */
      enabled: z.boolean().default(false),
      /** SUBSCRIBE to message-summary after registering. Unsolicited NOTIFYs are honoured either way. */
      subscribe: z.boolean().default(true),
      /** Voicemail access number, e.g. "*97". Empty = use the server's Message-Account. */
      number: z.string().default(''),
      /** Subscription target (user or SIP URI). Empty = own AOR. */
      mailbox: z.string().default(''),
      /** SUBSCRIBE Expires in seconds. */
      expires: z.number().int().min(60).max(86400).default(3600),
      /**
       * Voicemail list (V2-VM-02): list, play, mark read and delete messages
       * through `services/voicemail-api`. Opt-in: off while `baseUrl` is empty.
       * See docs/voicemail.md.
       */
      api: z
        .object({
          /** voicemail-api base URL, e.g. "https://pbx.example.com/voicemail". Empty = no list. */
          baseUrl: z.string().default(''),
          /** Mailbox ("1001" or "1001@context"). Empty = `username`. */
          mailbox: z.string().default(''),
          /** Static bearer token (dev / simple setups). Prefer `getToken`. */
          token: z.string().default(''),
          /**
           * Returns a (short-lived) bearer token, e.g. minted by the CRM backend.
           * Called before requests whenever the cached token is missing or was
           * rejected (401). Takes precedence over `token`.
           */
          getToken: z
            .custom<() => string | Promise<string>>((v) => typeof v === 'function', 'getToken must be a function')
            .optional(),
          /** Reload the list after registering and whenever the MWI counts change. */
          autoRefresh: z.boolean().default(true),
          /** Request timeout in ms. */
          timeout: z.number().int().min(1000).max(120_000).default(15_000),
        })
        .default({}),
    })
    .default({}),
  /** Do Not Disturb (V2-FWD-01). */
  dnd: z
    .object({
      /** Initial DND state (overridden by the persisted value when `persist`). */
      enabled: z.boolean().default(false),
      /** SIP status used to reject calls while DND is on (486 Busy Here, 480, 603 Decline...). */
      rejectCode: z.number().int().min(400).max(699).default(486),
      /** Remember the DND toggle across reloads (softphone storage). Server modes always remember it. */
      persist: z.boolean().default(false),
      /**
       * Where DND is enforced. 'local' (default): the browser rejects incoming
       * calls with `rejectCode`. 'server': the softphone dials the `serverOn` /
       * `serverOff` feature codes silently and the PBX returns busy, so DND works
       * with the tab closed (needs the dialplan in docs/server-features.md).
       * 'both': feature codes plus the local auto-reject.
       */
      mode: z.enum(['local', 'server', 'both']).default('local'),
      /** Feature code that turns server-side DND on (Asterisk dev dialplan: *78). */
      serverOn: z.string().default('*78'),
      /** Feature code that turns server-side DND off (Asterisk dev dialplan: *79). */
      serverOff: z.string().default('*79'),
      /**
       * Optional query code (dev dialplan: *76): answered = off, 486 busy = on.
       * When set, the server state is adopted on register; when empty, the
       * client's state is pushed to the server instead.
       */
      serverQuery: z.string().default(''),
      /** Server modes: sync with the PBX every time registration is (re-)established. */
      syncOnRegister: z.boolean().default(true),
      /** Seconds to wait for a feature-code call before failing. */
      serverTimeout: z.number().int().min(1).max(60).default(10),
    })
    .default({}),

  // --- conference ----------------------------------------------------------------
  /** Conference mode (V2-CONF-01). */
  conference: z
    .object({
      /**
       * 'local' (default): calls are mixed in the browser (Web Audio).
       * 'server': `conference()` joins an Asterisk ConfBridge room and blind
       * transfers (REFER) every party into it, so the PBX mixes and the room
       * can outlive you. Needs the dialplan in docs/server-features.md.
       */
      mode: z.enum(['local', 'server']).default('local'),
      /** Dialled before the room number (dev dialplan: 7 + room, e.g. 71001). */
      serverRoomPrefix: z.string().default('7'),
      /** Room number after the prefix. Empty = your own username (one room per agent). */
      serverRoom: z.string().default(''),
      /** End the room for everyone when you hang up. Default: the parties stay connected. */
      serverEndOnLeave: z.boolean().default(false),
      /** Seconds to wait for the room to answer before giving up. */
      serverJoinTimeout: z.number().int().min(1).max(60).default(15),
    })
    .default({}),

  // --- presence / BLF --------------------------------------------------------------
  /** Presence and busy lamp field: watch colleagues' extensions (V2-PRES-01, V2-BLF-01). See docs/presence.md. */
  presence: z
    .object({
      /** Subscribe to the extensions in `watch` (and allow runtime `watch()`). */
      enabled: z.boolean().default(false),
      /** Extensions (or SIP URIs) to watch from the start. */
      watch: z.array(z.string()).default([]),
      /**
       * Event packages to SUBSCRIBE to per extension: 'dialog' (RFC 4235, BLF:
       * idle/ringing/busy/held + caller) and/or 'presence' (PIDF: open/closed, notes).
       */
      events: z.array(z.enum(['dialog', 'presence'])).min(1).default(['dialog']),
      /** SUBSCRIBE Expires in seconds (refreshed automatically before expiry). */
      expires: z.number().int().min(60).max(86400).default(600),
      /** Minimum gap between two initial SUBSCRIBEs in ms, so 50 lamps don't flood the server. */
      subscribeIntervalMs: z.number().int().min(0).max(5000).default(20),
      /** Maximum number of watched extensions. */
      maxWatched: z.number().int().min(1).max(1000).default(200),
      /** Directed call pickup feature code prefix: `pickup('1002')` dials `**1002` (Asterisk dialplan). */
      pickupPrefix: z.string().default('**'),
    })
    .default({}),

  // --- chat ---------------------------------------------------------------------
  /** 1:1 chat over SIP MESSAGE (V2-CHAT-01). */
  chat: z
    .object({
      /** Send/receive SIP MESSAGE and show the Chat tab. Incoming MESSAGEs are answered 480 while off. */
      enabled: z.boolean().default(false),
      /** Keep history in localStorage (softphone storage). Ignored when a custom `chatStorage` is passed. */
      persist: z.boolean().default(false),
      /** Messages kept per conversation (oldest dropped first). */
      historyLimit: z.number().int().min(10).max(5000).default(200),
      /** Conversations kept (least recently active dropped first). */
      maxConversations: z.number().int().min(1).max(1000).default(100),
      /** Max characters per outgoing message (keep SIP MESSAGE well under 1300 bytes on UDP legs). */
      maxLength: z.number().int().min(1).max(10000).default(1000),
      /** Honour PBX delivery reports (`X-Sipkit-Delivery: failed`, see docs/chat.md): mark the message failed. */
      deliveryReports: z.boolean().default(true),
    })
    .default({}),

  /**
   * The browser's own voice processing on the microphone (docs/audio.md). Changes apply live to
   * calls in progress. For stronger AI noise removal, add the `sipkit-noise` plugin.
   */
  audioProcessing: z
    .object({
      /** Remove background noise (fans, hum, street). */
      noiseSuppression: z.boolean().default(true),
      /** Stop the caller hearing themselves through your speakers. Keep on unless you use a headset with its own. */
      echoCancellation: z.boolean().default(true),
      /** Even out your volume when you move closer to or away from the mic. */
      autoGainControl: z.boolean().default(true),
      /**
       * Isolate your voice from other people talking and keyboard noise, where the browser and OS
       * support it (Chrome with macOS Voice Isolation). Ignored elsewhere.
       */
      voiceIsolation: z.boolean().default(false),
    })
    .default({}),

  /** 1:1 video calls (V2-VID-01). Conferences stay audio-only. */
  video: z
    .object({
      /** Allow video: video calls, answering with video, camera toggle, camera picker. Off = audio only (video offers are declined). */
      enabled: z.boolean().default(false),
      /** `call()` / `answer()` use video unless told otherwise (`{ video: false }`). */
      defaultOn: z.boolean().default(false),
      /** getUserMedia video constraints (MediaTrackConstraints), e.g. `{ width: 640, height: 360, frameRate: 15 }`. The selected camera is added as `deviceId`. */
      constraints: z.record(z.unknown()).optional(),
    })
    .default({}),

  /**
   * Web Push for incoming calls (V2-PUSH-01, docs/push.md): with the tab closed,
   * the sipkit push service shows an OS notification when the PBX gets a call;
   * clicking it opens the softphone, which registers and answers that call.
   */
  push: z
    .object({
      /** Allow subscribing (settings toggle, `subscribePush()`) and honour notification clicks. */
      enabled: z.boolean().default(false),
      /** Base URL of the push service (services/push), e.g. "https://push.example.com". */
      serviceUrl: z.string().default(''),
      /** VAPID public key. Empty = fetched from `{serviceUrl}/vapid-public-key`. */
      vapidPublicKey: z.string().default(''),
      /** Bearer token for the push service (minted by the CRM backend). See also `getToken`. */
      token: z.string().default(''),
      /** Returns a (fresh) token; wins over `token`. */
      getToken: z
        .custom<PushTokenProvider>((v) => typeof v === 'function', { message: 'push.getToken must be a function' })
        .optional(),
      /** URL of the service worker shipped by sipkit-ui (`sipkit-push-sw.js`); serve it from your origin. */
      serviceWorkerUrl: z.string().default('/sipkit-push-sw.js'),
      /** Service worker scope. Empty = the worker's directory. */
      serviceWorkerScope: z.string().default(''),
      /** Page the notification opens. Empty = the current page (without push params). */
      appUrl: z.string().default(''),
      /** After every (re-)registration, re-send this browser's subscription to the service (once opted in). */
      autoResubscribe: z.boolean().default(true),
      /** Answer the matching call automatically when the agent pressed "Answer" on the notification. */
      autoAnswer: z.boolean().default(true),
      /** Seconds a notification click waits for its call (registration + INVITE) before it is dropped. */
      launchTimeout: z.number().int().min(5).max(600).default(90),
    })
    .default({}),

  /**
   * One softphone per browser (docs/shared-instance.md, docs/browser-extension.md).
   * Read by `createSharedSoftphone()` and the `<sipkit-phone>` default factory:
   * 'local' (default) = this page owns its own instance, as before;
   * 'shared' = use the browser extension's instance when installed
   * (`preferExtension`), else elect one leader tab per origin (Web Locks) that
   * runs the instance while the other tabs are remote clients (BroadcastChannel).
   */
  instance: z
    .object({
      mode: z.enum(['local', 'shared']).default('local'),
      /** Try the sipkit browser extension first. */
      preferExtension: z.boolean().default(true),
      /** How long to wait for the extension's content script to answer the handshake (ms). */
      extensionTimeoutMs: z.number().int().min(50).max(10_000).default(400),
      /** How long to wait for the extension's instance once it answered (ms). */
      extensionWelcomeTimeoutMs: z.number().int().min(100).max(30_000).default(5_000),
      /** Lock / BroadcastChannel name of the web leader election. Change it to run two softphones on one origin. */
      channel: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/).default('sipkit'),
    })
    .default({}),

  /**
   * Reload-safe softphone (V2-RESUME-01, docs/resume.md). A page reload or
   * navigation keeps registration, DND, mute/hold and the active call: answered
   * and placed calls are anchored in an Asterisk ConfBridge room the PBX keeps
   * while the page is gone, and the reloaded page rejoins it automatically.
   * Needs the dialplan in docs/resume.md.
   */
  resume: z
    .object({
      /** Opt in: anchor calls on the PBX and restore them after a reload. */
      enabled: z.boolean().default(false),
      /**
       * How long the PBX keeps the customer waiting (music on hold) for the
       * agent to come back, in ms (5 s .. 5 min). Afterwards the PBX runs its
       * fallback (dev dialplan: the agent's voicemail, then hang up).
       */
      rejoinTimeoutMs: z.number().int().min(5000).max(300_000).default(30_000),
      /** Feature code that rejoins an anchor room: prefix + anchor id (dev dialplan: *85). */
      rejoinPrefix: z.string().default('*85'),
      /** Feature code that ends an anchor room for good on a real hangup (dev dialplan: *86). */
      endPrefix: z.string().default('*86'),
      /** Seconds to wait for the rejoin call to be answered. */
      rejoinCallTimeout: z.number().int().min(1).max(60).default(10),
      /**
       * Where the active-call descriptor lives: 'session' (sessionStorage, this
       * tab only, the default) or 'local' (localStorage, shared by the tabs of a
       * profile, e.g. for a leader-tab takeover).
       */
      storage: z.enum(['session', 'local']).default('session'),
    })
    .default({}),

  // --- UX ----------------------------------------------------------------------
  brandName:z.string().default('SipKit'),
  /** Show toast notifications in the bundled UI. */
  showToasts: z.boolean().default(true),
  /** Feature flags: disable built-in features/pages. */
  disabledFeatures: z.array(z.string()).default([]),
  ringtoneUrl: z.string().optional(),
  ringbackUrl: z.string().optional(),
  /**
   * UI language for the bundled UI: BCP 47 tag ('en', 'ne', 'ne-NP') or 'auto'
   * (browser languages). Unknown tags fall back to English. The UI `locale`
   * prop / attribute wins over this.
   */
  language: z.string().default('en'),

  // --- diagnostics ---------------------------------------------------------------
  /**
   * Seconds between call quality samples (`call:quality` event, `call.quality`,
   * CDR summary). 0 disables monitoring. Needs an engine with `getCallStats`.
   */
  callQualityInterval: z.number().min(0).max(60).default(2),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  /** Log raw SIP messages (very verbose). */
  traceSip: z.boolean().default(false),
});

export type SoftphoneConfigInput = z.input<typeof configSchema>;
export type ResolvedConfig = z.output<typeof configSchema>;

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Validate + apply defaults. Throws ConfigError with readable issues. */
export function resolveConfig(input: SoftphoneConfigInput = {}): ResolvedConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid softphone config: ${summary}`, parsed.error.issues);
  }
  const cfg = parsed.data;
  if (!cfg.domain && cfg.transportMode === 'native' && cfg.sipServer) {
    cfg.domain = hostOfServer(cfg.sipServer);
  }
  if (!cfg.domain && cfg.websocketUrls[0]) {
    try {
      cfg.domain = new URL(cfg.websocketUrls[0]).hostname;
    } catch {
      /* validated above */
    }
  }
  return cfg;
}

/** True if enough is configured to attempt registration. */
export function hasCredentials(cfg: ResolvedConfig): boolean {
  if (cfg.transportMode === 'native') return Boolean(cfg.username && cfg.sipServer && cfg.domain);
  return Boolean(cfg.username && cfg.websocketUrls.length > 0 && cfg.domain);
}

/** "host", "host:port", "[v6]:port" or "sip:host;transport=udp" -> host. */
function hostOfServer(server: string): string {
  const bare = server.replace(/^sips?:/i, '').split(';')[0] ?? '';
  if (bare.startsWith('[')) return bare.slice(0, bare.indexOf(']') + 1);
  return bare.split(':')[0] ?? '';
}

export function isFeatureEnabled(cfg: ResolvedConfig, feature: string): boolean {
  return !cfg.disabledFeatures.map((f) => f.toLowerCase()).includes(feature.toLowerCase());
}
