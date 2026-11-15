import { applySinkId } from '../media/devices';

/** Something that can loop a sound until stopped. */
export interface LoopPlayer {
  /** `gain` (0..1) scales the player's base volume (user ringer volume). */
  start(sinkId: string | undefined, gain?: number): void;
  stop(): void;
}

/** A tone cadence: frequencies played together, and on/off segments in seconds. */
export interface TonePattern {
  frequencies: number[];
  /** Alternating on/off durations, e.g. [0.4, 0.2, 0.4, 2] (UK double ring). */
  cadence: number[];
}

export const RINGTONE_PATTERN: TonePattern = { frequencies: [400, 450], cadence: [0.4, 0.2, 0.4, 2] };
export const RINGBACK_PATTERN: TonePattern = { frequencies: [440, 480], cadence: [2, 4] };

/** Loops an audio URL through an <audio> element routed to `sinkId`. */
export class UrlLoopPlayer implements LoopPlayer {
  private el: HTMLAudioElement | undefined;

  constructor(
    private readonly url: string,
    private readonly volume: number,
    private readonly createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {}

  start(sinkId: string | undefined, gain = 1): void {
    this.stop();
    const el = this.createAudio();
    el.src = this.url;
    el.loop = true;
    el.volume = this.volume * gain;
    this.el = el;
    void applySinkId(el, sinkId).then(() => {
      if (this.el !== el) return;
      const played = el.play() as Promise<void> | undefined;
      played?.catch(() => undefined); // autoplay may be blocked before a user gesture
    });
  }

  stop(): void {
    const el = this.el;
    this.el = undefined;
    if (!el) return;
    el.pause();
    el.removeAttribute('src');
    el.load?.();
  }
}

/**
 * Generates a cadenced tone with Web Audio. The output goes through a
 * MediaStreamDestination into an <audio> element so it can honour setSinkId
 * (the selected ringer device).
 */
export class ToneLoopPlayer implements LoopPlayer {
  private ctx: AudioContext | undefined;
  private el: HTMLAudioElement | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly pattern: TonePattern,
    private readonly volume: number,
    private readonly createContext: () => AudioContext = () => new AudioContext(),
    private readonly createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {}

  start(sinkId: string | undefined, volumeScale = 1): void {
    this.stop();
    const ctx = this.createContext();
    this.ctx = ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    for (const f of this.pattern.frequencies) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start();
    }
    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);
    const el = this.createAudio();
    el.srcObject = dest.stream;
    this.el = el;
    void applySinkId(el, sinkId).then(() => {
      if (this.el === el) (el.play() as Promise<void> | undefined)?.catch(() => undefined);
    });
    const period = this.pattern.cadence.reduce((a, b) => a + b, 0);
    const level = (this.volume * volumeScale) / Math.max(1, this.pattern.frequencies.length);
    const scheduleCycle = () => {
      let t = ctx.currentTime;
      this.pattern.cadence.forEach((duration, i) => {
        gain.gain.setValueAtTime(i % 2 === 0 ? level : 0, t);
        t += duration;
      });
    };
    scheduleCycle();
    this.timer = setInterval(scheduleCycle, period * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const el = this.el;
    this.el = undefined;
    if (el) {
      el.pause();
      el.srcObject = null;
    }
    const ctx = this.ctx;
    this.ctx = undefined;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }
}
