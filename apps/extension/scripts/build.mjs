#!/usr/bin/env node
/* global process, console, Buffer */
/**
 * Build the extension for one browser: `node scripts/build.mjs chrome|firefox`.
 *
 *   dist/<browser>/            unpacked extension (load it in the browser)
 *   dist/sipkit-<browser>-<version>.zip
 *
 * Environment (all optional):
 *   SIPKIT_EXT_ORIGINS      comma-separated match patterns of pages that may attach
 *                        (static content script + host permissions).
 *                        Default: http://localhost/*,http://127.0.0.1/*
 *   SIPKIT_EXT_SOFTPHONE_URL  page opened by "Open CRM" (default empty)
 *   SIPKIT_EXT_GECKO_ID     Firefox add-on id (default sipkit@sipkit.dev)
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { zipSync } from 'fflate';

const target = process.argv[2];
if (target !== 'chrome' && target !== 'firefox') {
  console.error('usage: build.mjs chrome|firefox');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = join(root, 'src');
const out = join(root, 'dist', target);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const origins = (process.env.SIPKIT_EXT_ORIGINS || 'http://localhost/*,http://127.0.0.1/*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const softphoneUrl = process.env.SIPKIT_EXT_SOFTPHONE_URL || '';
const geckoId = process.env.SIPKIT_EXT_GECKO_ID || 'sipkit@sipkit.dev';

const define = {
  __BROWSER__: JSON.stringify(target),
  __SIPKIT_EXT_VERSION__: JSON.stringify(pkg.version),
  __SIPKIT_DEFAULT_ORIGINS__: JSON.stringify(origins),
  __SIPKIT_SOFTPHONE_URL__: JSON.stringify(softphoneUrl),
  'process.env.NODE_ENV': JSON.stringify('production'),
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Extension pages (React popup, options, approval, Chrome offscreen host).
const pages = ['popup/popup.html', 'options/options.html', 'approve/approve.html'];
if (target === 'chrome') pages.push('offscreen/offscreen.html');
await build({
  configFile: false,
  logLevel: 'warn',
  root: src,
  base: '/',
  publicDir: join(root, 'public'),
  plugins: [react()],
  define,
  build: {
    outDir: out,
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    // The UI stylesheet is already built (Tailwind); don't re-minify it.
    cssMinify: false,
    modulePreload: { polyfill: false },
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p.split('/')[0], join(src, p)])) },
  },
});
// Pages at the extension root (popup.html, options.html, …). Assets use absolute /assets/ URLs.
for (const p of pages) {
  const [dir, file] = p.split('/');
  renameSync(join(out, dir, file), join(out, file));
  rmSync(join(out, dir), { recursive: true, force: true });
}

// 2. Classic scripts: background (service worker / event page) and the content script.
async function iife(entry, fileName) {
  await build({
    configFile: false,
    logLevel: 'warn',
    root,
    publicDir: false,
    define,
    build: {
      outDir: out,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: false,
      minify: true,
      lib: { entry: join(src, entry), formats: ['iife'], name: 'sipkit', fileName: () => fileName },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}
await iife(`background/${target}.ts`, 'background.js');
await iife('content/content.ts', 'content.js');

// 3. Icons (generated: no binaries in the repo).
mkdirSync(join(out, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(join(out, 'icons', `icon-${size}.png`), iconPng(size));

// 4. Manifest.
const icons = Object.fromEntries([16, 32, 48, 128].map((s) => [String(s), `icons/icon-${s}.png`]));
const manifest = {
  manifest_version: 3,
  name: '__MSG_extName__',
  short_name: 'SipKit',
  description: '__MSG_extDescription__',
  version: pkg.version,
  default_locale: 'en',
  icons,
  action: { default_popup: 'popup.html', default_title: '__MSG_extName__', default_icon: icons },
  options_ui: { page: 'options.html', open_in_tab: true },
  permissions: ['storage', 'notifications', 'contextMenus', 'scripting', ...(target === 'chrome' ? ['offscreen'] : [])],
  host_permissions: origins,
  optional_host_permissions: ['*://*/*'],
  content_scripts: [{ matches: origins, js: ['content.js'], run_at: 'document_start', all_frames: false }],
  omnibox: { keyword: 'call' },
  commands: {
    'answer-call': { suggested_key: { default: 'Alt+Shift+A' }, description: '__MSG_cmdAnswer__' },
    'hangup-call': { suggested_key: { default: 'Alt+Shift+H' }, description: '__MSG_cmdHangup__' },
  },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
  ...(target === 'chrome'
    ? { background: { service_worker: 'background.js' }, minimum_chrome_version: '116' }
    : {
        background: { scripts: ['background.js'] },
        browser_specific_settings: {
          // No data leaves the browser except to the user's own PBX.
          gecko: { id: geckoId, strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } },
        },
      }),
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 5. Zip.
const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files[relative(out, full).split('\\').join('/')] = readFileSync(full);
  }
})(out);
const zipPath = join(root, 'dist', `sipkit-${target}-${pkg.version}.zip`);
writeFileSync(zipPath, zipSync(files, { level: 9 }));
console.log(`built ${relative(root, out)} and ${relative(root, zipPath)} (${Object.keys(files).length} files)`);

/** A small PNG: brand-blue rounded square with a white handset dot. */
function iconPng(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = Math.min(Math.max(x + 0.5, r), size - r);
      const cy = Math.min(Math.max(y + 0.5, r), size - r);
      const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
      if (!inside) continue;
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const ring = d >= size * 0.2 && d <= size * 0.3;
      const [R, G, B] = ring || d < size * 0.09 ? [255, 255, 255] : [37, 99, 235];
      px[i] = R;
      px[i + 1] = G;
      px[i + 2] = B;
      px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
