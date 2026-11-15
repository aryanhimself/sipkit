import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts', 'testing/index': 'src/testing/index.ts', 'remote/index': 'src/remote/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
