import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * vite-plugin-dts `beforeWriteFile` hook: adds explicit `.js` / `/index.js`
 * extensions to relative specifiers in emitted declaration files, so the types
 * resolve under `moduleResolution: "node16" | "nodenext"` as well as "bundler".
 *
 * The emitted `dist/<path>.d.ts` mirrors `src/<path>.ts(x)`, so each specifier
 * is resolved against the source tree.
 */
export function addDtsExtensions(srcRoot: string, outRoot: string) {
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  const resolveSpecifier = (srcDir: string, spec: string): string => {
    if (/\.(js|mjs|cjs|json|css)$/.test(spec)) return spec;
    const base = resolve(srcDir, spec);
    if (['.ts', '.tsx', '.d.ts'].some((ext) => isFile(base + ext))) return `${spec}.js`;
    if (['index.ts', 'index.tsx', 'index.d.ts'].some((f) => isFile(join(base, f)))) return `${spec.replace(/\/$/, '')}/index.js`;
    return spec;
  };

  return (filePath: string, content: string) => {
    if (!filePath.endsWith('.d.ts')) return { filePath, content };
    const srcDir = resolve(srcRoot, relative(outRoot, dirname(filePath)));
    const fix = (_m: string, pre: string, quote: string, spec: string) =>
      `${pre}${quote}${resolveSpecifier(srcDir, spec)}${quote}`;
    const next = content
      .replace(/(\bfrom\s*)(['"])(\.{1,2}\/[^'"]*)\2/g, fix)
      .replace(/(\bimport\(\s*)(['"])(\.{1,2}\/[^'"]*)\2/g, fix);
    return { filePath, content: next };
  };
}
