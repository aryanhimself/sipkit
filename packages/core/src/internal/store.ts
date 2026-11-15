import type { SoftphoneSnapshot, Unsubscribe } from '../types';

/**
 * Immutable snapshot holder compatible with React's useSyncExternalStore:
 * `get()` returns the same object until `update()` produces a new one.
 */
export class SnapshotStore {
  private snapshot: SoftphoneSnapshot;
  private listeners = new Set<(s: SoftphoneSnapshot) => void>();

  constructor(
    initial: SoftphoneSnapshot,
    private readonly onChange?: (s: SoftphoneSnapshot) => void,
  ) {
    this.snapshot = Object.freeze(initial);
  }

  get(): SoftphoneSnapshot {
    return this.snapshot;
  }

  /** Apply a shallow patch. No-op (same reference) if every patched key is identical. */
  update(patch: Partial<SoftphoneSnapshot>): void {
    const keys = Object.keys(patch) as (keyof SoftphoneSnapshot)[];
    if (keys.every((k) => Object.is(this.snapshot[k], patch[k]))) return;
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    const current = this.snapshot;
    for (const listener of [...this.listeners]) {
      try {
        listener(current);
      } catch {
        /* subscriber errors must not break the phone */
      }
    }
    this.onChange?.(current);
  }

  subscribe(listener: (s: SoftphoneSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.listeners.clear();
  }
}
