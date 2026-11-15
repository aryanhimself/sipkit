import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServiceConfig } from './config.js';
import { silentLogger, type Logger } from './logger.js';
import { noopRefresher, type MwiRefresher } from './mwi.js';
import { SpoolError, type Spool, type VoicemailMessage } from './spool.js';
import { safeEqual, verifyToken } from './token.js';

/**
 * Routes (all JSON unless noted, `Cache-Control: no-store`):
 *
 *   GET    /healthz
 *   GET    /v1/mailboxes/:mailbox/messages               → { mailbox, context, counts, messages }
 *   GET    /v1/mailboxes/:mailbox/messages/:id           → message
 *   GET    /v1/mailboxes/:mailbox/messages/:id/audio     → audio bytes (Range, HEAD)
 *   POST   /v1/mailboxes/:mailbox/messages/:id/read      → message (moved to Old)
 *   DELETE /v1/mailboxes/:mailbox/messages/:id           → 204
 *
 * `:mailbox` is "1001" (default context) or "1001@context". Auth: `Authorization:
 * Bearer <token>`; the audio route also accepts `?access_token=` so an `<audio src>`
 * can stream with a short-lived token.
 */
export type ServerConfig = Pick<
  ServiceConfig,
  'corsOrigins' | 'defaultContext' | 'tokenSecret' | 'tokenMaxTtl' | 'staticTokens' | 'devToken'
>;

export interface ServerDeps {
  config: ServerConfig;
  spool: Spool;
  refresher?: MwiRefresher;
  logger?: Logger;
  now?: () => number;
}

const ROUTE = /^\/v1\/mailboxes\/([^/]+)\/messages(?:\/([^/]+)(?:\/(audio|read))?)?\/?$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function counts(messages: VoicemailMessage[]) {
  const n = messages.filter((m) => m.folder === 'new');
  const o = messages.filter((m) => m.folder === 'old');
  return { new: n.length, old: o.length, urgentNew: n.filter((m) => m.urgent).length, urgentOld: o.filter((m) => m.urgent).length };
}

