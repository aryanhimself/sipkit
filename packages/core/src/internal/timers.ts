/**
 * Tracks every timeout the Softphone creates so none outlive it.
 * Keys allow replacing / cancelling a specific timer (e.g. "ring:<callId>").
 */
export class TimerRegistry {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  /** Schedule `fn` after `ms`. Re-using a key replaces the previous timer. */
  set(key: string | undefined, ms: number, fn: () => void): string {
    const id = key ?? `anon:${++this.seq}`;
    this.clear(id);
    const handle = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.set(id, handle);
    return id;
  }

  has(key: string): boolean {
    return this.timers.has(key);
  }

  clear(key: string): void {
    const handle = this.timers.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(key);
    }
  }

  /** Clear every timer whose key starts with `prefix`. */
  clearPrefix(prefix: string): void {
    for (const key of [...this.timers.keys()]) if (key.startsWith(prefix)) this.clear(key);
  }

  clearAll(): void {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }
}
