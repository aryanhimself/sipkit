import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { KeyedMutex, lockFolder, type LockOptions } from './lock.js';

/**
 * Read/write access to the app_voicemail file spool:
 *
 *   <root>/<context>/<mailbox>/{INBOX,Old,Urgent}/msgNNNN.{txt,wav,WAV,gsm,...}
 *
 * Messages are addressed by their `msg_id` (stable across moves and renumbering,
 * written by Asterisk 11+). Folders are kept contiguous (msg0000..msgN-1) after
 * every move/delete, like app_voicemail does when it closes a mailbox, because
 * Asterisk derives the next free slot from the highest index.
 */

export type SpoolFolder = 'INBOX' | 'Urgent' | 'Old';
const FOLDERS: SpoolFolder[] = ['INBOX', 'Urgent', 'Old'];

export interface VoicemailMessage {
  /** Stable id (Asterisk `msg_id`, else "<folder>-<index>"). */
  id: string;
  mailbox: string;
  context: string;
  /** `new` = INBOX / Urgent (unheard), `old` = Old (heard). */
  folder: 'new' | 'old';
  urgent: boolean;
  /** Raw `callerid` line, e.g. `"Agent 1001" <1001>`. */
  callerId: string;
  callerName?: string;
  callerNumber?: string;
  /** Recording start, epoch ms (`origtime`). */
  timestamp: number;
  /** ISO 8601 of `timestamp`. */
  date: string;
  /** Seconds (`duration`). */
  duration: number;
  /** A browser-playable recording exists. */
  hasAudio: boolean;
}

export interface AudioFile {
  path: string;
  size: number;
  contentType: string;
  mtimeMs: number;
}

/** Recording formats in order of preference for browsers. `.WAV` (wav49 = GSM in WAV) is last-resort. */
const AUDIO_TYPES: [ext: string, type: string, playable: boolean][] = [
  ['wav', 'audio/wav', true],
  ['mp3', 'audio/mpeg', true],
  ['ogg', 'audio/ogg', true],
  ['WAV', 'audio/wav', false],
  ['gsm', 'audio/x-gsm', false],
];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,79}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MSG_RE = /^msg(\d{4})\.([A-Za-z0-9]+)$/;

/** Mailbox / context names: no separators, no dot segments. */
export function isSafeName(value: string): boolean {
  return NAME_RE.test(value) && !value.includes('..');
}

export function isSafeId(value: string): boolean {
  return ID_RE.test(value);
}

export class SpoolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Parse the `[message]` ini section of msgNNNN.txt. */
export function parseMessageInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** `"Agent 1001" <1001>` → name + number; `1001` → number; `Unknown` → neither. */
export function parseCallerId(raw: string): { name?: string; number?: string } {
  const m = /^\s*(?:"([^"]*)"|([^<]*?))\s*<([^>]*)>\s*$/.exec(raw);
  if (m) {
    const name = (m[1] ?? m[2] ?? '').trim();
    const number = (m[3] ?? '').trim();
    return { ...(name ? { name } : {}), ...(number ? { number } : {}) };
  }
  const v = raw.trim();
  if (!v || /^unknown$/i.test(v)) return {};
  return /^[+*#\d\s()-]+$/.test(v) ? { number: v.replace(/\s+/g, '') } : { name: v };
}

const pad = (n: number) => String(n).padStart(4, '0');

interface Entry {
  folder: SpoolFolder;
  index: number;
  info: Record<string, string>;
  files: string[];
}

export interface SpoolOptions {
  root: string;
  lock?: LockOptions;
}

export class Spool {
  readonly root: string;
  private readonly mutex = new KeyedMutex();

  constructor(private readonly opts: SpoolOptions) {
    this.root = resolve(opts.root);
  }

  /** Absolute mailbox directory; throws on unsafe names or anything resolving outside the root. */
  mailboxDir(context: string, mailbox: string): string {
    if (!isSafeName(context) || !isSafeName(mailbox)) throw new SpoolError(400, 'bad_mailbox', 'Invalid mailbox or context');
    const dir = resolve(this.root, context, mailbox);
    if (!dir.startsWith(this.root + sep)) throw new SpoolError(400, 'bad_mailbox', 'Invalid mailbox or context');
    return dir;
  }

  async list(context: string, mailbox: string): Promise<VoicemailMessage[]> {
    const dir = this.mailboxDir(context, mailbox);
    const entries = (await Promise.all(FOLDERS.map((f) => this.readFolder(dir, f)))).flat();
    return entries
      .map((e) => this.toMessage(e, context, mailbox))
      .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  }

  async get(context: string, mailbox: string, id: string): Promise<VoicemailMessage | null> {
    const dir = this.mailboxDir(context, mailbox);
    const entry = await this.find(dir, id);
    return entry ? this.toMessage(entry, context, mailbox) : null;
  }

  /** The best browser-playable recording of a message, else any recording, else null. */
  async audio(context: string, mailbox: string, id: string): Promise<AudioFile | null> {
    const dir = this.mailboxDir(context, mailbox);
    const entry = await this.find(dir, id);
    if (!entry) return null;
    for (const [ext, contentType] of AUDIO_TYPES) {
      const name = `msg${pad(entry.index)}.${ext}`;
      if (!entry.files.includes(name)) continue;
      const path = join(dir, entry.folder, name);
      const st = await stat(path).catch(() => null);
      if (st?.isFile()) return { path, size: st.size, contentType, mtimeMs: st.mtimeMs };
    }
    return null;
  }

