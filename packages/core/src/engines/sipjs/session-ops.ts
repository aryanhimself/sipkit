import { Web, type Session, type URI } from 'sip.js';
import { abortableSleep, dtmfRelayBody, withTimeout } from './helpers';

const SIGNALLING_TIMEOUT_MS = 32_000; // SIP Timer F

/** The Web SessionDescriptionHandler of a session, if it has one yet. */
export function webSdh(session: Session): Web.SessionDescriptionHandler | undefined {
  const sdh = session.sessionDescriptionHandler;
  return sdh instanceof Web.SessionDescriptionHandler ? sdh : undefined;
}

/** Hold/resume via re-INVITE with a=sendonly / a=sendrecv (SIP.js `hold` SDH option). */
export async function reinviteHold(session: Session, hold: boolean): Promise<void> {
  const options: Web.SessionDescriptionHandlerOptions = { hold };
  session.sessionDescriptionHandlerOptionsReInvite = options;
  await withTimeout<void>(
    (resolve, reject) => {
      session
        .invite({
          requestDelegate: {
            onAccept: () => resolve(),
            onReject: (response) =>
              reject(new Error(`re-INVITE rejected (${response.message.statusCode ?? '?'})`)),
          },
        })
        .catch(reject);
    },
    SIGNALLING_TIMEOUT_MS,
    'Hold re-INVITE',
  );
}

/**
 * Enable/disable tracks to match hold + mute (media must stop even if the far end ignores sendonly).
 * Mute only silences audio; the camera (video sender) follows hold alone.
 */
export function applyTrackState(session: Session, held: boolean, muted: boolean): void {
  const pc = webSdh(session)?.peerConnection;
  if (!pc) return;
  for (const receiver of pc.getReceivers()) {
    if (receiver.track) receiver.track.enabled = !held;
  }
  for (const sender of pc.getSenders()) {
    if (sender.track) sender.track.enabled = sender.track.kind === 'video' ? !held : !held && !muted;
  }
}

/** Send REFER and resolve once the transferee accepts it (202). */
export function referAndWait(session: Session, referTo: URI | Session): Promise<void> {
  return withTimeout<void>(
    (resolve, reject) => {
      session
        .refer(referTo, {
          requestDelegate: {
            onAccept: () => resolve(),
            onReject: (response) => reject(new Error(`REFER rejected (${response.message.statusCode ?? '?'})`)),
          },
        })
        .catch(reject);
    },
    SIGNALLING_TIMEOUT_MS,
    'REFER',
  );
}

/**
 * Send DTMF. 'rfc2833' uses RTCDTMFSender (in-band RTP events), 'info' uses
 * SIP INFO application/dtmf-relay, 'auto' tries RFC 2833 then falls back to INFO
 * when the remote did not negotiate telephone-event.
 */
export async function sendDtmf(
  session: Session,
  tones: string,
  mode: 'auto' | 'rfc2833' | 'info',
  signal: AbortSignal,
): Promise<void> {
  if (mode !== 'info') {
    const sdh = webSdh(session);
    if (sdh?.sendDtmf(tones, { duration: 100, interToneGap: 70 })) return;
    if (mode === 'rfc2833') throw new Error('RFC 2833 DTMF not available on this call');
  }
  for (const tone of tones) {
    if (tone === ',') {
      await abortableSleep(2000, signal);
      continue;
    }
    await session.info({
      requestOptions: {
        body: { contentDisposition: 'render', contentType: 'application/dtmf-relay', content: dtmfRelayBody(tone) },
      },
    });
    await abortableSleep(100, signal);
  }
}

/** The RTCRtpSender carrying our audio. */
export function audioSender(session: Session): RTCRtpSender | undefined {
  const pc = webSdh(session)?.peerConnection;
  if (!pc) return undefined;
  const senders = pc.getSenders();
  return senders.find((s) => s.track?.kind === 'audio') ?? senders.find((s) => s.track === null);
}

/**
 * Swap the microphone track on a live call (device change, new voice processing settings);
 * also updates SIP.js' local stream so later operations see it.
 */
export async function replaceMicrophoneTrack(session: Session, track: MediaStreamTrack, enabled: boolean): Promise<void> {
  const sdh = webSdh(session);
  const sender = audioSender(session);
  if (!sdh || !sender) {
    track.stop();
    return;
  }
  track.enabled = enabled;
  const local = sdh.localMediaStream;
  const old = local.getAudioTracks()[0];
  // If the sender carries a different track (conference mix), only refresh the local stream.
  if (!sender.track || sender.track === old) await sender.replaceTrack(track);
  if (old) {
    local.removeTrack(old);
    old.stop();
  }
  local.addTrack(track);
}
