import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Test against core's sources so this package does not depend on core's build output.
      {
        find: /^sipkit-core$/,
        replacement: fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
