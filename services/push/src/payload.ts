/**
 * Message format shared with the softphone service worker
 * (sipkit-ui `sipkit-push-sw.js`). Bump `v` on breaking changes.
 */
export interface IncomingCallPush {
  v: 1;
  type: 'incoming-call';
  /** PBX call id (Asterisk `${UNIQUEID}`), also sent to the softphone as `X-Sipkit-Push-Id`. */
  callId: string;
  extension: string;
  callerId: string;
  callerName?: string;
  /** Epoch ms when the PBX asked for the push. */
  at: number;
  /** Seconds the call keeps ringing for (the notification is stale afterwards). */
  ttl: number;
  /** Signed decline action (no agent token needed): POST {serviceUrl}/calls/{callId}/decline. */
  decline?: { exp: number; sig: string; url?: string };
}

export interface CallCancelledPush {
  v: 1;
  type: 'call-cancelled';
  callId: string;
  extension: string;
  reason?: string;
}

export type PushPayload = IncomingCallPush | CallCancelledPush;
