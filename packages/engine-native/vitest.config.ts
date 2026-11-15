import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export const alias = [
  // Test against core's sources so this package does not depend on core's build output.
  {
    find: /^sipkit-core\/testing$/,
    replacement: fileURLToPath(new URL('../core/src/testing/index.ts', import.meta.url)),
  },
  {
    find: /^sipkit-core$/,
    replacement: fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
  },
];

// Default suite: protocol + unit tests against fake sidecars and a fake baresip. Fast, no Docker.
export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.contract.test.ts'],
  },
});
