import { defineConfig } from 'vitest/config';
import { alias } from './vitest.config';

// Opt-in: the shared engine contract (V1-TEST-02) against real baresip sidecars and Asterisk.
// Run via `pnpm --filter sipkit-engine-native test:contract` (scripts/contract.sh starts the containers).
export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['src/**/*.contract.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
