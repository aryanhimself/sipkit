import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'node/index': 'src/node/index.ts',
    'node/cli': 'src/node/cli.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts', 'node/index': 'src/node/index.ts' } },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  external: ['sipkit-core', /^node:/],
});
