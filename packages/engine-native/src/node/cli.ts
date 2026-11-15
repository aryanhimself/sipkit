#!/usr/bin/env node
/**
 * sipkit-native-sidecar: serve the native SIP protocol on top of a running baresip.
 *
 *   sipkit-native-sidecar --baresip 127.0.0.1:4444            # JSON lines on stdin/stdout
 *   sipkit-native-sidecar --baresip 127.0.0.1:4444 --listen 4555   # JSON lines over TCP (one client)
 *
 * The Electron main process (or any Node host) can instead embed `BaresipSidecar`
 * directly; this CLI exists for process isolation and manual testing.
 */
import { createServer } from 'node:net';
import { BaresipSidecar } from './baresip-sidecar';
import { JsonLinesTransport } from './json-lines';

function parseArgs(argv: string[]): { host: string; port: number; listen?: number } {
  let baresip = '127.0.0.1:4444';
  let listen: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--baresip') baresip = argv[++i] ?? baresip;
    else if (arg === '--listen') listen = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      process.stderr.write('usage: sipkit-native-sidecar [--baresip host:port] [--listen port]\n');
      process.exit(0);
    }
  }
  const colon = baresip.lastIndexOf(':');
  const host = colon > 0 ? baresip.slice(0, colon) : baresip;
  const port = colon > 0 ? Number(baresip.slice(colon + 1)) : 4444;
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`Invalid --baresip address "${baresip}"`);
  if (listen !== undefined && (!Number.isInteger(listen) || listen <= 0))
    throw new Error('Invalid --listen port');
  return { host, port, listen };
}

const { host, port, listen } = parseArgs(process.argv.slice(2));

if (listen === undefined) {
  const transport = new JsonLinesTransport(process.stdin, process.stdout);
  const sidecar = new BaresipSidecar(transport, { host, port });
  transport.onClose(() => {
    void sidecar.dispose().finally(() => process.exit(0));
  });
} else {
  const server = createServer((socket) => {
    const transport = new JsonLinesTransport(socket, socket, () => socket.destroy());
    new BaresipSidecar(transport, { host, port });
  });
  server.listen(listen, '127.0.0.1', () =>
    process.stderr.write(`sipkit-native-sidecar listening on 127.0.0.1:${listen}\n`),
  );
}
