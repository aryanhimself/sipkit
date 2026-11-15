import type { FetchLike } from './client';
import type { VoicemailMessage } from './types';

/**
 * In-memory stand-in for `services/voicemail-api` (same routes, JSON shapes and
 * status codes), used by the React MockSoftphone, unit tests and demos so the
 * voicemail list works without Asterisk. Recordings are generated tones.
 */
export interface MockVoicemailInput {
  callerNumber?: string;
  callerName?: string;
  duration?: number;
  folder?: 'new' | 'old';
  urgent?: boolean;
  timestamp?: number;
  id?: string;
}

export interface MockVoicemailBackend {
  /** Pass as `fetch` to a VoicemailClient / VoicemailListController. */
  fetch: FetchLike;
  /** Leave a message. Returns it. */
  add(input?: MockVoicemailInput): VoicemailMessage;
  /** Current messages, newest first. */
  messages(): VoicemailMessage[];
  counts(): { new: number; old: number };
  /** Make the next `n` requests fail with this HTTP status (e.g. 401, 500). */
  failNext(status: number, n?: number): void;
  /** Called after every change (add / read / delete) with the new counts, like an MWI NOTIFY. */
  onChange?: (counts: { new: number; old: number }) => void;
  /** Bearer token the backend demands ('' = any). */
  token: string;
  /** Every request as "METHOD /path", for assertions. */
  readonly requests: string[];
}

/** 16-bit mono PCM WAV with a quiet two-tone "voice" so the audio element has something to play. */
export function createToneWav(seconds = 1, sampleRate = 8000): Uint8Array {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const s = 0.15 * Math.sin(2 * Math.PI * 440 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

const ROUTE = /\/v1\/mailboxes\/([^/]+)\/messages(?:\/([^/?]+)(?:\/(audio|read))?)?\/?(?:\?.*)?$/;

export function createMockVoicemailBackend(
  initial: MockVoicemailInput[] = [],
  options: { mailbox?: string; context?: string; token?: string } = {},
): MockVoicemailBackend {
  const list: VoicemailMessage[] = [];
  let seq = 0;
  let failures: { status: number; left: number } | null = null;
  const requests: string[] = [];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const counts = () => {
    const n = list.filter((m) => m.folder === 'new').length;
    return { new: n, old: list.length - n };
  };
  const sorted = () => [...list].sort((a, b) => b.timestamp - a.timestamp);

  const backend: MockVoicemailBackend = {
    token: options.token ?? '',
    requests,
    add(input = {}) {
      seq++;
      const timestamp = input.timestamp ?? Date.now();
      const number = input.callerNumber ?? '5550100';
      const msg: VoicemailMessage = {
        id: input.id ?? `${Math.floor(timestamp / 1000)}-${String(seq).padStart(8, '0')}`,
        mailbox: options.mailbox ?? '1001',
        context: options.context ?? 'default',
        folder: input.folder ?? 'new',
        urgent: input.urgent ?? false,
        callerId: input.callerName ? `"${input.callerName}" <${number}>` : `<${number}>`,
        ...(input.callerName ? { callerName: input.callerName } : {}),
        callerNumber: number,
        timestamp,
        date: new Date(timestamp).toISOString(),
        duration: input.duration ?? 7,
        hasAudio: true,
      };
      list.push(msg);
      backend.onChange?.(counts());
      return msg;
    },
    messages: sorted,
    counts,
    failNext(status, n = 1) {
      failures = { status, left: n };
    },
    async fetch(input, init) {
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = new URL(input, 'http://mock.invalid');
      requests.push(`${method} ${url.pathname}`);
      await new Promise((r) => setTimeout(r, 30));
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (failures && failures.left > 0) {
        failures.left--;
        const status = failures.status;
        if (failures.left === 0) failures = null;
        return json(status, { error: 'mock', message: `Mock failure ${status}` });
      }
      const auth = new Headers(init?.headers).get('Authorization');
      if (backend.token && auth !== `Bearer ${backend.token}`) return json(401, { error: 'unauthorized', message: 'Invalid token' });
      const m = ROUTE.exec(url.pathname);
      if (!m) return json(404, { error: 'not_found', message: 'Not found' });
      const id = m[2] ? decodeURIComponent(m[2]) : undefined;
      const action = m[3];
      if (!id) {
        if (method !== 'GET') return json(405, { error: 'method_not_allowed', message: 'Use GET' });
        return json(200, { mailbox: decodeURIComponent(m[1]!), counts: counts(), messages: sorted() });
      }
      const index = list.findIndex((x) => x.id === id);
      if (index < 0) return json(404, { error: 'not_found', message: 'No such message' });
      const msg = list[index]!;
      if (action === 'audio') {
        const body = createToneWav(Math.min(msg.duration, 3));
        return new Response(new Blob([body as BlobPart], { type: 'audio/wav' }), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' },
        });
      }
      if (action === 'read') {
        if (method !== 'POST') return json(405, { error: 'method_not_allowed', message: 'Use POST' });
        const wasNew = msg.folder === 'new';
        const updated = { ...msg, folder: 'old' as const };
        list[index] = updated;
        if (wasNew) backend.onChange?.(counts());
        return json(200, updated);
      }
      if (method === 'DELETE') {
        list.splice(index, 1);
        backend.onChange?.(counts());
        return new Response(null, { status: 204 });
      }
      if (method === 'GET') return json(200, msg);
      return json(405, { error: 'method_not_allowed', message: 'Method not allowed' });
    },
  };
  // Seeded messages: one hour apart, oldest first.
  initial.forEach((item, i) => backend.add({ timestamp: Date.now() - (initial.length - i) * 3_600_000, ...item }));
  return backend;
}
