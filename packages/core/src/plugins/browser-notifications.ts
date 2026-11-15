import { definePlugin } from '../plugin';
import type { Call, CallId } from '../types';

type NotificationCtor = {
  new (title: string, options?: NotificationOptions): Notification;
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
};

export interface BrowserNotificationsOptions {
  /** Only notify while the page is hidden (default true). */
  onlyWhenHidden?: boolean;
  icon?: string;
  /** Build the title/body for an incoming call. */
  format?: (call: Call) => { title: string; body?: string };
  /** Inject the Notification constructor (tests); defaults to globalThis.Notification. */
  NotificationImpl?: NotificationCtor;
  /** Inject page visibility (tests); defaults to document.visibilityState. */
  isPageHidden?: () => boolean;
}

/** Public API: `softphone.plugin<BrowserNotificationsApi>('browser-notifications')`. */
export interface BrowserNotificationsApi {
  readonly supported: boolean;
  readonly permission: NotificationPermission | 'unsupported';
  /** Must be called from a user gesture in most browsers. */
  requestPermission(): Promise<NotificationPermission | 'unsupported'>;
}

const defaultFormat = (call: Call) => ({
  title: 'Incoming call',
  body: call.remoteDisplayName ? `${call.remoteDisplayName} (${call.remoteNumber})` : call.remoteNumber,
});

/**
 * Shows a system notification for incoming calls while the tab is hidden.
 * Clicking it focuses the window; it closes when the call is answered or ends.
 */
export function browserNotificationsPlugin(options: BrowserNotificationsOptions = {}) {
  return definePlugin<BrowserNotificationsApi>({
    id: 'browser-notifications',
    setup({ api, logger }) {
      const Impl =
        options.NotificationImpl ?? (globalThis as { Notification?: NotificationCtor }).Notification;
      const hidden =
        options.isPageHidden ??
        (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
      const format = options.format ?? defaultFormat;
      const open = new Map<CallId, Notification>();

      const close = (id: CallId) => {
        open.get(id)?.close();
        open.delete(id);
      };

      const offCreated = api.on('call:created', ({ call }) => {
        if (!Impl || call.direction !== 'incoming') return;
        if (Impl.permission !== 'granted') return;
        if ((options.onlyWhenHidden ?? true) && !hidden()) return;
        try {
          const { title, body } = format(call);
          const n = new Impl(title, { body, icon: options.icon, tag: call.id, requireInteraction: true });
          n.onclick = () => {
            (globalThis as { focus?: () => void }).focus?.();
            close(call.id);
          };
          open.set(call.id, n);
        } catch (error) {
          logger.warn('Notification failed', error);
        }
      });
      const offUpdated = api.on('call:updated', ({ call }) => {
        if (call.state !== 'ringing' && call.state !== 'setup') close(call.id);
      });
      const offEnded = api.on('call:ended', ({ call }) => close(call.id));

      return {
        api: {
          get supported() {
            return Boolean(Impl);
          },
          get permission() {
            return Impl ? Impl.permission : 'unsupported';
          },
          async requestPermission() {
            return Impl ? Impl.requestPermission() : 'unsupported';
          },
        },
        dispose() {
          offCreated();
          offUpdated();
          offEnded();
          for (const id of [...open.keys()]) close(id);
        },
      };
    },
  });
}
