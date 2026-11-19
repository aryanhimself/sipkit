import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { defineConfig } from 'tsup';

const require = createRequire(import.meta.url);
const lib = '@sapphi-red/web-noise-suppressor';

/** Worklet + wasm files, copied next to the bundle so `new URL('./assets/…', import.meta.url)` resolves. */
const assets: Record<string, string> = {
  'rnnoise-worklet.js': `${lib}/rnnoiseWorklet.js`,
  'rnnoise.wasm': `${lib}/rnnoise.wasm`,
  'rnnoise_simd.wasm': `${lib}/rnnoise_simd.wasm`,
  'speex-worklet.js': `${lib}/speexWorklet.js`,
  'speex.wasm': `${lib}/speex.wasm`,
};

async function copyAssets(): Promise<void> {
  await mkdir('dist/assets', { recursive: true });
  for (const [name, specifier] of Object.entries(assets)) {
    const from = require.resolve(specifier);
    if (name.endsWith('.js')) {
      // The source maps are not shipped; drop the dangling reference.
      const code = await readFile(from, 'utf8');
      await writeFile(
        `dist/assets/${name}`,
        code.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n'),
      );
    } else {
      await copyFile(from, `dist/assets/${name}`);
    }
  }
  const libLicense = await readFile(
    require.resolve(`${lib}/rnnoise.wasm`).replace(/dist\/rnnoise\.wasm$/, 'LICENSE'),
    'utf8',
  );
  await writeFile('dist/assets/THIRD_PARTY_LICENSES.md', thirdPartyNotice(libLicense));
}

function thirdPartyNotice(libLicense: string): string {
  return `# Third-party licenses

Files in this folder, and the lazily loaded chunk next to \`index.js\`, come from
[${lib}](https://github.com/sapphi-red/web-noise-suppressor) (MIT), which builds on:

- RNNoise (https://github.com/xiph/rnnoise), BSD-3-Clause
- rnnoise-wasm (https://github.com/shiguredo/rnnoise-wasm), Apache-2.0 (license header kept in \`rnnoise-worklet.js\`)
- SpeexDSP (https://github.com/xiph/speexdsp), BSD-3-Clause, via speex-preprocess-wasm (https://github.com/sapphi-red/speex-preprocess-wasm)

## ${lib}

\`\`\`
${libLicense.trim()}
\`\`\`
`;
}

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  external: ['sipkit-core'],
  // Bundle the (tiny) node classes so the package works from a CDN without an import map entry for
  // it; the dynamic import in the source keeps it in its own lazily loaded chunk.
  noExternal: [lib],
  esbuildOptions(o) {
    o.chunkNames = 'noise-nodes-[hash]';
  },
  onSuccess: copyAssets,
});
