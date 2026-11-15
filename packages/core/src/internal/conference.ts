import type { Logger, SoftphoneEngine } from '../types';
import { ConferenceMixer } from '../media/conference-mixer';

/**
 * Bookkeeping + media wiring for the local conference. Works on engine call
 * ids. When the engine or environment cannot mix (no Web Audio, no
 * replaceOutgoingTrack, no streams), membership is still tracked so the UI
 * can show the conference, but audio is not bridged — callers are told via
 * the boolean returned from `join`.
 */
export class ConferenceController {
  private members = new Set<string>();
  private originals = new Map<string, MediaStreamTrack>();
  private mixer: ConferenceMixer | undefined;
  private micOwner: string | undefined;
  private partyMuted = new Set<string>();

  constructor(
    private readonly getEngine: () => SoftphoneEngine,
    private readonly logger: Logger,
    private readonly createMixer: () => ConferenceMixer | undefined = () =>
      ConferenceMixer.isSupported() ? new ConferenceMixer() : undefined,
  ) {}

  get memberIds(): string[] {
    return [...this.members];
  }

  has(engineId: string): boolean {
    return this.members.has(engineId);
  }

  get mixing(): boolean {
    return this.mixer !== undefined;
  }

  /** Add calls to the conference. Returns true if audio is being mixed. */
  async join(engineIds: string[]): Promise<boolean> {
    for (const id of engineIds) this.members.add(id);
    const engine = this.getEngine();
    if (!engine.replaceOutgoingTrack) {
      this.logger.warn('Engine cannot replace outgoing tracks; conference audio is not mixed');
      return false;
    }
    try {
      if (!this.mixer) {
        this.mixer = this.createMixer();
        if (!this.mixer) {
          this.logger.warn('Web Audio unavailable; conference audio is not mixed');
          return false;
        }
        if (!this.useMicFromAnyMember()) throw new Error('No local microphone track available');
      }
      for (const id of this.members) {
        if (this.mixer.has(id)) continue;
        const { local, remote } = engine.getMediaStreams(id);
        if (!remote) throw new Error(`No remote stream for ${id}`);
        const original = local?.getAudioTracks()[0];
        if (original) this.originals.set(id, original);
        const mixed = this.mixer.addParty(id, remote);
        if (this.partyMuted.has(id)) this.mixer.setPartyMuted(id, true);
        await engine.replaceOutgoingTrack(id, mixed);
      }
      return true;
    } catch (error) {
      this.logger.warn('Conference mixing failed; falling back to unmixed conference', error);
      await this.stopMixing();
      return false;
    }
  }

  /**
   * Remove a call. Returns the members left; if fewer than 2 remain, the
   * conference is dissolved. With `keepAlive` the call goes on as a separate
   * call, so its own microphone track is put back on its sender first.
   */
  async leave(engineId: string, { keepAlive = false }: { keepAlive?: boolean } = {}): Promise<string[]> {
    if (!this.members.delete(engineId)) return this.memberIds;
    this.applyPartyMuted(engineId, false);
    const original = this.originals.get(engineId);
    this.originals.delete(engineId);
    if (keepAlive && original && original.readyState !== 'ended') {
      await this.getEngine()
        .replaceOutgoingTrack?.(engineId, original)
        .catch((error: unknown) => this.logger.warn(`Failed to restore microphone for ${engineId}`, error));
    }
    this.mixer?.removeParty(engineId);
    if (this.members.size < 2) {
      const remaining = this.memberIds;
      await this.dissolve();
      return remaining;
    }
    // The leaving call's local track is about to be stopped (hangup) or disabled (hold).
    if (this.mixer && this.micOwner === engineId) this.useMicFromAnyMember();
    return this.memberIds;
  }

  /** True if this member's audio is silenced for everyone. */
  isPartyMuted(engineId: string): boolean {
    return this.partyMuted.has(engineId);
  }

  /**
   * Silence (or restore) one party for everyone: its remote track is disabled
   * (local playback and every mix that consumes it go silent) and its gain in
   * the bridge is zeroed as well.
   */
  setPartyMuted(engineId: string, muted: boolean): void {
    if (!this.members.has(engineId)) return;
    this.applyPartyMuted(engineId, muted);
  }

  private applyPartyMuted(engineId: string, muted: boolean): void {
    if (muted) this.partyMuted.add(engineId);
    else if (!this.partyMuted.delete(engineId)) return;
    for (const track of this.getEngine().getMediaStreams(engineId).remote?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
    this.mixer?.setPartyMuted(engineId, muted);
  }

  /** Mute the local microphone for every party (mute must not silence the bridge itself). */
  setMicMuted(muted: boolean): void {
    this.mixer?.setMicMuted(muted);
  }

  /** Restore every member's original microphone track and forget all members. */
  async dissolve(): Promise<void> {
    for (const id of [...this.partyMuted]) this.applyPartyMuted(id, false);
    await this.stopMixing();
    this.members.clear();
  }

  private async stopMixing(): Promise<void> {
    const engine = this.getEngine();
    const mixer = this.mixer;
    this.mixer = undefined;
    this.micOwner = undefined;
    for (const [id, track] of this.originals) {
      if (track.readyState === 'ended') continue;
      await engine.replaceOutgoingTrack?.(id, track).catch((error: unknown) => {
        this.logger.warn(`Failed to restore microphone for ${id}`, error);
      });
    }
    this.originals.clear();
    await mixer?.close();
  }

  private useMicFromAnyMember(): boolean {
    const engine = this.getEngine();
    for (const id of this.members) {
      const track = engine.getMediaStreams(id).local?.getAudioTracks()[0];
      if (track && track.readyState !== 'ended') {
        this.mixer?.setMicrophone(track);
        this.micOwner = id;
        return true;
      }
    }
    return false;
  }
}
