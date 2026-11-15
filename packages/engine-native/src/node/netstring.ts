/** Netstring framing ("<len>:<payload>,") as used by baresip's ctrl_tcp module. */

const MAX_LENGTH = 1024 * 1024;

export function encodeNetstring(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from(`${body.length}:`, 'ascii'), body, Buffer.from(',', 'ascii')]);
}

/** Incremental decoder: feed chunks, get complete payloads. Throws on malformed input. */
export class NetstringDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out: string[] = [];
    for (;;) {
      const colon = this.buffer.indexOf(0x3a);
      if (colon < 0) {
        if (this.buffer.length > 10) throw new Error('netstring: missing length prefix');
        return out;
      }
      const prefix = this.buffer.subarray(0, colon).toString('ascii');
      if (!/^\d{1,7}$/.test(prefix))
        throw new Error(`netstring: bad length "${prefix.slice(0, 16)}"`);
      const length = Number(prefix);
      if (length > MAX_LENGTH) throw new Error(`netstring: payload too large (${length})`);
      const end = colon + 1 + length;
      if (this.buffer.length < end + 1) return out;
      if (this.buffer[end] !== 0x2c) throw new Error('netstring: missing trailing comma');
      out.push(this.buffer.subarray(colon + 1, end).toString('utf8'));
      this.buffer = this.buffer.subarray(end + 1);
    }
  }
}
