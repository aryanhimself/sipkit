import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function tempSpool(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sipkit-vm-spool-'));
}

/** 8 kHz 16-bit mono PCM WAV of `samples` silent samples. */
export function wav(samples = 800): Buffer {
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(data, 40);
  return b;
}

export interface FakeMessage {
  folder?: 'INBOX' | 'Old' | 'Urgent';
  index: number;
  msgId?: string | null;
  callerid?: string;
  origtime?: number;
  duration?: number;
  /** Extensions to create besides .txt (default wav + gsm; not WAV: macOS file systems are case-insensitive). */
  formats?: string[];
}

export async function addMessage(root: string, mailbox: string, m: FakeMessage, context = 'default'): Promise<void> {
  const dir = join(root, context, mailbox, m.folder ?? 'INBOX');
  await mkdir(dir, { recursive: true });
  const n = String(m.index).padStart(4, '0');
  const origtime = m.origtime ?? 1794207189 + m.index;
  const lines = [
    ';',
    '; Message Information file',
    ';',
    '[message]',
    `origmailbox=${mailbox}`,
    'context=from-internal',
    `exten=8${mailbox}`,
    `callerid=${m.callerid ?? '"Agent 1001" <1001>'}`,
    `origtime=${origtime}`,
    ...(m.msgId === null ? [] : [`msg_id=${m.msgId ?? `${origtime}-${n}`}`]),
    'flag=',
    `duration=${m.duration ?? 9}`,
  ];
  await writeFile(join(dir, `msg${n}.txt`), `${lines.join('\n')}\n`);
  for (const ext of m.formats ?? ['wav', 'gsm']) await writeFile(join(dir, `msg${n}.${ext}`), wav(800 + m.index));
}
