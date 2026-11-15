/**
 * JSON-lines transports for Node: the engine <-> sidecar protocol over any
 * Readable/Writable pair (child process stdio, TCP socket, pipes).
 */
import { connect, type Socket } from 'node:net';
import { spawn, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { encodeNativeMessage, type NativeMessage } from '../protocol';
import { TransportBase, type NativeSipTransport } from '../transport';

const MAX_LINE = 1024 * 1024;

export class JsonLinesTransport extends TransportBase implements NativeSipTransport {
  private buffer = '';

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onCloseHook?: () => void,
  ) {
    super();
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.onData(chunk));
    input.on('end', () => this.markClosed('end of stream'));
    input.on('close', () => this.markClosed('stream closed'));
    input.on('error', (error) => this.markClosed(error.message));
    output.on('error', (error) => this.markClosed(error.message));
  }

  send(message: NativeMessage): void {
    if (this.closed || this.output.destroyed) return;
    this.output.write(encodeNativeMessage(message));
  }

  close(): void {
    if (this.closed) return;
    this.markClosed('closed');
    this.onCloseHook?.();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          this.receive(JSON.parse(line));
        } catch {
          // Not JSON: ignore (e.g. a stray log line on stdout).
        }
      }
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_LINE) this.buffer = '';
  }
}

/** Engine side over a TCP socket to a sidecar listening with `sipkit-native-sidecar --listen`. */
export function connectTcpTransport(port: number, host = '127.0.0.1'): Promise<NativeSipTransport> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, host);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(new JsonLinesTransport(socket, socket, () => socket.destroy()));
    });
    socket.once('error', reject);
  });
}

/**
 * Engine side over a spawned sidecar process speaking JSON lines on stdio
 * (e.g. `node dist/node/cli.js --baresip 127.0.0.1:4444`). stderr is inherited.
 */
export function spawnSidecarTransport(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): NativeSipTransport {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], ...options });
  if (!child.stdout || !child.stdin) throw new Error('sidecar process has no stdio pipes');
  const transport = new JsonLinesTransport(child.stdout, child.stdin, () => child.kill());
  child.once('exit', () => transport.close());
  return transport;
}
