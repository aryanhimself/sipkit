import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServiceConfig } from './config.ts';
import { PushService, ValidationError, validCallId, validExtension } from './service.ts';
import { WebPushSender, type PushSender } from './sender.ts';
import { JsonFileStore, MemoryStore, type SubscriptionStore } from './store.ts';
import { safeEqual, verifyToken } from './tokens.ts';

/**
 * HTTP API (see docs/push.md):
 *
 *   GET    /health
 *   GET    /vapid-public-key                  -> { publicKey }
 *   POST   /subscriptions        (agent)      { extension?, subscription, userAgent? }
 *   GET    /subscriptions        (agent)      -> { extension, subscriptions: [...] }
 *   DELETE /subscriptions        (agent)      { extension?, endpoint? }
 *   POST   /notify/incoming      (PBX)        { extension, callId, callerId, callerName? }  JSON or form
 *   POST   /notify/cancel        (PBX)        { extension, callId, reason? }
 *   GET    /calls/:id/status     (PBX)        -> text/plain ringing | declined | cancelled | unknown
 *   POST   /calls/:id/decline    (signed)     { extension, exp, sig }  (from the service worker)
 *   POST   /admin/prune          (PBX secret) -> { pruned }
 *   GET    /debug/events         (PBX secret, PUSH_DEBUG=1)
 *
 * agent = `Authorization: Bearer <skp1 token | PUSH_DEV_TOKEN>`
 * PBX   = `X-Sipkit-Push-Secret: <PUSH_NOTIFY_SECRET>`
 */

const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    // Asterisk CURL() posts form data; accept it even without a content type.
    if (raw.includes('=')) return Object.fromEntries(new URLSearchParams(raw));
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (typeof body === 'string') {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export interface PushServerOptions {
  config: ServiceConfig;
  store?: SubscriptionStore;
  sender?: PushSender;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface PushServer {
  server: Server;
  service: PushService;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

export async function createPushServer(options: PushServerOptions): Promise<PushServer> {
  const cfg = options.config;
  const store = options.store ?? (cfg.storeFile ? await JsonFileStore.open(cfg.storeFile) : new MemoryStore());
  const sender =
    options.sender ??
    new WebPushSender({ publicKey: cfg.vapidPublicKey, privateKey: cfg.vapidPrivateKey, subject: cfg.vapidSubject });
  const service = new PushService({ config: cfg, store, sender, now: options.now, log: options.log });

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (!origin) return;
    if (cfg.corsOrigins.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (cfg.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else return;
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  };

  /** Agent auth: returns the extension the caller may manage. */
  const agent = (req: IncomingMessage, requested: unknown): string => {
    const header = req.headers.authorization ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
    if (!token) throw new HttpError(401, 'Missing bearer token');
    if (cfg.devToken && safeEqual(token, cfg.devToken)) {
      if (!validExtension(requested)) throw new HttpError(400, 'extension is required with the development token');
      return requested;
    }
    const claims = verifyToken(cfg.tokenSecret, token, (options.now ?? Date.now)());
    if (!claims) throw new HttpError(401, 'Invalid or expired token');
    if (requested !== undefined && requested !== '' && requested !== claims.sub) {
      throw new HttpError(403, 'Token is not valid for this extension');
    }
    return claims.sub;
  };

  const pbx = (req: IncomingMessage) => {
    const secret = req.headers['x-sipkit-push-secret'];
    if (typeof secret !== 'string' || !cfg.notifySecret || !safeEqual(secret, cfg.notifySecret)) {
      throw new HttpError(401, 'Invalid notify secret');
    }
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://push.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    cors(req, res);
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    if (method === 'GET' && path === '/vapid-public-key') return send(res, 200, { publicKey: service.vapidPublicKey });

    if (path === '/subscriptions') {
      if (method === 'POST') {
        const body = await readBody(req);
        const extension = agent(req, body.extension);
        await service.subscribe(extension, body.subscription, typeof body.userAgent === 'string' ? body.userAgent : req.headers['user-agent']);
        return send(res, 201, { ok: true, extension });
      }
      if (method === 'GET') {
        const extension = agent(req, url.searchParams.get('extension') ?? undefined);
        return send(res, 200, { extension, subscriptions: await service.list(extension) });
      }
      if (method === 'DELETE') {
        const body = await readBody(req);
        const extension = agent(req, body.extension);
        const endpoint = typeof body.endpoint === 'string' ? body.endpoint : undefined;
        return send(res, 200, { ok: true, removed: await service.unsubscribe(extension, endpoint) });
      }
    }

    if (method === 'POST' && path === '/notify/incoming') {
      pbx(req);
      const body = await readBody(req);
      return send(res, 200, await service.notifyIncoming(body as Parameters<PushService['notifyIncoming']>[0]));
    }
    if (method === 'POST' && path === '/notify/cancel') {
      pbx(req);
      const body = await readBody(req);
      return send(res, 200, await service.notifyCancel(body as Parameters<PushService['notifyCancel']>[0]));
    }

    const callMatch = /^\/calls\/([^/]+)\/(status|decline)$/.exec(path);
    if (callMatch) {
      const callId = decodeURIComponent(callMatch[1]!);
      if (!validCallId(callId)) throw new HttpError(400, 'callId is invalid');
      if (callMatch[2] === 'status' && method === 'GET') {
        pbx(req);
        return send(res, 200, service.callStatus(callId));
      }
      if (callMatch[2] === 'decline' && method === 'POST') {
        const body = await readBody(req);
        const ok = service.decline(callId, String(body.extension ?? ''), Number(body.exp), String(body.sig ?? ''));
        if (!ok) throw new HttpError(403, 'Invalid or expired decline signature');
        return send(res, 200, { ok: true });
      }
    }

    if (method === 'POST' && path === '/admin/prune') {
      pbx(req);
      return send(res, 200, { pruned: await service.prune() });
    }
    if (method === 'GET' && path === '/debug/events' && cfg.debug) {
      pbx(req);
      return send(res, 200, { events: service.recentEvents() });
    }
    throw new HttpError(404, 'Not found');
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      if (error instanceof ValidationError) return send(res, 400, { error: error.message });
      options.log?.('error', { error: String(error) });
      send(res, 500, { error: 'Internal error' });
    });
  };

  return { server: createServer(handler), service, handler };
}