/** Parse a single `bytes=` range. null = ignore the header (serve 200), 'invalid' = 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or garbage: send the whole file (allowed by RFC 9110)
  const [, s, e] = m;
  if (!s && !e) return 'invalid';
  let start: number;
  let end: number;
  if (!s) {
    const suffix = Number(e);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(s);
    end = e ? Math.min(Number(e), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

export function createHandler(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, spool } = deps;
  const refresher = deps.refresher ?? noopRefresher;
  const log = deps.logger ?? silentLogger;
  const now = deps.now ?? Date.now;

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!origin) return;
    const allowed = config.corsOrigins.includes('*') || config.corsOrigins.includes(origin);
    if (!allowed) return;
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigins.includes('*') ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  }

  function splitMailbox(segment: string): { mailbox: string; context: string } {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new HttpError(400, 'bad_mailbox', 'Invalid mailbox');
    }
    const at = decoded.indexOf('@');
    return at < 0
      ? { mailbox: decoded, context: config.defaultContext }
      : { mailbox: decoded.slice(0, at), context: decoded.slice(at + 1) };
  }

  /** Throws 401/403 unless the token grants `mailbox@context`. */
  function authorize(token: string | undefined, mailbox: string, context: string): void {
    if (!token) throw new HttpError(401, 'unauthorized', 'Missing bearer token');
    const key = `${mailbox}@${context}`;
    if (config.devToken && safeEqual(token, config.devToken)) return;
    const fixed = config.staticTokens.get(key);
    if (fixed && safeEqual(token, fixed)) return;
    if (config.tokenSecret && token.startsWith('vm1.')) {
      const result = verifyToken(config.tokenSecret, token, { now: now(), maxTtlSeconds: config.tokenMaxTtl });
      if (!result.ok) throw new HttpError(401, 'unauthorized', `Invalid token (${result.reason})`);
      if (result.claims.mbx !== mailbox || result.claims.ctx !== context)
        throw new HttpError(403, 'forbidden', 'Token is not valid for this mailbox');
      return;
    }
    // A static token of another mailbox, or garbage: do not tell which.
    throw new HttpError(401, 'unauthorized', 'Invalid token');
  }

  function bearer(req: IncomingMessage): string | undefined {
    const h = req.headers.authorization;
    const m = h ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
    return m?.[1];
  }

  async function serveAudio(req: IncomingMessage, res: ServerResponse, mailbox: string, context: string, id: string) {
    const file = await spool.audio(context, mailbox, id);
    if (!file) throw new HttpError(404, 'not_found', 'No recording for this message');
    const headers: Record<string, string | number> = {
      'Content-Type': file.contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Last-Modified': new Date(file.mtimeMs).toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="voicemail-${id}.${file.path.split('.').pop()}"`,
    };
    const range = parseRange(req.headers.range, file.size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${file.size}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const status = range ? 206 : 200;
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    headers['Content-Length'] = file.size === 0 ? 0 : end - start + 1;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || file.size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(file.path, { start, end });
    stream.on('error', (e) => {
      log.warn('audio stream failed', { err: e.message });
      res.destroy(e);
    });
    stream.pipe(res);
  }

  function refreshMwi(context: string, mailbox: string): void {
    void refresher.refresh(context, mailbox).catch(() => false);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(req, res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Content-Length': 0 });
      res.end();
      return;
    }
    if (url.pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) return json(res, 200, { ok: true });

    const m = ROUTE.exec(url.pathname);
    if (!m) throw new HttpError(404, 'not_found', 'Not found');
    const { mailbox, context } = splitMailbox(m[1]!);
    let id: string | undefined;
    try {
      id = m[2] ? decodeURIComponent(m[2]) : undefined;
    } catch {
      throw new HttpError(400, 'bad_id', 'Invalid message id');
    }
    const action = m[3];
    // Validate names before auth so traversal attempts never reach the filesystem.
    spool.mailboxDir(context, mailbox);

    const token = bearer(req) ?? (action === 'audio' ? url.searchParams.get('access_token') ?? undefined : undefined);
    authorize(token, mailbox, context);

    if (!id) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Use GET');
      const messages = await spool.list(context, mailbox);
      return json(res, 200, { mailbox, context, counts: counts(messages), messages });
    }
    if (action === 'audio') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Use GET');
      return serveAudio(req, res, mailbox, context, id);
    }
    if (action === 'read') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST');
      const before = await spool.get(context, mailbox, id);
      const msg = await spool.markRead(context, mailbox, id);
      if (!msg) throw new HttpError(404, 'not_found', 'No such message');
      if (before?.folder === 'new') refreshMwi(context, mailbox);
      log.info('voicemail marked read', { mailbox, context, id });
      return json(res, 200, msg);
    }
    if (method === 'GET') {
      const msg = await spool.get(context, mailbox, id);
      if (!msg) throw new HttpError(404, 'not_found', 'No such message');
      return json(res, 200, msg);
    }
    if (method === 'DELETE') {
      const ok = await spool.remove(context, mailbox, id);
      if (!ok) throw new HttpError(404, 'not_found', 'No such message');
      refreshMwi(context, mailbox);
      log.info('voicemail deleted', { mailbox, context, id });
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError || error instanceof SpoolError) {
        if (error.status >= 500) log.error(error.message);
        if (!res.headersSent) json(res, error.status, { error: error.code, message: error.message });
        else res.destroy();
        return;
      }
      log.error('request failed', { err: error instanceof Error ? error.message : String(error), path: req.url?.split('?')[0] });
      if (!res.headersSent) json(res, 500, { error: 'internal', message: 'Internal error' });
      else res.destroy();
    });
  };
}

export function createVoicemailServer(deps: ServerDeps): Server {
  return createServer(createHandler(deps));
}
