/** Validation of renderer → main IPC payloads. Pure, unit tested. */
import type { IncomingCallInfo } from './ipc';

const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function isCallId(value: unknown): value is string {
  return typeof value === 'string' && CALL_ID.test(value);
}

/** Accept only `{ callId, number, displayName? }` with sane lengths; strip control characters. */
export function parseCallInfo(raw: unknown): IncomingCallInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isCallId(r.callId) || typeof r.number !== 'string') return null;
  const number = r.number.replace(CONTROL, '').trim().slice(0, 128);
  if (!number) return null;
  const info: IncomingCallInfo = { callId: r.callId, number };
  if (typeof r.displayName === 'string') {
    const name = r.displayName.replace(CONTROL, '').trim().slice(0, 128);
    if (name) info.displayName = name;
  }
  return info;
}
