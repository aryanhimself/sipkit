/**
 * Minimal PNG encoder for generated icons (tray status dots, app icon), so the
 * repo needs no image toolchain. RGBA, 8 bit, no filtering.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode RGBA pixels (`width * height * 4` bytes) as PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A handset-ish round icon: filled circle in `rgb`, with an optional status dot
 * (`dot`) in the bottom-right corner. Anti-aliased edges.
 */
export function circleIcon(size: number, rgb: readonly [number, number, number], dot?: readonly [number, number, number]): Buffer {
  const px = new Uint8Array(size * size * 4);
  const paint = (cx: number, cy: number, radius: number, color: readonly [number, number, number]) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = Math.max(0, Math.min(1, radius - d + 0.5));
        if (a <= 0) continue;
        const i = (y * size + x) * 4;
        const prev = px[i + 3]! / 255;
        const outA = a + prev * (1 - a);
        for (let c = 0; c < 3; c++) px[i + c] = Math.round((color[c]! * a + px[i + c]! * prev * (1 - a)) / outA);
        px[i + 3] = Math.round(outA * 255);
      }
    }
  };
  paint(size / 2, size / 2, size / 2 - 1, rgb);
  if (dot) {
    const r = size * 0.22;
    paint(size - r - 1, size - r - 1, r + Math.max(1, size * 0.04), [255, 255, 255]);
    paint(size - r - 1, size - r - 1, r, dot);
  }
  return encodePng(size, size, px);
}
