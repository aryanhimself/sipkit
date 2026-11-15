import type { Session } from 'sip.js';
import type { CallVideoStreams, EngineVideoState } from '../../types';
import { webSdh } from './session-ops';

/**
 * Video helpers for the SIP.js engine (V2-VID-01).
 *
 * Strategy (see docs/video.md):
 * - A video call negotiates `m=video` up front (getUserMedia audio+video).
 * - Camera off/on on a negotiated stream swaps the sender track
 *   (`replaceTrack(null)` + stop the camera / `replaceTrack(newTrack)`): no
 *   re-INVITE, so it cannot fail on glare or a PBX that mishandles stream
 *   changes, and the camera light really goes off.
 * - Camera on for an audio-only call adds a video transceiver and sends one
 *   re-INVITE (Asterisk propagates the new stream to the other leg).
 * - Answering a video offer without video marks the offered video inactive
 *   (SDP modifier on the remote offer), so the answer declines it instead of
 *   claiming `sendrecv` without a track; the transceiver is then stopped.
 */

/** True when an SDP body offers an active (port != 0) video stream. */
export function sdpOffersVideo(sdp: string | undefined): boolean {
  if (!sdp) return false;
  return /^m=video\s+([1-9]\d*)\s/m.test(sdp);
}

const isVideo = (t: RTCRtpTransceiver) => t.receiver.track?.kind === 'video';
const isStopped = (t: RTCRtpTransceiver) =>
  t.direction === 'stopped' || t.currentDirection === 'stopped' || (t as { stopped?: boolean }).stopped === true;

/** The (first) live video transceiver of a peer connection. */
export function videoTransceiver(pc: RTCPeerConnection | undefined): RTCRtpTransceiver | undefined {
  return pc?.getTransceivers().find((t) => isVideo(t) && !isStopped(t));
}

/** The negotiated direction lets us send on this transceiver. */
export const canSend = (t: RTCRtpTransceiver) => t.currentDirection === 'sendrecv' || t.currentDirection === 'sendonly';
const canReceive = (t: RTCRtpTransceiver) => t.currentDirection === 'sendrecv' || t.currentDirection === 'recvonly';

/**
 * SDP modifier for answering a video offer audio-only: marks the offered
 * video stream `a=inactive` in the *remote offer* (before it is applied), so
 * the browser answers video as inactive and the PBX sends us no video. Local
 * descriptions (type 'answer') pass through untouched. The engine stops the
 * video transceiver once the call is up, so later re-INVITEs reject it (port 0).
 */
export const declineVideoModifier = async (description: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> => {
  if (description.type !== 'offer' || !description.sdp) return description;
  return { ...description, sdp: inactivateVideo(description.sdp) };
};

/** Set every video m-section of an SDP to `a=inactive`. */
export function inactivateVideo(sdp: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const sections = sdp.split(/\r?\nm=/);
  return sections
    .map((section, i) => {
      if (i === 0 || !section.startsWith('video')) return section;
      const lines = section.split(/\r?\n/).filter((l) => !/^a=(sendrecv|sendonly|recvonly|inactive)\s*$/.test(l));
      const last = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      lines.splice(last, 0, 'a=inactive');
      return lines.join(eol);
    })
    .join(`${eol}m=`);
}

/** Stop the video transceiver of a call answered audio-only (sticky decline on later re-INVITEs). */
export function stopVideo(pc: RTCPeerConnection | undefined): void {
  for (const t of pc?.getTransceivers() ?? []) {
    if (isVideo(t) && !isStopped(t) && !t.sender.track) t.stop();
  }
}

/** Per-call video bookkeeping in the engine. */
export class CallVideo {
  /** The user wants the camera on. */
  wanted = false;
  /** Sticky "video negotiated" (kept while on hold, when directions say inactive). */
  negotiated = false;
  private streams: { local: MediaStream; remote: MediaStream } | undefined;
  private watched = new WeakSet<MediaStreamTrack>();
  private last = '';

  constructor(private readonly onChange: () => void) {}

  /** Stable video-only streams (created lazily: MediaStream only exists in browsers). */
  getStreams(session: Session): CallVideoStreams {
    if (typeof MediaStream === 'undefined') return {};
    this.streams ??= { local: new MediaStream(), remote: new MediaStream() };
    this.sync(session);
    return { ...this.streams };
  }

  /**
   * Recompute the state from the peer connection. Returns it when it (or the
   * video tracks) changed since the last call, otherwise undefined.
   */
  update(session: Session, held: boolean): EngineVideoState | undefined {
    const sdh = webSdh(session);
    const pc = sdh?.peerConnection;
    const tx = videoTransceiver(pc);
    if (!held) this.negotiated = Boolean(tx && tx.currentDirection && tx.currentDirection !== 'inactive');
    const sender = tx?.sender.track;
    const receiver = tx?.receiver.track;
    if (receiver && !this.watched.has(receiver)) {
      this.watched.add(receiver);
      receiver.addEventListener('mute', this.onChange);
      receiver.addEventListener('unmute', this.onChange);
      receiver.addEventListener('ended', this.onChange);
    }
    const state: EngineVideoState = {
      hasVideo: this.negotiated,
      cameraOn: Boolean(sender && sender.readyState === 'live'),
      remoteVideo: Boolean(
        this.negotiated && tx && (held || canReceive(tx)) && receiver && receiver.readyState === 'live' && !receiver.muted,
      ),
    };
    const tracks = this.sync(session);
    const key = `${state.hasVideo}|${state.cameraOn}|${state.remoteVideo}|${tracks}`;
    if (key === this.last) return undefined;
    this.last = key;
    return state;
  }

  /** Mirror the current video tracks into the stable streams; returns a key of the track ids. */
  private sync(session: Session): string {
    const sdh = webSdh(session);
    const pc = sdh?.peerConnection;
    const tx = videoTransceiver(pc);
    const local = tx?.sender.track && tx.sender.track.readyState === 'live' ? tx.sender.track : undefined;
    const remote = tx?.receiver.track ?? sdh?.remoteMediaStream.getVideoTracks()[0];
    if (this.streams) {
      setOnly(this.streams.local, local);
      setOnly(this.streams.remote, this.negotiated ? remote : undefined);
    }
    return `${local?.id ?? '-'}/${this.negotiated ? (remote?.id ?? '-') : '-'}`;
  }
}

/** Make `stream` contain exactly `track` (or nothing). */
function setOnly(stream: MediaStream, track: MediaStreamTrack | undefined): void {
  for (const t of stream.getTracks()) if (t !== track) stream.removeTrack(t);
  if (track && !stream.getTracks().includes(track)) stream.addTrack(track);
}

/** Put `track` into the SDH's local stream in place of any previous video track. */
export function swapLocalVideo(session: Session, track: MediaStreamTrack | undefined): void {
  const local = webSdh(session)?.localMediaStream;
  if (!local) return;
  for (const old of local.getVideoTracks()) {
    if (old === track) continue;
    local.removeTrack(old);
    old.stop();
  }
  if (track && !local.getTracks().includes(track)) local.addTrack(track);
}
