import { useEffect, useState } from 'react';
import type { Call } from 'sipkit-core';

/** Formats a duration in ms as m:ss or h:mm:ss. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface CallTimer {
  /** Elapsed talk time in ms (0 until connected). */
  elapsedMs: number;
  seconds: number;
  /** "m:ss" / "h:mm:ss" */
  formatted: string;
  running: boolean;
}

/**
 * Live talk-time for a call, ticking every `intervalMs` (default 1000) while
 * the call is connected or held. Accepts a call or null.
 */
export function useCallTimer(
  call: Pick<Call, 'connectedAt' | 'endedAt' | 'state'> | null | undefined,
  intervalMs = 1000,
): CallTimer {
  const connectedAt = call?.connectedAt;
  const endedAt = call?.endedAt;
  const running = Boolean(connectedAt && !endedAt && call?.state !== 'disconnected');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [running, intervalMs, connectedAt]);

  const elapsedMs = connectedAt ? Math.max(0, (endedAt ?? now) - connectedAt) : 0;
  return {
    elapsedMs,
    seconds: Math.floor(elapsedMs / 1000),
    formatted: formatDuration(elapsedMs),
    running,
  };
}
