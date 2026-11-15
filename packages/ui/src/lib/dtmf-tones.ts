/** Local DTMF feedback tones (ITU-T Q.23 frequencies) via Web Audio. No-op where unsupported. */
const FREQS: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], A: [697, 1633],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], B: [770, 1633],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], C: [852, 1633],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], D: [941, 1633],
};

type AudioContextCtor = typeof AudioContext;
let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor: AudioContextCtor | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

export function playDtmfTone(digit: string, durationMs = 120, volume = 0.08): void {
  const pair = FREQS[digit.toUpperCase()];
  const audio = pair ? getContext() : null;
  if (!pair || !audio) return;
  try {
    if (audio.state === 'suspended') void audio.resume();
    const gain = audio.createGain();
    gain.gain.value = volume;
    gain.connect(audio.destination);
    const t = audio.currentTime;
    for (const f of pair) {
      const osc = audio.createOscillator();
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + durationMs / 1000);
    }
    gain.gain.setTargetAtTime(0, t + durationMs / 1000 - 0.02, 0.01);
  } catch {
    /* ignore audio errors */
  }
}
