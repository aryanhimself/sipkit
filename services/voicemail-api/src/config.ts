/** Service configuration from environment variables (see .env.example). */
export interface ServiceConfig {
  port: number;
  host: string;
  spoolDir: string;
  defaultContext: string;
  corsOrigins: string[];
  tokenSecret?: string;
  tokenMaxTtl: number;
  /** "mailbox@context" → token. */
  staticTokens: Map<string, string>;
  devToken?: string;
  ami?: { host: string; port: number; username: string; secret: string };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const defaultContext = env.VM_DEFAULT_CONTEXT?.trim() || 'default';
  const staticTokens = new Map<string, string>();
  for (const item of list(env.VM_STATIC_TOKENS)) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error('VM_STATIC_TOKENS entries must look like "mailbox[@context]=token"');
    const box = item.slice(0, eq).trim();
    const token = item.slice(eq + 1).trim();
    if (token.length < 8) throw new Error(`VM_STATIC_TOKENS: token for ${box} is shorter than 8 characters`);
    staticTokens.set(box.includes('@') ? box : `${box}@${defaultContext}`, token);
  }
  const tokenSecret = env.VM_TOKEN_SECRET?.trim() || undefined;
  if (tokenSecret && tokenSecret.length < 32) throw new Error('VM_TOKEN_SECRET must be at least 32 characters');
  const devToken = env.VM_DEV_TOKEN?.trim() || undefined;
  if (devToken && devToken.length < 8) throw new Error('VM_DEV_TOKEN must be at least 8 characters');
  if (!tokenSecret && !devToken && staticTokens.size === 0)
    throw new Error('No authentication configured: set VM_TOKEN_SECRET, VM_STATIC_TOKENS or VM_DEV_TOKEN');
  const amiHost = env.AMI_HOST?.trim();
  const level = (env.LOG_LEVEL ?? 'info') as ServiceConfig['logLevel'];
  return {
    port: Number(env.PORT ?? 8090),
    host: env.HOST ?? '0.0.0.0',
    spoolDir: env.VM_SPOOL_DIR ?? '/var/spool/asterisk/voicemail',
    defaultContext,
    corsOrigins: list(env.VM_CORS_ORIGINS),
    tokenSecret,
    tokenMaxTtl: Number(env.VM_TOKEN_MAX_TTL ?? 86400),
    staticTokens,
    devToken,
    ami:
      amiHost && env.AMI_USERNAME && env.AMI_SECRET
        ? { host: amiHost, port: Number(env.AMI_PORT ?? 5038), username: env.AMI_USERNAME, secret: env.AMI_SECRET }
        : undefined,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
  };
}
