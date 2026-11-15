import type { Unsubscribe } from './types';

/** Minimal strongly-typed event emitter. Handler errors are isolated. */
export class TypedEmitter<Events extends object> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  constructor(private readonly onHandlerError?: (event: keyof Events, error: unknown) => void) {}

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  }

  once<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as (p: Events[K]) => void)(payload);
      } catch (error) {
        this.onHandlerError?.(event, error);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
