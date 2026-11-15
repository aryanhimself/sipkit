import type { Call, CallId, ConferenceParticipant, EngineListener } from '../types';
import { SoftphoneError, toEngineError } from '../errors';
import { serverConferenceCapabilities } from '../conference-view';
import { CallCore, ESTABLISHED, isLocalHeld } from './call-core';
import type { CallRecord } from './call-registry';

/** The room leg may use a line beyond `maxLines` (the parties it replaces free theirs right after). */
const ROOM_LINE_LIMIT = 8;

export type { CallControlDeps } from './call-core';

/**
 * Full call control: the core (dialing, incoming policy, hold/mute/DTMF)
 * plus blind/attended transfer and local conference orchestration.
 */
export class CallControl extends CallCore {
  // ------------------------------------------------------------ transfers

  async transfer(target: string, callId?: CallId): Promise<void> {
    const record = this.resolve(callId);
    this.requireState(record, ESTABLISHED, 'transfer');
    this.requireNotAnchored(record, 'transfer');
    const { target: dest } = await this.prepareTarget(target);
    try {
      await this.d.engine.blindTransfer(record.engineId, dest);
    } catch (error) {
      throw toEngineError(error, 'Transfer');
    }
    // REFER accepted: our leg is no longer needed.
    this.end(record.call.id, 'transferred');
    await this.d.engine.hangup(record.engineId).catch(() => undefined);
  }

  async startAttendedTransfer(target: string, callId?: CallId): Promise<Call> {
    const original = this.resolve(callId);
    this.requireState(original, ESTABLISHED, 'transfer');
    this.requireNotAnchored(original, 'transfer');
    if (this.d.calls.freeLine(this.cfg.maxLines) === undefined) {
      throw new SoftphoneError('MAX_LINES', 'No free line for the consultation call');
    }
    const wasHeld = isLocalHeld(original.call.hold);
    await this.setHold(original, true);
    try {
      const consult = await this.call(target);
      return this.d.calls.patch(consult.id, { meta: { ...consult.meta, consultFor: original.call.id } }) ?? consult;
    } catch (error) {
      if (!wasHeld && this.d.calls.get(original.call.id)) {
        await this.setHold(original, false).catch(() => undefined);
      }
      throw error;
    }
  }

  async completeAttendedTransfer(originalCallId: CallId, consultCallId: CallId): Promise<void> {
    if (originalCallId === consultCallId) {
      throw new SoftphoneError('INVALID_ARGUMENT', 'Original and consult calls must differ');
    }
    const original = this.resolve(originalCallId);
    const consult = this.resolve(consultCallId);
    this.requireState(original, ESTABLISHED, 'transfer');
    this.requireState(consult, ESTABLISHED, 'transfer to');
    try {
      await this.d.engine.attendedTransfer(original.engineId, consult.engineId);
    } catch (error) {
      throw toEngineError(error, 'Attended transfer');
    }
    this.end(original.call.id, 'transferred');
    this.end(consult.call.id, 'transferred');
    await Promise.all([
      this.d.engine.hangup(original.engineId).catch(() => undefined),
      this.d.engine.hangup(consult.engineId).catch(() => undefined),
    ]);
  }

  async conference(callIds?: CallId[]): Promise<void> {
    if (this.cfg.conference.mode === 'server') return this.serverConference(callIds);
    const records = callIds
      ? callIds.map((id) => this.resolve(id))
      : this.d.calls.all().filter((r) => ESTABLISHED.has(r.call.state));
    for (const r of records) this.requireState(r, ESTABLISHED, 'conference');
    const ids = new Set([...records.map((r) => r.call.id), ...this.conferenceCallIds()]);
    if (ids.size < 2) throw new SoftphoneError('INVALID_STATE', 'A conference needs at least two established calls');
    const members = [...ids].map((id) => this.resolve(id));
    // Conferences are audio-only (V2-VID-01): cameras go off before mixing.
    await this.d.video?.dropForConference(members);
    for (const r of members) await this.setHold(r, false);
    const mixed = await this.d.conference.join(members.map((r) => r.engineId));
    const muted = members.some((r) => this.d.calls.get(r.call.id)?.call.muted);
    for (const r of members) this.d.calls.patch(r.call.id, { inConference: true, muted });
    this.d.conference.setMicMuted(muted);
    if (mixed) {
      // Mixed tracks carry the mic via the bridge; never mute them at sender level.
      for (const r of members) this.d.engine.setMuted(r.engineId, false);
    } else {
      this.d.notify({
        level: 'warning',
        title: 'Conference',
        message: 'Audio mixing unavailable; parties may not hear each other',
        code: 'conferenceMixingUnavailable',
      });
    }
    const first = members[0];
    if (first) this.d.setActive(first.call.id);
  }

