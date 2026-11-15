import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve sipkit-core from its build when present, otherwise from source,
// so this package can be tested before/independently of the core build.
const coreDist = fileURLToPath(new URL('../core/dist/index.js', import.meta.url));
const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));
const coreTestingSrc = fileURLToPath(new URL('../core/src/testing/index.ts', import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: existsSync(coreDist)
      ? []
      : [
          { find: /^sipkit-core\/testing$/, replacement: coreTestingSrc },
          { find: /^sipkit-core$/, replacement: coreSrc },
        ],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
