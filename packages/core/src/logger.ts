import type { LogEntry, LogLevel, Logger } from './types';

const ORDER: Record<LogLevel | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LoggerOptions {
  level: LogLevel | 'silent';
  sink?: (entry: LogEntry) => void;
  console?: boolean;
}

const SECRET_KEY = /pass(word)?|secret|token|credential|authorization|registerheaders/i;
export const REDACTED = '[redacted]';

/**
 * Deep-copies plain objects/arrays, replacing values of secret-looking keys
 * (password, credential, token, …) so they never reach sinks or the console.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // Errors, class instances: leave as-is
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && v !== undefined && v !== '' ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/** Scoped logger that forwards entries to a sink (the Softphone emits them as `log` events). */
export function createLogger(scope: string, options: LoggerOptions): Logger {
  const write = (level: LogLevel, message: string, rawData?: unknown) => {
    if (ORDER[level] < ORDER[options.level]) return;
    const data = redact(rawData);
    const entry: LogEntry = { level, scope, message, data, at: Date.now() };
    options.sink?.(entry);
    if (options.console !== false) {
      // Call as methods: detached console functions throw in some environments.
      if (data === undefined) console[level](`[${scope}] ${message}`);
      else console[level](`[${scope}] ${message}`, data);
    }
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (child) => createLogger(`${scope}:${child}`, options),
  };
}
