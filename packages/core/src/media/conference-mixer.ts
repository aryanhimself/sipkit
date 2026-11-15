import type { CallId } from '../types';

interface Party {
  remoteSource: MediaStreamAudioSourceNode;
  remoteGain: GainNode;
  destination: MediaStreamAudioDestinationNode;
}

/**
 * Local N-way conference bridge built on the Web Audio API.
 *
 * Every party gets its own MediaStreamAudioDestinationNode whose track is
 * sent to that party (via the engine's replaceOutgoingTrack). Each
 * destination receives the local microphone plus every *other* party's
 * remote audio, so nobody hears themselves echoed back. The local user hears
 * all parties through the engine's normal remote playback.
 */
export class ConferenceMixer {
  private ctx: AudioContext | undefined;
  private micSource: MediaStreamAudioSourceNode | undefined;
  private micGain: GainNode | undefined;
  private parties = new Map<CallId, Party>();

  constructor(private readonly createContext: () => AudioContext = () => new AudioContext()) {}

  /** True if a Web Audio implementation exists in this environment. */
  static isSupported(): boolean {
    return typeof (globalThis as { AudioContext?: unknown }).AudioContext === 'function';
  }

  get size(): number {
    return this.parties.size;
  }

  has(id: CallId): boolean {
    return this.parties.has(id);
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = this.createContext();
      this.micGain = this.ctx.createGain();
      void this.ctx.resume?.().catch(() => undefined);
    }
    return this.ctx;
  }

  /** Set (or replace) the local microphone feeding every party. */
  setMicrophone(track: MediaStreamTrack): void {
    const ctx = this.context();
    this.micSource?.disconnect();
    this.micSource = ctx.createMediaStreamSource(new MediaStream([track]));
    this.micSource.connect(this.micGain!);
  }

  setMicMuted(muted: boolean): void {
    if (this.micGain) this.micGain.gain.value = muted ? 0 : 1;
  }

  /** Add a party. Returns the mixed track that must be sent to that party. */
  addParty(id: CallId, remote: MediaStream): MediaStreamTrack {
    if (this.parties.has(id)) this.removeParty(id);
    const ctx = this.context();
    const destination = ctx.createMediaStreamDestination();
    const remoteSource = ctx.createMediaStreamSource(remote);
    const remoteGain = ctx.createGain();
    remoteSource.connect(remoteGain);
    this.micGain!.connect(destination);
    for (const other of this.parties.values()) {
      other.remoteGain.connect(destination);
      remoteGain.connect(other.destination);
    }
    this.parties.set(id, { remoteSource, remoteGain, destination });
    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('Mixer destination produced no audio track');
    return track;
  }

  /** Silence (or restore) one party's audio in every other party's mix. */
  setPartyMuted(id: CallId, muted: boolean): void {
    const party = this.parties.get(id);
    if (party) party.remoteGain.gain.value = muted ? 0 : 1;
  }

  /** Remove a party and unwire it from every other party's mix. */
  removeParty(id: CallId): void {
    const party = this.parties.get(id);
    if (!party) return;
    this.parties.delete(id);
    party.remoteSource.disconnect();
    party.remoteGain.disconnect();
    safeDisconnect(this.micGain, party.destination);
    for (const other of this.parties.values()) safeDisconnect(other.remoteGain, party.destination);
    party.destination.stream.getTracks().forEach((t) => t.stop());
  }

  /** Tear everything down and close the AudioContext. */
  async close(): Promise<void> {
    for (const id of [...this.parties.keys()]) this.removeParty(id);
    this.micSource?.disconnect();
    this.micGain?.disconnect();
    const ctx = this.ctx;
    this.ctx = undefined;
    this.micSource = undefined;
    this.micGain = undefined;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => undefined);
  }
}

function safeDisconnect(from: AudioNode | undefined, to: AudioNode): void {
  try {
    from?.disconnect(to);
  } catch {
    /* not connected */
  }
}
