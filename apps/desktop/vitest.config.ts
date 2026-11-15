import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^sipkit-core\/testing$/, replacement: r('../../packages/core/src/testing/index.ts') },
      { find: /^sipkit-core$/, replacement: r('../../packages/core/src/index.ts') },
      { find: /^sipkit-react\/testing$/, replacement: r('../../packages/react/src/testing/index.ts') },
      { find: /^sipkit-react$/, replacement: r('../../packages/react/src/index.ts') },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
