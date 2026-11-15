import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { buildCsp } from './src/shared/csp';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Main and preload are bundled into single CommonJS files with every
 * dependency inlined (`externalizeDeps: false`): the packaged app then needs no
 * node_modules at all, which keeps electron-builder simple in a pnpm workspace,
 * and the sandboxed preload can only `require('electron')` anyway.
 */
const cjsOutput = { format: 'cjs' as const, entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs' };

/** Production CSP as a <meta> tag (the dev server gets a header from the main process). */
function cspMeta(): Plugin {
  return {
    name: 'sipkit-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!-- CSP -->',
        `<meta http-equiv="Content-Security-Policy" content="${buildCsp({ meta: true })}" />`,
      );
    },
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      externalizeDeps: false,
      rollupOptions: { input: { index: r('src/main/index.ts') }, output: cjsOutput },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      externalizeDeps: false,
      rollupOptions: { input: { index: r('src/preload/index.ts') }, output: { ...cjsOutput, inlineDynamicImports: true } },
    },
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react(), tailwindcss(), cspMeta()],
    resolve: {
      // Workspace sources directly, like apps/playground (no stale dist/).
      alias: [
        { find: /^sipkit-ui$/, replacement: r('../../packages/ui/src/index.ts') },
        { find: /^sipkit-core\/testing$/, replacement: r('../../packages/core/src/testing/index.ts') },
        { find: /^sipkit-core$/, replacement: r('../../packages/core/src/index.ts') },
        { find: /^sipkit-react\/testing$/, replacement: r('../../packages/react/src/testing/index.ts') },
        { find: /^sipkit-react$/, replacement: r('../../packages/react/src/index.ts') },
        // The widget's own `@/…` imports.
        { find: /^@\//, replacement: `${r('../../packages/ui/src')}/` },
      ],
    },
    build: {
      outDir: 'dist/renderer',
      chunkSizeWarningLimit: 2500,
      rollupOptions: { input: { index: r('src/renderer/index.html') } },
    },
  },
});
