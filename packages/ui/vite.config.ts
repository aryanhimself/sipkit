import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Alias } from 'vite';
import dts from 'vite-plugin-dts';
import { addDtsExtensions } from './build/dts-extensions';
import { unlayerCss } from './build/unlayer-css';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Workspace packages resolve to source so this package builds without (and
 * before) their builds. Core uses its build when present.
 */
export function workspaceAliases(): Alias[] {
  const coreDist = r('../core/dist/index.js');
  return [
    { find: '@', replacement: r('./src') },
    { find: /^sipkit-react\/testing$/, replacement: r('../react/src/testing/index.ts') },
    { find: /^sipkit-react$/, replacement: r('../react/src/index.ts') },
    ...(existsSync(coreDist)
      ? []
      : [
          { find: /^sipkit-core\/testing$/, replacement: r('../core/src/testing/index.ts') },
          { find: /^sipkit-core$/, replacement: r('../core/src/index.ts') },
        ]),
  ];
}

// Everything that is a dependency stays external in the ESM library build.
const external = [
  /^react($|\/)/,
  /^react-dom($|\/)/,
  /^sipkit-/,
  /^radix-ui($|\/)/,
  /^@radix-ui\//,
  /^lucide-react($|\/)/,
  /^sonner($|\/)/,
  'class-variance-authority',
  'clsx',
  'tailwind-merge',
];

export default defineConfig(({ mode }) => {
  const iife = mode === 'iife';
  if (mode === 'sw') {
    // Push service worker (V2-PUSH-01): dist/sipkit-push-sw.js, served by the host app.
    return {
      build: {
        emptyOutDir: false,
        outDir: 'dist',
        sourcemap: true,
        lib: {
          entry: r('./src/push/service-worker.ts'),
          formats: ['iife'],
          name: '__sipkitPushWorker',
          fileName: () => 'sipkit-push-sw.js',
        },
      },
    };
  }
  return {
    plugins: [
      react(),
      tailwindcss(),
      !iife &&
        dts({
          tsconfigPath: './tsconfig.json',
          include: ['src'],
          exclude: ['src/**/*.test.*', 'src/test/**'],
          // keep `sipkit-*` imports as package specifiers in the emitted .d.ts
          pathsToAliases: false,
          aliasesExclude: [/^sipkit-/],
          entryRoot: 'src',
          // explicit .js extensions so the types also resolve under node16/nodenext
          beforeWriteFile: addDtsExtensions(r('./src'), r('./dist')),
        }),
      !iife && unlayerCss('styles.css'),
    ],
    resolve: { alias: workspaceAliases() },
    define: iife ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {},
    build: iife
      ? {
          // Standalone bundle for <script> tags: React, Radix and core included.
          emptyOutDir: false,
          outDir: 'dist',
          sourcemap: true,
          lib: {
            entry: r('./src/embed.ts'),
            formats: ['iife'],
            name: '__sipkitSoftphoneBundle',
            fileName: () => 'sipkit.iife.js',
          },
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : {
          outDir: 'dist',
          sourcemap: true,
          cssCodeSplit: false,
          lib: {
            entry: { index: r('./src/index.ts'), embed: r('./src/embed.ts') },
            formats: ['es'],
            cssFileName: 'styles',
          },
          rollupOptions: { external },
        },
  };
});
