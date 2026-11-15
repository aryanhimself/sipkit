import { useCallback, useEffect } from 'react';
import type { AudioDevice, AudioDeviceKind } from 'sipkit-core';
import { shallowEqual } from '../equality';
import { useSoftphone } from './use-softphone';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

export interface UseDevicesResult {
  available: AudioDevice[];
  microphones: AudioDevice[];
  speakers: AudioDevice[];
  ringers: AudioDevice[];
  /** Cameras for video calls (V2-VID-01). */
  cameras: AudioDevice[];
  selected: Partial<Record<AudioDeviceKind, string>>;
  /** Volume 0..1 per kind (absent = 1). */
  volume: Partial<Record<AudioDeviceKind, number>>;
  setVolume: (kind: AudioDeviceKind, volume: number) => void;
  setDevice: (kind: AudioDeviceKind, deviceId: string) => Promise<void>;
  /** Re-enumerate devices (e.g. after granting mic permission). */
  refresh: () => Promise<AudioDevice[]>;
}

/** Audio devices + selection. Enumerates once on mount unless `{ enumerate: false }`. */
export function useDevices(options: { enumerate?: boolean } = {}): UseDevicesResult {
  const api = useSoftphone();
  const devices = useSoftphoneSnapshot((s) => s.devices, shallowEqual);
  const enumerate = options.enumerate ?? true;

  const refresh = useCallback(() => api.listDevices(), [api]);
  const setDevice = useCallback(
    (kind: AudioDeviceKind, deviceId: string) => api.setDevice(kind, deviceId),
    [api],
  );

  const setVolume = useCallback(
    (kind: AudioDeviceKind, volume: number) => api.setVolume(kind, volume),
    [api],
  );

  useEffect(() => {
    if (enumerate) api.listDevices().catch(() => undefined);
  }, [api, enumerate]);

  return {
    available: devices.available,
    microphones: devices.available.filter((d) => d.kind === 'microphone'),
    speakers: devices.available.filter((d) => d.kind === 'speaker'),
    ringers: devices.available.filter((d) => d.kind === 'ringer'),
    cameras: devices.available.filter((d) => d.kind === 'camera'),
    selected: devices.selected,
    volume: devices.volume ?? {},
    setVolume,
    setDevice,
    refresh,
  };
}
