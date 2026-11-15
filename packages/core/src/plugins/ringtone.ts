import { definePlugin } from '../plugin';
import type { SoftphoneSnapshot } from '../types';
import { RINGBACK_PATTERN, RINGTONE_PATTERN, ToneLoopPlayer, UrlLoopPlayer, type LoopPlayer } from './tone-player';

export interface RingtoneOptions {
  /** Overrides config.ringtoneUrl. Without a URL a Web Audio tone is generated. */
  ringtoneUrl?: string;
  /** Overrides config.ringbackUrl. */
  ringbackUrl?: string;
  /** 0..1, default 0.8. */
  volume?: number;
  /** Inject players (tests, custom sounds). */
  createPlayer?: (kind: 'ringtone' | 'ringback', url: string | undefined) => LoopPlayer;
}

/** Public API: `softphone.plugin<RingtoneApi>('ringtone')`. */
export interface RingtoneApi {
  /** What is currently playing. */
  readonly playing: 'ringtone' | 'ringback' | null;
  /** Silence the current ringtone until the ringing calls change. */
  silence(): void;
}

type Sound = 'ringtone' | 'ringback' | null;

/** Which sound the snapshot calls for: incoming ringing wins over outgoing ringback. */
export function desiredSound(snapshot: SoftphoneSnapshot): Sound {
  const unanswered = (s: string) => s === 'ringing' || s === 'setup';
  if (snapshot.calls.some((c) => c.direction === 'incoming' && unanswered(c.state))) return 'ringtone';
  // 'early' means the remote is sending audio (183), so no local ringback.
  if (snapshot.calls.some((c) => c.direction === 'outgoing' && c.state === 'ringing')) return 'ringback';
  return null;
}

/**
 * Plays the ringtone for incoming calls (on the selected ringer device) and
 * ringback for outgoing calls (on the speaker). Stops on answer/end.
 */
export function ringtonePlugin(options: RingtoneOptions = {}) {
  return definePlugin<RingtoneApi>({
    id: 'ringtone',
    setup({ api, config }) {
      const volume = Math.min(1, Math.max(0, options.volume ?? 0.8));
      const make =
        options.createPlayer ??
        ((kind: 'ringtone' | 'ringback', url: string | undefined): LoopPlayer =>
          url
            ? new UrlLoopPlayer(url, volume)
            : new ToneLoopPlayer(kind === 'ringtone' ? RINGTONE_PATTERN : RINGBACK_PATTERN, volume));
      const players: Partial<Record<'ringtone' | 'ringback', LoopPlayer>> = {};
      const player = (kind: 'ringtone' | 'ringback') =>
        (players[kind] ??= make(
          kind,
          kind === 'ringtone' ? (options.ringtoneUrl ?? config.ringtoneUrl) : (options.ringbackUrl ?? config.ringbackUrl),
        ));
      let playing: Sound = null;
      let silencedFor: string | null = null;
      const ringingKey = (s: SoftphoneSnapshot) =>
        s.calls.filter((c) => c.direction === 'incoming' && c.state === 'ringing').map((c) => c.id).join(',');

      const evaluate = (snapshot: SoftphoneSnapshot) => {
        let want = desiredSound(snapshot);
        if (want === 'ringtone' && silencedFor !== null && silencedFor === ringingKey(snapshot)) want = null;
        if (silencedFor !== null && silencedFor !== ringingKey(snapshot)) silencedFor = null;
        if (want === playing) return;
        if (playing) players[playing]?.stop();
        playing = want;
        if (want) {
          const { selected, volume } = snapshot.devices;
          const gain = (want === 'ringtone' ? volume?.ringer : volume?.speaker) ?? 1;
          player(want).start(want === 'ringtone' ? (selected.ringer ?? selected.speaker) : selected.speaker, gain);
        }
      };

      const unsubscribe = api.subscribe(evaluate);
      evaluate(api.getSnapshot());
      return {
        api: {
          get playing() {
            return playing;
          },
          silence() {
            silencedFor = ringingKey(api.getSnapshot());
            evaluate(api.getSnapshot());
          },
        },
        dispose() {
          unsubscribe();
          players.ringtone?.stop();
          players.ringback?.stop();
          playing = null;
        },
      };
    },
  });
}
