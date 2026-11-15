import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A browser PushSubscription (its `toJSON()` form) owned by one extension. */
export interface SubscriptionRecord {
  extension: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Epoch ms after which the browser said the subscription expires (rarely set). */
  expirationTime?: number | null;
  userAgent?: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms of the last successful push. */
  lastSuccessAt?: number;
  /** Consecutive failed sends (not counting 404/410, which delete at once). */
  failures?: number;
}

/**
 * Where subscriptions live. The bundled implementations are in-memory and a
 * JSON file; a CRM can plug in its own database by implementing this.
 * The endpoint URL is the primary key (a browser profile has one per origin).
 */
export interface SubscriptionStore {
  listByExtension(extension: string): Promise<SubscriptionRecord[]>;
  all(): Promise<SubscriptionRecord[]>;
  /** Insert or replace (by endpoint). */
  upsert(record: SubscriptionRecord): Promise<void>;
  /** Patch an existing record; no-op when the endpoint is unknown. */
  update(endpoint: string, patch: Partial<SubscriptionRecord>): Promise<void>;
  /** Remove by endpoint. Returns true when something was removed. */
  remove(endpoint: string): Promise<boolean>;
  /** Remove every record matching `predicate`. Returns the number removed. */
  removeWhere(predicate: (record: SubscriptionRecord) => boolean): Promise<number>;
}

export class MemoryStore implements SubscriptionStore {
  protected readonly records = new Map<string, SubscriptionRecord>();

  async listByExtension(extension: string): Promise<SubscriptionRecord[]> {
    return [...this.records.values()].filter((r) => r.extension === extension).map((r) => ({ ...r }));
  }

  async all(): Promise<SubscriptionRecord[]> {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  async upsert(record: SubscriptionRecord): Promise<void> {
    this.records.set(record.endpoint, { ...record });
    await this.changed();
  }

  async update(endpoint: string, patch: Partial<SubscriptionRecord>): Promise<void> {
    const current = this.records.get(endpoint);
    if (!current) return;
    this.records.set(endpoint, { ...current, ...patch, endpoint });
    await this.changed();
  }

  async remove(endpoint: string): Promise<boolean> {
    const removed = this.records.delete(endpoint);
    if (removed) await this.changed();
    return removed;
  }

  async removeWhere(predicate: (record: SubscriptionRecord) => boolean): Promise<number> {
    let n = 0;
    for (const [endpoint, record] of this.records) {
      if (predicate(record)) {
        this.records.delete(endpoint);
        n++;
      }
    }
    if (n) await this.changed();
    return n;
  }

  /** Hook for persistent subclasses. */
  protected async changed(): Promise<void> {}
}

/**
 * Durable single-node store: everything in memory, written to a JSON file
 * after every change (write to a temp file + rename, so a crash never leaves a
 * half-written file). Fine for thousands of agents; use a database-backed
 * {@link SubscriptionStore} for several replicas.
 */
export class JsonFileStore extends MemoryStore {
  private writing: Promise<void> = Promise.resolve();

  private readonly file: string;

  private constructor(file: string) {
    super();
    this.file = file;
  }

  static async open(file: string): Promise<JsonFileStore> {
    const store = new JsonFileStore(file);
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as { subscriptions?: SubscriptionRecord[] };
      for (const r of data.subscriptions ?? []) {
        if (r && typeof r.endpoint === 'string' && typeof r.extension === 'string') store.records.set(r.endpoint, r);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return store;
  }

  protected override changed(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, subscriptions: [...this.records.values()] }, null, 2);
    // Serialise writes so an older snapshot never overwrites a newer one.
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
