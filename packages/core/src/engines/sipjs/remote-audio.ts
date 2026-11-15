import type { Logger } from '../../types';
import { applySinkId } from '../../media/devices';

/**
 * Plays each call's remote stream through its own hidden, managed <audio>
 * element (so several lines / conference parties can be heard at once) and
 * routes all of them to the selected speaker via setSinkId when supported.
 */
export class RemoteAudio {
  private elements = new Map<string, HTMLAudioElement>();
  private sinkId: string | undefined;
  private volume = 1;

  constructor(private readonly logger: Logger) {}

  attach(id: string, stream: MediaStream): void {
    if (typeof document === 'undefined') return;
    let el = this.elements.get(id);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('data-sipkit', id);
      el.style.display = 'none';
      document.body.appendChild(el);
      el.volume = this.volume;
      el.muted = this.volume === 0;
      this.elements.set(id, el);
      void applySinkId(el, this.sinkId);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    const played = el.play() as Promise<void> | undefined;
    played?.catch((error: unknown) => {
      // AbortError = play() superseded by a new srcObject or detach() on hangup: harmless.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.logger.warn('Remote audio playback blocked', error);
    });
  }

  detach(id: string): void {
    const el = this.elements.get(id);
    if (!el) return;
    this.elements.delete(id);
    el.pause();
    el.srcObject = null;
    el.remove();
  }

  async setSinkId(deviceId: string): Promise<void> {
    this.sinkId = deviceId;
    await Promise.all([...this.elements.values()].map((el) => applySinkId(el, deviceId)));
  }

  /** Volume 0..1 for all call audio; 0 also sets `muted`. */
  setVolume(volume: number): void {
    this.volume = volume;
    for (const el of this.elements.values()) {
      el.volume = volume;
      el.muted = volume === 0;
    }
  }

  dispose(): void {
    for (const id of [...this.elements.keys()]) this.detach(id);
  }
}