  async removeFromConference(callId: CallId): Promise<void> {
    const record = this.resolve(callId);
    this.rejectServerConference(record, 'remove a party from');
    if (!record.call.inConference) throw new SoftphoneError('INVALID_STATE', 'Call is not in the conference');
    const wasActive = this.d.getActive() === record.call.id;
    const remaining = await this.d.conference.leave(record.engineId, { keepAlive: true });
    this.afterConferenceChange(remaining);
    const current = this.d.calls.patch(record.call.id, { inConference: false, partyMuted: false });
    if (!current) return; // ended meanwhile
    if (current.muted) this.d.engine.setMuted(record.engineId, true);
    await this.setHold(record, true);
    if (wasActive) {
      const next = remaining.map((id) => this.d.calls.byEngineId(id)).find((r) => r !== undefined);
      if (next) this.d.setActive(next.call.id);
    }
  }

  async splitConference(keepCallId?: CallId): Promise<void> {
    const members = this.conferenceCallIds()
      .map((id) => this.d.calls.get(id))
      .filter((r) => r !== undefined);
    if (members.length === 0) throw new SoftphoneError('INVALID_STATE', 'There is no conference to split');
    for (const r of members) this.rejectServerConference(r, 'split');
    const active = this.d.getActive();
    const keep =
      members.find((r) => r.call.id === keepCallId) ?? members.find((r) => r.call.id === active) ?? members[0]!;
    await this.d.conference.dissolve();
    for (const r of members) {
      const current = this.d.calls.patch(r.call.id, { inConference: false, partyMuted: false });
      if (current?.muted) this.d.engine.setMuted(r.engineId, true);
    }
    await Promise.all(
      members
        .filter((r) => r !== keep && this.d.calls.get(r.call.id))
        .map((r) => this.setHold(r, true).catch((e: unknown) => this.d.logger.warn(`Hold of ${r.call.id} after split failed`, e))),
    );
    if (this.d.calls.get(keep.call.id)) this.d.setActive(keep.call.id);
  }

  setPartyMuted(callId: CallId, muted: boolean): void {
    const record = this.resolve(callId);
    this.rejectServerConference(record, 'mute a party of');
    if (!record.call.inConference) throw new SoftphoneError('INVALID_STATE', 'Only conference parties can be muted individually');
    this.d.conference.setPartyMuted(record.engineId, muted);
    this.d.calls.patch(record.call.id, { partyMuted: muted });
  }

  // ------------------------------------------------------------ server (ConfBridge) conference

  private readonly joinWaiters = new Map<CallId, (connected: boolean) => void>();

  override handleProgress(engineId: string, progress: Parameters<EngineListener['onCallProgress']>[1]): void {
    super.handleProgress(engineId, progress);
    for (const [id, resolve] of this.joinWaiters) {
      const record = this.d.calls.get(id);
      if (!record) resolve(false);
      else if (ESTABLISHED.has(record.call.state)) resolve(true);
    }
  }

  private rejectServerConference(record: CallRecord, action: string): void {
    if (record.call.conference) {
      throw new SoftphoneError('NOT_SUPPORTED', `Cannot ${action} a server conference from the client (see conference capabilities)`);
    }
  }

  private roomCall(): CallRecord | undefined {
    return this.d.calls.all().find((r) => r.call.conference !== undefined);
  }

  /** Room extension: prefix + (serverRoom || own username). No techPrefix: the room lives on our PBX. */
  private roomTarget(): string {
    const { serverRoomPrefix, serverRoom } = this.cfg.conference;
    const room = serverRoom.trim() || this.cfg.username.trim();
    if (!room) throw new SoftphoneError('INVALID_STATE', 'No conference room (conference.serverRoom or username)');
    return `${serverRoomPrefix.trim()}${room}`;
  }

