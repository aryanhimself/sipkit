import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vite.config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: workspaceAliases() },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
});
