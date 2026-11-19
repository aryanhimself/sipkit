import type { Unsubscribe } from '../types';
import type { MediaDevicesLike } from './devices';

/**
 * Microphone permission as the browser reports it.
 * - `granted`: calls start without a browser prompt.
 * - `prompt`: the browser asks on the first call (or on `requestMicrophone()`).
 * - `denied`: blocked in the site settings; asking again shows nothing, the user must unblock.
 * - `unknown`: the browser cannot tell (no Permissions API for the microphone, e.g. older Firefox).
 */
export type MicrophonePermission = 'granted' | 'prompt' | 'denied' | 'unknown';

interface PermissionStatusLike {
  state: string;
  onchange: ((this: unknown, ev: Event) => unknown) | null;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
}

interface PermissionsLike {
  query(descriptor: { name: string }): Promise<PermissionStatusLike>;
}

function permissionsApi(): PermissionsLike | undefined {
  const nav = (globalThis as { navigator?: { permissions?: PermissionsLike } }).navigator;
  return nav?.permissions && typeof nav.permissions.query === 'function' ? nav.permissions : undefined;
}

function toPermission(state: string | undefined): MicrophonePermission {
  return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown';
}

/**
 * Tracks the microphone permission without ever prompting. `request()` prompts only when the
 * browser would actually ask (state `prompt` or `unknown`); when it is already granted or
 * blocked it returns at once, so the user is never asked twice.
 */
export class MicrophonePermissionWatcher {
  private status: PermissionStatusLike | undefined;
  private current: MicrophonePermission = 'unknown';
  private readonly listeners = new Set<(p: MicrophonePermission) => void>();
  private readonly onStatusChange = () => this.set(toPermission(this.status?.state));
  private pending: Promise<MicrophonePermission> | undefined;

  private readonly permissions: PermissionsLike | undefined;

  /** `permissions`: the Permissions API to use; default `navigator.permissions`, `null` = none. */
  constructor(
    private readonly mediaDevices: MediaDevicesLike | undefined,
    permissions?: PermissionsLike | null,
  ) {
    this.permissions = permissions === null ? undefined : (permissions ?? permissionsApi());
  }

  get state(): MicrophonePermission {
    return this.current;
  }

  /** Read the current state and follow changes (user flips it in site settings). Never prompts. */
  async check(): Promise<MicrophonePermission> {
    if (!this.permissions) return this.current;
    try {
      if (!this.status) {
        this.status = await this.permissions.query({ name: 'microphone' });
        if (this.status.addEventListener) this.status.addEventListener('change', this.onStatusChange);
        else this.status.onchange = this.onStatusChange;
      }
      this.set(toPermission(this.status.state));
    } catch {
      // 'microphone' is not a queryable name in this browser.
    }
    return this.current;
  }

  /** Ask for the mic only if the browser has not decided yet. Concurrent calls share one prompt. */
  async request(): Promise<MicrophonePermission> {
    const state = await this.check();
    if (state === 'granted' || state === 'denied') return state;
    if (!this.mediaDevices?.getUserMedia) return state;
    this.pending ??= this.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((stream) => {
        for (const t of stream.getTracks()) t.stop();
        this.set('granted');
        return 'granted' as const;
      })
      .catch((error: unknown) => {
        const name = (error as { name?: string } | null)?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') this.set('denied');
        return this.current;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  /** A call captured the mic: it is granted, whatever the Permissions API said. */
  noteGranted(): void {
    this.set('granted');
  }

  /** A call failed because the mic is blocked. */
  noteDenied(): void {
    this.set('denied');
  }

  subscribe(listener: (p: MicrophonePermission) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.status) {
      if (this.status.removeEventListener) this.status.removeEventListener('change', this.onStatusChange);
      else this.status.onchange = null;
    }
    this.status = undefined;
    this.listeners.clear();
  }

  private set(next: MicrophonePermission): void {
    if (next === this.current) return;
    this.current = next;
    for (const l of this.listeners) l(next);
  }
}
