import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';
import { workspaceAliases } from '../../packages/ui/vite.config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const IIFE = r('../../packages/ui/dist/sipkit.iife.js');
const PUSH_SW_SRC = r('../../packages/ui/src/push/service-worker.ts');

/**
 * Serves / emits the push service worker shipped by sipkit-ui
 * (docs/push.md) at /sipkit-push-sw.js, compiled from source so edits apply
 * without a package build. Hosts serve `sipkit-ui/sipkit-push-sw.js`.
 */
function pushServiceWorker(): Plugin {
  const compile = async () =>
    (await transformWithEsbuild(readFileSync(PUSH_SW_SRC, 'utf8'), PUSH_SW_SRC, { loader: 'ts', format: 'iife', target: 'es2020' })).code;
  return {
    name: 'sipkit-push-sw',
    configureServer(server) {
      server.middlewares.use('/sipkit-push-sw.js', (_req, res) => {
        compile().then(
          (code) => {
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(code);
          },
          (error: unknown) => {
            res.statusCode = 500;
            res.end(`// ${String(error)}`);
          },
        );
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sipkit-push-sw.js', source: await compile() });
    },
  };
}

/**
 * Serves / emits the standalone web-component bundle built by
 * sipkit-ui (`pnpm --filter sipkit-ui build`) at
 * /sipkit.iife.js for public/embed-demo.html.
 */
function embedBundle(): Plugin {
  return {
    name: 'sipkit-embed-bundle',
    configureServer(server) {
      server.middlewares.use('/sipkit.iife.js', (_req, res) => {
        if (!existsSync(IIFE)) {
          res.statusCode = 404;
          res.end('// Build sipkit-ui first: pnpm --filter sipkit-ui build');
          return;
        }
        res.setHeader('Content-Type', 'application/javascript');
        createReadStream(IIFE).pipe(res);
      });
    },
    generateBundle() {
      if (existsSync(IIFE)) {
        this.emitFile({ type: 'asset', fileName: 'sipkit.iife.js', source: readFileSync(IIFE) });
      } else {
        this.warn('packages/ui/dist/sipkit.iife.js not found; embed-demo.html will not work');
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), embedBundle(), pushServiceWorker()],
  resolve: {
    // Use workspace sources directly (no build step, and edits to core/react/ui
    // hot-reload instead of silently using a stale dist/).
    alias: [
      { find: /^sipkit-ui$/, replacement: r('../../packages/ui/src/index.ts') },
      { find: /^sipkit-core\/testing$/, replacement: r('../../packages/core/src/testing/index.ts') },
      { find: /^sipkit-core$/, replacement: r('../../packages/core/src/index.ts') },
      ...workspaceAliases(),
    ],
  },
  build: { chunkSizeWarningLimit: 1500 },
  server: { port: 5173 },
  preview: { port: 4173 },
});
