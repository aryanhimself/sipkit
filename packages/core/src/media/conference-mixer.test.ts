import { describe, expect, it, vi } from 'vitest';
import { ConferenceMixer } from './conference-mixer';

/** Minimal Web Audio fake that records the connection graph. */
function fakeAudio() {
  const edges = new Set<string>();
  let n = 0;
  const node = (name: string) => {
    const self = {
      name: `${name}#${++n}`,
      gain: { value: 1 },
      connect: vi.fn((to: { name: string }) => void edges.add(`${self.name}->${to.name}`)),
      disconnect: vi.fn((to?: { name: string }) => {
        for (const e of [...edges]) if (e.startsWith(`${self.name}->`) && (!to || e.endsWith(`->${to.name}`))) edges.delete(e);
      }),
    };
    return self;
  };
  const ctx = {
    state: 'running',
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      ctx.state = 'closed';
    }),
    createGain: () => node('gain'),
    createMediaStreamSource: (s: { label?: string }) => node(`src(${s.label ?? 'mic'})`),
    createMediaStreamDestination: () => {
      const d = node('dest');
      const track = { id: d.name, stop: vi.fn() };
      return Object.assign(d, { stream: { getAudioTracks: () => [track], getTracks: () => [track] } });
    },
  };
  return { ctx: ctx as unknown as AudioContext, edges };
}

describe('ConferenceMixer', () => {
  it('routes mic + other parties into each destination, never a party to itself', () => {
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
    const { ctx, edges } = fakeAudio();
    const mixer = new ConferenceMixer(() => ctx);
    mixer.setMicrophone({} as MediaStreamTrack);
    const ta = mixer.addParty('a', { label: 'A' } as unknown as MediaStream);
    const tb = mixer.addParty('b', { label: 'B' } as unknown as MediaStream);
    mixer.addParty('c', { label: 'C' } as unknown as MediaStream);
    expect(ta.id).not.toBe(tb.id);
    const into = (dest: string) => [...edges].filter((e) => e.endsWith(`->${dest}`)).length;
    const dests = [...edges].map((e) => e.split('->')[1]!).filter((d) => d.startsWith('dest'));
    for (const d of new Set(dests)) expect(into(d)).toBe(3); // mic + 2 other parties
    mixer.removeParty('b');
    for (const d of new Set([...edges].map((e) => e.split('->')[1]!).filter((x) => x.startsWith('dest')))) {
      expect(into(d)).toBe(2);
    }
    expect(mixer.size).toBe(2);
    vi.unstubAllGlobals();
  });

  it('mutes the microphone via gain and closes the context', async () => {
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
    const { ctx } = fakeAudio();
    const mixer = new ConferenceMixer(() => ctx);
    mixer.setMicrophone({} as MediaStreamTrack);
    mixer.addParty('a', {} as MediaStream);
    mixer.setMicMuted(true);
    await mixer.close();
    expect(ctx.close).toHaveBeenCalled();
    expect(mixer.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('silences one party via its remote gain', () => {
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
    const gains: Array<{ gain: { value: number } }> = [];
    const { ctx } = fakeAudio();
    const createGain = ctx.createGain.bind(ctx);
    (ctx as unknown as { createGain: () => GainNode }).createGain = () => {
      const g = createGain();
      gains.push(g as unknown as { gain: { value: number } });
      return g;
    };
    const mixer = new ConferenceMixer(() => ctx);
    mixer.setMicrophone({} as MediaStreamTrack);
    mixer.addParty('a', {} as MediaStream);
    const remoteGainA = gains.at(-1)!;
    mixer.setPartyMuted('a', true);
    expect(remoteGainA.gain.value).toBe(0);
    mixer.setPartyMuted('a', false);
    expect(remoteGainA.gain.value).toBe(1);
    mixer.setPartyMuted('missing', true); // no-op
    vi.unstubAllGlobals();
  });
});
