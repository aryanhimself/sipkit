import type { Softphone } from '../softphone';
import type { Call } from '../types';

/** Drain pending microtasks (async plugin hooks, engine promises). */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** The live call for a FakeEngine incoming engine id (matched via sipCallId). */
export function callByEngineIncoming(softphone: Softphone, engineId: string): Call {
  const call = softphone.getSnapshot().calls.find((c) => c.sipCallId === `sip-${engineId}`);
  if (!call) throw new Error(`No call for ${engineId}`);
  return call;
}
