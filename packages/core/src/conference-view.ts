import type { Call, ConferenceCapabilities } from './types';

/** Everything the local (browser-mixed) conference supports. */
export const LOCAL_CONFERENCE_CAPABILITIES: Readonly<ConferenceCapabilities> = Object.freeze({
  partyMute: true,
  removeParty: true,
  hangupParty: true,
  split: true,
  survivesLeave: false,
});

/**
 * Server (Asterisk ConfBridge) conference: per-party control would need the
 * PBX's admin interface (AMI/ARI), which a browser client does not have.
 */
export function serverConferenceCapabilities(endOnLeave: boolean): ConferenceCapabilities {
  return { partyMute: false, removeParty: false, hangupParty: false, split: false, survivesLeave: !endOnLeave };
}

/** One row of the conference roster. */
export interface ConferencePartyView {
  /** Call id (local) or participant id (server). */
  id: string;
  remoteNumber: string;
  remoteDisplayName?: string;
  /** Epoch ms the party's timer counts from. */
  since: number;
  /** Local mode: the party's own call (state, line, partyMuted). Absent in server mode. */
  call?: Call;
}

/** Mode-independent description of the current conference, for UIs. */
export interface ConferenceView {
  /** Your calls that make up the conference (local: every mixed call; server: your room leg). */
  calls: Call[];
  parties: ConferencePartyView[];
  capabilities: ConferenceCapabilities;
  /** Server mode: the room extension. */
  room?: string;
}

const live = (c: Call) => c.state !== 'disconnected';

/**
 * The current conference, or null. Local: two or more calls in the mix.
 * Server: your live room leg (even before the first party arrived).
 */
export function getConferenceView(calls: readonly Call[]): ConferenceView | null {
  const roomCall = calls.find((c) => c.conference && live(c));
  if (roomCall?.conference) {
    const { room, participants, capabilities } = roomCall.conference;
    return {
      calls: [roomCall],
      room,
      capabilities,
      parties: participants.map((p) => ({
        id: p.id,
        remoteNumber: p.remoteNumber,
        remoteDisplayName: p.remoteDisplayName,
        since: p.joinedAt,
      })),
    };
  }
  const members = calls.filter((c) => c.inConference && !c.conference && live(c));
  if (members.length < 2) return null;
  return {
    calls: members,
    capabilities: LOCAL_CONFERENCE_CAPABILITIES,
    parties: members.map((c) => ({
      id: c.id,
      remoteNumber: c.remoteNumber,
      remoteDisplayName: c.remoteDisplayName,
      since: c.connectedAt ?? c.createdAt,
      call: c,
    })),
  };
}
