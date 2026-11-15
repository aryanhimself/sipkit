import { randomBytes } from 'node:crypto';
import { link, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Folder lock compatible with Asterisk's default `lockfile` method
 * (main/app.c `ast_lock_path_lockfile`, used by app_voicemail's vm_lock_path):
 * create a unique temp file in the folder, then hard-link it to `<folder>/.lock`.
 * `link()` fails with EEXIST while someone else holds the lock, so it is atomic
 * across processes and containers sharing the volume.
 */
export interface LockOptions {
  timeoutMs?: number;
  /** Locks older than this are considered abandoned (crashed holder) and broken. */
  staleMs?: number;
  retryMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function lockFolder(dir: string, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 60_000;
  const retryMs = opts.retryMs ?? 20;
  const lockPath = join(dir, '.lock');
  const tmp = join(dir, `.lock-${randomBytes(6).toString('hex')}`);
  const fh = await open(tmp, 'wx');
  await fh.writeFile(`${process.pid}\n`);
  await fh.close();
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      try {
        await link(tmp, lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const st = await stat(lockPath).catch(() => null);
        if (st && Date.now() - st.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
        await sleep(retryMs);
      }
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(lockPath).catch(() => undefined);
  };
}

/** In-process serialisation per key (concurrent HTTP requests on one mailbox). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
