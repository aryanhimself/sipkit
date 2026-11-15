/* global URL, console */
// Generates build/icon.png (1024x1024), the source electron-builder turns into
// .icns / .ico. Placeholder artwork until a brand icon is designed:
// replace build/icon.png with the real one (>= 512x512 PNG) and skip this script.
//
//   node --experimental-strip-types scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { circleIcon } from '../src/main/png.ts';

const out = fileURLToPath(new URL('../build/icon.png', import.meta.url));
writeFileSync(out, circleIcon(1024, [37, 99, 235], [22, 163, 74]));
console.log(`wrote ${out}`);