  /**
   * Server mode: join the ConfBridge room (once) and blind transfer every
   * party into it. A party whose REFER fails stays on its own (held) line.
   */
  private async serverConference(callIds?: CallId[]): Promise<void> {
    if (this.d.conference.memberIds.length > 0) {
      throw new SoftphoneError('INVALID_STATE', 'A local conference is running; split it first');
    }
    const existing = this.roomCall();
    const candidates = callIds
      ? callIds.map((id) => this.resolve(id))
      : this.d.calls.all().filter((r) => ESTABLISHED.has(r.call.state));
    const parties = candidates.filter((r) => !r.call.conference);
    for (const r of parties) this.requireState(r, ESTABLISHED, 'conference');
    for (const r of parties) this.requireNotAnchored(r, 'move into a server conference');
    if (parties.length < (existing ? 1 : 2)) {
      throw new SoftphoneError('INVALID_STATE', 'A conference needs at least two established calls');
    }
    const room = existing ?? (await this.joinRoom(parties));
    const target = room.call.conference!.room;
    let moved = 0;
    for (const party of parties) {
      if (!this.d.calls.get(party.call.id)) continue; // hung up meanwhile
      try {
        await this.d.engine.blindTransfer(party.engineId, target);
      } catch (error) {
        const who = party.call.remoteDisplayName ?? party.call.remoteNumber;
        this.d.logger.warn(`Moving ${who} into conference room ${target} failed`, error);
        this.d.notify({
          level: 'warning',
          title: 'Conference',
          message: `${who} could not be moved into the conference room`,
          code: 'conferenceTransferFailed',
          params: { name: who },
        });
        continue;
      }
      moved += 1;
      this.addParticipant(room.call.id, {
        id: party.call.id,
        remoteNumber: party.call.remoteNumber,
        remoteDisplayName: party.call.remoteDisplayName,
        joinedAt: Date.now(),
      });
      this.end(party.call.id, 'transferred');
      await this.d.engine.hangup(party.engineId).catch(() => undefined);
    }
    if (!existing && moved === 0) {
      await this.hangup(room.call.id).catch(() => undefined);
      throw new SoftphoneError('ENGINE_ERROR', 'No party could be moved into the conference room');
    }
    if (this.d.calls.get(room.call.id)) this.d.setActive(room.call.id);
  }

  private addParticipant(roomCallId: CallId, participant: ConferenceParticipant): void {
    const conference = this.d.calls.get(roomCallId)?.call.conference;
    if (!conference) return;
    this.d.calls.patch(roomCallId, {
      conference: { ...conference, participants: [...conference.participants, participant] },
    });
  }

  /** Hold the parties, dial the room as owner and wait until it answers. */
  private async joinRoom(parties: CallRecord[]): Promise<CallRecord> {
    const target = this.roomTarget();
    const line = this.d.calls.freeLine(Math.max(this.cfg.maxLines, ROOM_LINE_LIMIT));
    if (line === undefined) throw new SoftphoneError('MAX_LINES', 'No free line for the conference room');
    for (const r of parties) await this.setHold(r, true);
    const { serverEndOnLeave, serverJoinTimeout } = this.cfg.conference;
    this.d.logger.info(`Joining conference room ${target} on line ${line}`);
    const record = this.d.calls.create({ direction: 'outgoing', state: 'setup', line, remoteNumber: target });
    const id = record.call.id;
    this.d.calls.patch(id, {
      inConference: true,
      conference: { room: target, participants: [], capabilities: serverConferenceCapabilities(serverEndOnLeave) },
    });
    this.d.setActive(id);
    const connected = new Promise<boolean>((resolve) => {
      this.joinWaiters.set(id, (ok) => {
        this.joinWaiters.delete(id);
        resolve(ok);
      });
    });
    this.d.timers.set(`${id}:join`, serverJoinTimeout * 1000, () => this.joinWaiters.get(id)?.(false));
    const extraHeaders = [
      ...this.cfg.extraHeaders,
      'X-Sipkit-Conference: owner',
      ...(serverEndOnLeave ? ['X-Sipkit-Conference-End: yes'] : []),
    ];
    try {
      await this.d.engine.call(record.engineId, target, { extraHeaders });
    } catch (error) {
      this.joinWaiters.get(id)?.(false);
      this.end(id, 'failed');
      throw toEngineError(error, 'Joining the conference room');
    }
    if (!(await connected)) {
      const current = this.d.calls.get(id);
      if (current) await this.hangup(id).catch(() => undefined);
      throw new SoftphoneError('ENGINE_ERROR', `Conference room ${target} did not answer`);
    }
    this.d.timers.clear(`${id}:join`);
    return this.d.calls.get(id)!;
  }

  async dispose(): Promise<void> {
    for (const resolve of [...this.joinWaiters.values()]) resolve(false);
    await this.d.conference.dissolve();
  }
}
