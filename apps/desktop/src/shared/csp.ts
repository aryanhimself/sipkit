/**
 * Content Security Policy for the renderer (V2-DESK-01). Injected as a <meta>
 * into index.html at build time and also sent as a response header by the main
 * process for the dev server.
 *
 * - Scripts only from the app bundle (no inline script, no eval) in production.
 * - `connect-src wss:` because the SIP server is user-configured.
 * - `style-src 'unsafe-inline'`: Radix / sonner set inline `style` attributes.
 * - Media from blob:/mediastream: for WebRTC audio/video elements.
 */
export interface CspOptions {
  /** Dev server origin (e.g. http://localhost:5173) to allow HMR. */
  devServer?: string;
  /** For a <meta> tag: drop directives browsers ignore there (frame-ancestors). */
  meta?: boolean;
}

export function buildCsp({ devServer, meta = false }: CspOptions = {}): string {
  const dev = Boolean(devServer);
  const devWs = devServer ? devServer.replace(/^http/, 'ws') : '';
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    // The React refresh preamble is an inline script in dev only.
    'script-src': ["'self'", ...(dev ? ["'unsafe-inline'", devServer!] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'", 'blob:', 'mediastream:', 'data:'],
    'connect-src': ["'self'", 'wss:', ...(dev ? [devServer!, devWs] : [])],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    ...(meta ? {} : { 'frame-ancestors': ["'none'"] }),
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}
