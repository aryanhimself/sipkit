import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build the unpacked Chrome extension once (skip with SIPKIT_EXT_SKIP_BUILD=1). */
export default function globalSetup(): void {
  if (process.env.SIPKIT_EXT_SKIP_BUILD === '1') return;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs'), 'chrome'], { cwd: root, stdio: 'inherit' });
}
