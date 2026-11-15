import type { AudioDevice, AudioDeviceKind, SoftphoneEngine, Unsubscribe } from '../types';
import type { PluginStorage } from '../plugin';
import { SoftphoneError, toEngineError } from '../errors';
import { listAudioDevices, watchDeviceChanges, type MediaDevicesLike } from '../media/devices';

type Selected = Partial<Record<AudioDeviceKind, string>>;
type Volumes = Partial<Record<AudioDeviceKind, number>>;
type DevicesState = { available: AudioDevice[]; selected: Selected; volume: Volumes };
const KINDS: readonly AudioDeviceKind[] = ['microphone', 'speaker', 'ringer', 'camera'];
const STORAGE_KEY = 'selected';
const VOLUME_KEY = 'volume';

/**
 * Device enumeration + selection. Selections persist in storage and are
 * re-applied to the engine whenever it (re)starts.
 */
export class DeviceManager {
  private available: AudioDevice[] = [];
  private selected: Selected;
  private volume: Volumes;
  private unwatch: Unsubscribe | undefined;

  constructor(
    private readonly mediaDevices: MediaDevicesLike | undefined,
    private readonly storage: PluginStorage,
    private readonly onChange: (devices: DevicesState) => void,
  ) {
    const stored = storage.get<Selected>(STORAGE_KEY);
    this.selected = stored && typeof stored === 'object' ? { ...stored } : {};
    const vol = storage.get<Volumes>(VOLUME_KEY);
    this.volume = vol && typeof vol === 'object' ? { ...vol } : {};
  }

  get state(): DevicesState {
    return { available: this.available, selected: this.selected, volume: this.volume };
  }

  /** Set a 0..1 volume; 'speaker' is pushed to the engine, 'ringer' is read by the ringtone plugin. */
  setVolume(kind: AudioDeviceKind, volume: number, engine: SoftphoneEngine | undefined): void {
    if (!KINDS.includes(kind)) throw new SoftphoneError('INVALID_ARGUMENT', `Unknown device kind "${String(kind)}"`);
    if (typeof volume !== 'number' || Number.isNaN(volume) || volume < 0 || volume > 1) {
      throw new SoftphoneError('INVALID_ARGUMENT', 'volume must be a number between 0 and 1');
    }
    if (kind === 'speaker') engine?.setOutputVolume?.(volume);
    this.volume = { ...this.volume, [kind]: volume };
    this.storage.set(VOLUME_KEY, this.volume);
    this.onChange(this.state);
  }

  async list(): Promise<AudioDevice[]> {
    try {
      this.available = await listAudioDevices(this.mediaDevices);
    } catch (error) {
      throw new SoftphoneError('NOT_SUPPORTED', 'Unable to enumerate audio devices', { cause: error });
    }
    this.onChange(this.state);
    return this.available;
  }

  /** Start listening for hot-plugged devices (idempotent). */
  watch(onError: (error: unknown) => void): void {
    if (this.unwatch) return;
    this.unwatch = watchDeviceChanges(this.mediaDevices, () => {
      this.list().catch(onError);
    });
  }

  unwatchChanges(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }

  async select(kind: AudioDeviceKind, deviceId: string, engine: SoftphoneEngine | undefined): Promise<void> {
    if (!KINDS.includes(kind)) throw new SoftphoneError('INVALID_ARGUMENT', `Unknown device kind "${String(kind)}"`);
    if (typeof deviceId !== 'string' || !deviceId) {
      throw new SoftphoneError('INVALID_ARGUMENT', 'deviceId must be a non-empty string');
    }
    const known = this.available.filter((d) => d.kind === kind);
    if (deviceId !== 'default' && known.length > 0 && !known.some((d) => d.id === deviceId)) {
      throw new SoftphoneError('DEVICE_NOT_FOUND', `No ${kind} with id "${deviceId}"`);
    }
    if (engine) await this.applyOne(engine, kind, deviceId);
    this.selected = { ...this.selected, [kind]: deviceId };
    this.storage.set(STORAGE_KEY, this.selected);
    this.onChange(this.state);
  }

  /** Push persisted selections into a freshly started engine. Failures are reported, not thrown. */
  async applyAll(engine: SoftphoneEngine, onError: (error: unknown) => void): Promise<void> {
    for (const kind of KINDS) {
      const id = this.selected[kind];
      if (id) await this.applyOne(engine, kind, id).catch(onError);
    }
    if (this.volume.speaker !== undefined) engine.setOutputVolume?.(this.volume.speaker);
  }

  private async applyOne(engine: SoftphoneEngine, kind: AudioDeviceKind, id: string): Promise<void> {
    try {
      if (kind === 'microphone') await engine.setInputDevice?.(id);
      else if (kind === 'speaker') await engine.setOutputDevice?.(id);
      else if (kind === 'camera') await engine.setVideoDevice?.(id);
      // 'ringer' is consumed by the ringtone plugin from the snapshot.
    } catch (error) {
      throw toEngineError(error, `Selecting ${kind}`);
    }
  }
}
