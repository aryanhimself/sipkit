import type { AudioDevice, AudioDeviceKind, Unsubscribe } from '../types';

/** The subset of `navigator.mediaDevices` used for device management. */
export interface MediaDevicesLike {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  getUserMedia?(constraints: MediaStreamConstraints): Promise<MediaStream>;
  addEventListener?(type: 'devicechange', listener: () => void): void;
  removeEventListener?(type: 'devicechange', listener: () => void): void;
}

/** `navigator.mediaDevices` when present (secure contexts only), otherwise undefined. */
export function getMediaDevices(): MediaDevicesLike | undefined {
  const nav = (globalThis as { navigator?: { mediaDevices?: MediaDevicesLike } }).navigator;
  return nav?.mediaDevices && typeof nav.mediaDevices.enumerateDevices === 'function'
    ? nav.mediaDevices
    : undefined;
}

const fallbackLabel: Record<AudioDeviceKind, string> = {
  microphone: 'Microphone',
  speaker: 'Speaker',
  ringer: 'Ringer',
  camera: 'Camera',
};

/**
 * Enumerate audio devices (and cameras, kind 'camera'). Outputs are reported twice: once as `speaker`
 * and once as `ringer`, since the ringer can be routed to any output.
 * Labels are empty until mic permission is granted, so fallbacks are used.
 */
export async function listAudioDevices(md: MediaDevicesLike | undefined = getMediaDevices()): Promise<AudioDevice[]> {
  if (!md) return [];
  const infos = await md.enumerateDevices();
  const result: AudioDevice[] = [];
  const counters: Record<AudioDeviceKind, number> = { microphone: 0, speaker: 0, ringer: 0, camera: 0 };
  const push = (info: MediaDeviceInfo, kind: AudioDeviceKind) => {
    counters[kind] += 1;
    result.push({
      id: info.deviceId || 'default',
      label: info.label || `${fallbackLabel[kind]} ${counters[kind]}`,
      kind,
    });
  };
  for (const info of infos) {
    if (info.kind === 'audioinput') push(info, 'microphone');
  }
  for (const info of infos) {
    if (info.kind === 'audiooutput') push(info, 'speaker');
  }
  for (const info of infos) {
    if (info.kind === 'audiooutput') push(info, 'ringer');
  }
  // Cameras for video calls (V2-VID-01).
  for (const info of infos) {
    if (info.kind === 'videoinput') push(info, 'camera');
  }
  return result;
}

/** Subscribe to `devicechange`. Returns a no-op unsubscribe when unsupported. */
export function watchDeviceChanges(md: MediaDevicesLike | undefined, onChange: () => void): Unsubscribe {
  if (!md?.addEventListener || !md.removeEventListener) return () => undefined;
  md.addEventListener('devicechange', onChange);
  return () => md.removeEventListener?.('devicechange', onChange);
}

/** True when HTMLMediaElement.setSinkId (output device selection) is available. */
export function supportsSinkId(): boolean {
  const proto = (globalThis as { HTMLMediaElement?: { prototype: object } }).HTMLMediaElement?.prototype;
  return Boolean(proto && 'setSinkId' in proto);
}

/** Route an audio element to a device when supported. Errors are swallowed and reported as false. */
export async function applySinkId(el: HTMLMediaElement, deviceId: string | undefined): Promise<boolean> {
  const target = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (!deviceId || typeof target.setSinkId !== 'function') return false;
  try {
    await target.setSinkId(deviceId);
    return true;
  } catch {
    return false;
  }
}