  /** INBOX/Urgent → Old (no-op when already old). Returns the updated message, null when not found. */
  async markRead(context: string, mailbox: string, id: string): Promise<VoicemailMessage | null> {
    const dir = this.mailboxDir(context, mailbox);
    return this.mutex.run(dir, async () => {
      const entry = await this.find(dir, id);
      if (!entry) return null;
      if (entry.folder === 'Old') return this.toMessage(entry, context, mailbox);
      const oldDir = join(dir, 'Old');
      await mkdir(oldDir, { recursive: true });
      await this.withLocks([join(dir, entry.folder), oldDir], async () => {
        // Re-read under the lock: Asterisk may have renumbered meanwhile.
        const fresh = await this.find(dir, id);
        if (!fresh || fresh.folder === 'Old') return;
        const target = (await this.indices(oldDir)).reduce((max, i) => Math.max(max, i), -1) + 1;
        for (const file of fresh.files) {
          const ext = MSG_RE.exec(file)?.[2];
          if (ext) await rename(join(dir, fresh.folder, file), join(oldDir, `msg${pad(target)}.${ext}`));
        }
        await this.resequence(join(dir, fresh.folder));
      });
      const moved = await this.find(dir, id);
      return moved ? this.toMessage(moved, context, mailbox) : null;
    });
  }

  /** Delete every file of a message and close the gap. False when not found. */
  async remove(context: string, mailbox: string, id: string): Promise<boolean> {
    const dir = this.mailboxDir(context, mailbox);
    return this.mutex.run(dir, async () => {
      const entry = await this.find(dir, id);
      if (!entry) return false;
      const folderDir = join(dir, entry.folder);
      let removed = false;
      await this.withLocks([folderDir], async () => {
        const fresh = await this.find(dir, id);
        if (!fresh) return;
        for (const file of fresh.files) await unlink(join(dir, fresh.folder, file)).catch(() => undefined);
        await this.resequence(join(dir, fresh.folder));
        removed = true;
      });
      return removed;
    });
  }

  // ---------------------------------------------------------------- internals

  private async withLocks(dirs: string[], fn: () => Promise<void>): Promise<void> {
    const releases: (() => Promise<void>)[] = [];
    try {
      for (const d of [...new Set(dirs)].sort()) releases.push(await lockFolder(d, this.opts.lock));
      await fn();
    } finally {
      for (const r of releases.reverse()) await r();
    }
  }

  private async names(folderDir: string): Promise<string[]> {
    try {
      return await readdir(folderDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async indices(folderDir: string): Promise<number[]> {
    const set = new Set<number>();
    for (const n of await this.names(folderDir)) {
      const m = MSG_RE.exec(n);
      if (m) set.add(Number(m[1]));
    }
    return [...set].sort((a, b) => a - b);
  }

  /** Rename msgNNNN.* so the folder is contiguous from msg0000 (app_voicemail resequence). */
  private async resequence(folderDir: string): Promise<void> {
    const names = await this.names(folderDir);
    const byIndex = new Map<number, string[]>();
    for (const n of names) {
      const m = MSG_RE.exec(n);
      if (!m) continue;
      const i = Number(m[1]);
      byIndex.set(i, [...(byIndex.get(i) ?? []), n]);
    }
    const sorted = [...byIndex.keys()].sort((a, b) => a - b);
    for (let next = 0; next < sorted.length; next++) {
      const idx = sorted[next]!;
      if (idx === next) continue;
      for (const file of byIndex.get(idx)!) {
        const ext = MSG_RE.exec(file)![2]!;
        await rename(join(folderDir, file), join(folderDir, `msg${pad(next)}.${ext}`));
      }
    }
  }

  private async readFolder(dir: string, folder: SpoolFolder): Promise<Entry[]> {
    const folderDir = join(dir, folder);
    const names = await this.names(folderDir);
    const files = new Map<number, string[]>();
    for (const n of names) {
      const m = MSG_RE.exec(n);
      if (!m) continue;
      const i = Number(m[1]);
      files.set(i, [...(files.get(i) ?? []), n]);
    }
    const out: Entry[] = [];
    for (const [index, list] of files) {
      const txt = `msg${pad(index)}.txt`;
      if (!list.includes(txt)) continue; // recording in progress or orphaned audio
      const text = await readFile(join(folderDir, txt), 'utf8').catch(() => null);
      if (text === null) continue;
      out.push({ folder, index, info: parseMessageInfo(text), files: list });
    }
    return out;
  }

  private idOf(e: Entry): string {
    const msgId = e.info.msg_id;
    return msgId && isSafeId(msgId) ? msgId : `${e.folder}-${pad(e.index)}`;
  }

  private async find(dir: string, id: string): Promise<Entry | null> {
    if (!isSafeId(id)) throw new SpoolError(400, 'bad_id', 'Invalid message id');
    for (const folder of FOLDERS) {
      for (const e of await this.readFolder(dir, folder)) if (this.idOf(e) === id) return e;
    }
    return null;
  }

  private toMessage(e: Entry, context: string, mailbox: string): VoicemailMessage {
    const callerId = e.info.callerid ?? '';
    const caller = parseCallerId(callerId);
    const seconds = Number(e.info.origtime);
    const timestamp = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    const duration = Number(e.info.duration);
    const flag = (e.info.flag ?? '').toLowerCase();
    return {
      id: this.idOf(e),
      mailbox,
      context,
      folder: e.folder === 'Old' ? 'old' : 'new',
      urgent: e.folder === 'Urgent' || flag === 'urgent',
      callerId,
      ...(caller.name ? { callerName: caller.name } : {}),
      ...(caller.number ? { callerNumber: caller.number } : {}),
      timestamp,
      date: new Date(timestamp).toISOString(),
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      hasAudio: AUDIO_TYPES.some(([ext, , playable]) => playable && e.files.includes(`msg${pad(e.index)}.${ext}`)),
    };
  }
}
