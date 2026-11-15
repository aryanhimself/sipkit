/**
 * The IPC contract between the Electron main process and the renderer
 * (exposed by src/preload/index.ts as `window.sipkitDesktop`). See docs/desktop.md.
 *
 * Every renderer → main payload is validated in the main process; nothing here
 * gives the renderer Node or Electron access.
 */
import type { HotkeyAction, HotkeySettings } from './hotkeys';
import type { DesktopSettings, EngineKind } from './settings';
import type { TrayStatus } from './status';

export const IPC = {
  /** invoke: () => DesktopBootstrap */
  bootstrap: 'sipkit:bootstrap',
  /** invoke: (patch: unknown) => DesktopSettings */
  saveSettings: 'sipkit:settings:save',
  /** invoke: (password: string) => { stored: boolean } */
  savePassword: 'sipkit:credentials:save',
  /** invoke: () => string | null */
  getPassword: 'sipkit:credentials:get',
  /** invoke: () => void (forget account + password) */
  signOut: 'sipkit:credentials:clear',
  /** invoke: (hotkeys) => HotkeyRegistrationResult */
  applyHotkeys: 'sipkit:hotkeys:apply',
  /** send: () — the renderer is ready to receive commands */
  ready: 'sipkit:ready',
  /** send: (status: TrayStatus) */
  status: 'sipkit:status',
  /** send: (call: IncomingCallInfo) */
  incomingCall: 'sipkit:notify:incoming',
  /** send: (callId: string) — stop showing the incoming-call notification */
  incomingCallEnded: 'sipkit:notify:incoming-ended',
  /** send: (call: MissedCallInfo) */
  missedCall: 'sipkit:notify:missed',
  /** main → renderer: DesktopCommand */
  command: 'sipkit:command',
  /** main → renderer: UpdateState */
  update: 'sipkit:update',
  /** invoke: (method: string, args: unknown[]) => unknown — native engine host (V2-DESK-02) */
  engineInvoke: 'sipkit:engine:invoke',
  /** main → renderer: EngineIpcEvent — native engine facts (V2-DESK-02) */
  engineEvent: 'sipkit:engine:event',
} as const;

/** What the main process asks the renderer to do (hotkeys, tray, notifications, URLs). */
export type DesktopCommand =
  | { type: 'answer'; callId?: string }
  | { type: 'decline'; callId?: string }
  | { type: 'hangup' }
  | { type: 'toggleMute' }
  | { type: 'toggleDnd' }
  | { type: 'dial'; target: string; source: 'url' | 'notification' }
  | { type: 'openSettings' };

export interface DesktopBootstrap {
  settings: DesktopSettings;
  /** A password is stored in the OS keychain. */
  hasPassword: boolean;
  /** `safeStorage` can encrypt on this machine (false e.g. on Linux without a keyring). */
  keychainAvailable: boolean;
  /** Effective engine (settings, overridable with SIPKIT_DESKTOP_ENGINE for demos / e2e). */
  engine: EngineKind;
  /** A native engine host is registered in the main process (V2-DESK-02). */
  nativeEngineAvailable: boolean;
  /** `process.platform` of the main process ('darwin', 'win32', 'linux'). */
  platform: string;
  /** OS locale (for `locale: 'auto'`). */
  osLocale: string;
  appVersion: string;
  /** Hotkeys that failed to register (taken by another app / invalid). */
  hotkeyProblems: HotkeyRegistrationResult['problems'];
}

export interface HotkeyRegistrationResult {
  registered: { action: HotkeyAction; accelerator: string }[];
  problems: { action: HotkeyAction; accelerator: string; error: string }[];
}

export interface IncomingCallInfo {
  callId: string;
  number: string;
  displayName?: string;
}

export type MissedCallInfo = IncomingCallInfo;

export type UpdateState =
  | { state: 'disabled' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloaded'; version: string }
  | { state: 'none' }
  | { state: 'error'; message: string };

/**
 * Engine bridge for an IPC-backed `SoftphoneEngine` (V2-DESK-02).
 *
 * The native SIP stack runs out of the renderer (main process or a sidecar it
 * spawns). A renderer-side engine adapter (packages/engine-native) implements
 * `SoftphoneEngine` by forwarding each method as `invoke(method, args)` and
 * replaying `EngineListener` callbacks it receives through `onEvent`.
 * Arguments and results must be structured-clone friendly (no functions,
 * no MediaStreams: native media stays native).
 */
export interface EngineBridge {
  /**
   * True when the main process has a native engine host registered (known
   * after `bootstrap()`). A function because contextBridge copies values.
   */
  available(): boolean;
  /** Call `SoftphoneEngine[method](...args)` on the host. Rejects with `{ code, message }`. */
  invoke(method: string, args: unknown[]): Promise<unknown>;
  /** Subscribe to `EngineListener` facts (`{ listener: 'onRegistration', args: [...] }`). */
  onEvent(handler: (event: EngineIpcEvent) => void): () => void;
}

export interface EngineIpcEvent {
  /** `EngineListener` method name, e.g. 'onRegistration', 'onIncomingCall'. */
  listener: string;
  args: unknown[];
}

/** `window.sipkitDesktop`, the only API the renderer has to the desktop shell. */
export interface DesktopBridge {
  readonly isDesktop: true;
  bootstrap(): Promise<DesktopBootstrap>;
  saveSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  savePassword(password: string): Promise<{ stored: boolean }>;
  getPassword(): Promise<string | null>;
  signOut(): Promise<void>;
  applyHotkeys(hotkeys: HotkeySettings): Promise<HotkeyRegistrationResult>;
  ready(): void;
  reportStatus(status: TrayStatus): void;
  notifyIncomingCall(call: IncomingCallInfo): void;
  notifyIncomingCallEnded(callId: string): void;
  notifyMissedCall(call: MissedCallInfo): void;
  onCommand(handler: (command: DesktopCommand) => void): () => void;
  onUpdate(handler: (state: UpdateState) => void): () => void;
  engine: EngineBridge;
}
