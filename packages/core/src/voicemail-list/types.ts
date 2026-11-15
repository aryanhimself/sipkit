/**
 * Voicemail list (roadmap V2-VM-02) domain model, as served by
 * `services/voicemail-api`. Re-exported from `types.ts`.
 */

export interface VoicemailMessage {
  /** Stable id (Asterisk `msg_id`); survives mark-read and renumbering. */
  id: string;
  mailbox: string;
  context: string;
  /** `new` = unheard (INBOX), `old` = heard (Old). */
  folder: 'new' | 'old';
  urgent: boolean;
  /** Raw caller id, e.g. `"Agent 1001" <1001>`. */
  callerId: string;
  callerName?: string;
  /** Number to call back, when known. */
  callerNumber?: string;
  /** Epoch ms when the message was left. */
  timestamp: number;
  /** ISO 8601 of `timestamp`. */
  date: string;
  /** Seconds. */
  duration: number;
  /** A browser-playable recording exists. */
  hasAudio: boolean;
}

export type VoicemailListStatus = 'disabled' | 'idle' | 'loading' | 'ready' | 'error';

export interface VoicemailListState {
  /** `disabled` until `voicemail.enabled` and `voicemail.api.baseUrl` are set. */
  status: VoicemailListStatus;
  /** Newest first. Kept (stale) while a refresh is loading or after an error. */
  messages: VoicemailMessage[];
  /** Counts of `messages` by folder (the PBX's own MWI counts stay in `snapshot.voicemail`). */
  counts: { new: number; old: number };
  /** Error code of the last failed request: 'unauthorized' | 'forbidden' | 'not_found' | 'network' | 'timeout' | 'http'. */
  error?: string;
  /** Epoch ms of the last successful list. */
  updatedAt?: number;
  /** Ids with a mark-read / delete request in flight. */
  pending: string[];
}

export type VoicemailTokenProvider = () => string | Promise<string>;
