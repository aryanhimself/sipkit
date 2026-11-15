import type { PushLaunch, PushLaunchAction } from './types';

/**
 * Deep link the service worker opens on a notification click, e.g.
 * `https://crm.example.com/agent?sipkitPush=answer&sipkitPushCall=1730000000.42&sipkitPushFrom=1001&sipkitPushAt=1730000000000`.
 * Keep in sync with packages/ui/src/push/service-worker.ts (a test checks it).
 */
export const PUSH_LAUNCH_PARAMS = {
  action: 'sipkitPush',
  callId: 'sipkitPushCall',
  caller: 'sipkitPushFrom',
  at: 'sipkitPushAt',
} as const;

/** Message type the service worker posts to an open page on a notification click. */
export const PUSH_WORKER_MESSAGE = 'sipkit-push-launch';
/** Message type the page posts to the service worker with labels / URLs. */
export const PUSH_WORKER_CONFIG_MESSAGE = 'sipkit-push-config';
/** Notification tag prefix (`sipkit-call-<pushCallId>`). */
export const PUSH_NOTIFICATION_TAG = 'sipkit-call-';

const ACTIONS: readonly PushLaunchAction[] = ['answer', 'open'];

function clean(v: string | null | undefined, max = 128): string | undefined {
  const s = v?.trim();
  return s ? s.slice(0, max) : undefined;
}

/** Parse a launch from a query string (`location.search`). */
export function parseLaunch(search: string): (Omit<PushLaunch, 'at'> & { at?: number }) | null {
  const params = new URLSearchParams(search);
  const action = params.get(PUSH_LAUNCH_PARAMS.action) as PushLaunchAction | null;
  if (!action || !ACTIONS.includes(action)) return null;
  const at = Number(params.get(PUSH_LAUNCH_PARAMS.at));
  const pushCallId = clean(params.get(PUSH_LAUNCH_PARAMS.callId));
  const caller = clean(params.get(PUSH_LAUNCH_PARAMS.caller), 64);
  return {
    action,
    ...(pushCallId ? { pushCallId } : {}),
    ...(caller ? { caller } : {}),
    ...(Number.isFinite(at) && at > 0 ? { at } : {}),
  };
}

/** Build the deep link for `launch` on top of `base` (absolute URL). */
export function buildLaunchUrl(base: string, launch: Omit<PushLaunch, 'at'> & { at?: number }): string {
  const url = new URL(base);
  url.searchParams.set(PUSH_LAUNCH_PARAMS.action, launch.action);
  if (launch.pushCallId) url.searchParams.set(PUSH_LAUNCH_PARAMS.callId, launch.pushCallId);
  if (launch.caller) url.searchParams.set(PUSH_LAUNCH_PARAMS.caller, launch.caller);
  if (launch.at) url.searchParams.set(PUSH_LAUNCH_PARAMS.at, String(launch.at));
  return url.toString();
}

/** `url` without the launch params. */
export function stripLaunch(url: string): string {
  const u = new URL(url);
  for (const p of Object.values(PUSH_LAUNCH_PARAMS)) u.searchParams.delete(p);
  return u.toString();
}
