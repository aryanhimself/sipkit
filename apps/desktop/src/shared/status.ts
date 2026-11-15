/**
 * Tray status (V2-DESK-01): one value summarising the softphone snapshot, sent
 * by the renderer to the main process whenever it changes.
 *
 * Structural input type so this module does not depend on sipkit-core.
 */

export type TrayStatus = 'offline' | 'connecting' | 'registered' | 'dnd' | 'ringing' | 'in-call';

export const TRAY_STATUSES: readonly TrayStatus[] = ['offline', 'connecting', 'registered', 'dnd', 'ringing', 'in-call'];

export interface StatusInput {
  registration: { state: string };
  dnd: boolean;
  calls: readonly { direction: string; state: string }[];
}

/** Priority: in call > ringing > DND > registered > connecting > offline. */
export function deriveTrayStatus(snapshot: StatusInput): TrayStatus {
  const live = snapshot.calls.filter((c) => c.state !== 'disconnected');
  if (live.some((c) => c.state === 'connected' || c.state === 'held' || c.direction === 'outgoing')) return 'in-call';
  if (live.some((c) => c.direction === 'incoming')) return 'ringing';
  const reg = snapshot.registration.state;
  if (reg === 'registered') return snapshot.dnd ? 'dnd' : 'registered';
  if (reg === 'connecting' || reg === 'registering') return 'connecting';
  return 'offline';
}

export function isTrayStatus(value: unknown): value is TrayStatus {
  return typeof value === 'string' && (TRAY_STATUSES as readonly string[]).includes(value);
}

/** Dot colour per status for the generated tray icon (RGB). OS asset, not a UI theme colour. */
export const TRAY_COLORS: Record<TrayStatus, [number, number, number]> = {
  offline: [148, 163, 184],
  connecting: [234, 179, 8],
  registered: [22, 163, 74],
  dnd: [220, 38, 38],
  ringing: [37, 99, 235],
  'in-call': [37, 99, 235],
};
