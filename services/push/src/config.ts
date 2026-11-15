/** Service configuration, read from environment variables (see .env.example). */
export interface ServiceConfig {
  port: number;
  host: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  /** HMAC secret for agent tokens (`skp1.…`) and signed call actions. */
  tokenSecret: string;
  /** Optional static token accepted for ANY extension. Development only. */
  devToken: string;
  /** Shared secret Asterisk sends in `X-Sipkit-Push-Secret` on /notify/* and /calls/:id/status. */
  notifySecret: string;
  /** JSON file for subscriptions; empty = in memory only. */
  storeFile: string;
  /** Allowed CORS origins (`*` = any). Agent auth is a bearer token, never a cookie. */
  corsOrigins: string[];
  /** Accept http:// and private push endpoints (local fake push servers in tests). Never in production. */
  allowInsecureEndpoints: boolean;
  /** Push endpoint host suffixes accepted when `allowInsecureEndpoints` is off. Empty = any https host. */
  endpointHosts: string[];
  /** Seconds a call notification lives (Web Push TTL, and the ring window). */
  callTtl: number;
  /** Public base URL of this service as browsers see it (for the decline action). Optional. */
  publicUrl: string;
  /** Max subscriptions kept per extension (oldest dropped first). */
  maxPerExtension: number;
  /** Expose GET /debug/events (recent notify / send events; needs the notify secret). */
  debug: boolean;
}

/** Push services of the major browsers (Chrome/Edge/Opera via FCM, Firefox, Safari, legacy Edge). */
export const DEFAULT_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];

const bool = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true' || v?.toLowerCase() === 'yes';
const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const cfg: ServiceConfig = {
    port: Number(env.PORT ?? env.PUSH_PORT ?? 8790),
    host: env.PUSH_HOST ?? '0.0.0.0',
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY ?? '',
    vapidSubject: env.VAPID_SUBJECT ?? 'mailto:ops@sipkit.example',
    tokenSecret: env.PUSH_TOKEN_SECRET ?? '',
    devToken: env.PUSH_DEV_TOKEN ?? '',
    notifySecret: env.PUSH_NOTIFY_SECRET ?? '',
    storeFile: env.PUSH_STORE_FILE ?? './data/subscriptions.json',
    corsOrigins: list(env.PUSH_CORS_ORIGINS ?? '*'),
    allowInsecureEndpoints: bool(env.PUSH_ALLOW_INSECURE_ENDPOINTS),
    endpointHosts: env.PUSH_ENDPOINT_HOSTS === undefined ? DEFAULT_ENDPOINT_HOSTS : list(env.PUSH_ENDPOINT_HOSTS),
    callTtl: Number(env.PUSH_CALL_TTL ?? 45),
    publicUrl: (env.PUSH_PUBLIC_URL ?? '').replace(/\/+$/, ''),
    maxPerExtension: Number(env.PUSH_MAX_PER_EXTENSION ?? 10),
    debug: bool(env.PUSH_DEBUG),
  };
  const problems: string[] = [];
  if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) problems.push('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required (pnpm gen:vapid)');
  if (!/^(mailto:|https:)/.test(cfg.vapidSubject)) problems.push('VAPID_SUBJECT must start with mailto: or https:');
  if (!cfg.tokenSecret && !cfg.devToken) problems.push('Set PUSH_TOKEN_SECRET (or PUSH_DEV_TOKEN for development)');
  if (cfg.tokenSecret && cfg.tokenSecret.length < 32) problems.push('PUSH_TOKEN_SECRET must be at least 32 characters');
  if (!cfg.notifySecret) problems.push('PUSH_NOTIFY_SECRET is required (Asterisk sends it on /notify/*)');
  if (!Number.isInteger(cfg.port) || cfg.port <= 0) problems.push('PORT must be a positive integer');
  if (!(cfg.callTtl >= 5 && cfg.callTtl <= 600)) problems.push('PUSH_CALL_TTL must be 5..600 seconds');
  if (problems.length) throw new Error(`Invalid push service configuration:\n  - ${problems.join('\n  - ')}`);
  return cfg;
}
