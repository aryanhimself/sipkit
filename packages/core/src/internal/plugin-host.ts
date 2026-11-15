import type { IncomingCallDecision, PluginContext, PluginInstance, SoftphonePlugin } from '../plugin';
import type { Call, Logger } from '../types';
import { SoftphoneError } from '../errors';

/**
 * Order plugins so every plugin comes after its `dependsOn` entries while
 * otherwise preserving registration order. Throws PLUGIN_ERROR on duplicate
 * ids, unknown dependencies or cycles.
 */
export function sortPlugins(plugins: readonly SoftphonePlugin<unknown>[]): SoftphonePlugin<unknown>[] {
  const byId = new Map<string, SoftphonePlugin<unknown>>();
  for (const p of plugins) {
    if (byId.has(p.id)) throw new SoftphoneError('PLUGIN_ERROR', `Duplicate plugin id "${p.id}"`);
    byId.set(p.id, p);
  }
  const sorted: SoftphonePlugin<unknown>[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (p: SoftphonePlugin<unknown>, chain: string[]) => {
    const s = state.get(p.id);
    if (s === 'done') return;
    if (s === 'visiting') {
      throw new SoftphoneError('PLUGIN_ERROR', `Plugin dependency cycle: ${[...chain, p.id].join(' -> ')}`);
    }
    state.set(p.id, 'visiting');
    for (const dep of p.dependsOn ?? []) {
      const target = byId.get(dep);
      if (!target) {
        throw new SoftphoneError('PLUGIN_ERROR', `Plugin "${p.id}" depends on missing plugin "${dep}"`);
      }
      visit(target, [...chain, p.id]);
    }
    state.set(p.id, 'done');
    sorted.push(p);
  };
  for (const p of plugins) visit(p, []);
  return sorted;
}

interface LoadedPlugin {
  id: string;
  instance: PluginInstance<unknown>;
}

/** Owns plugin instances: setup in dependency order, hook dispatch, reverse-order disposal. */
export class PluginHost {
  private loaded: LoadedPlugin[] = [];

  constructor(private readonly logger: Logger) {}

  /** Set up every plugin. A failing setup disposes the already-loaded ones and rethrows. */
  async setup(
    plugins: readonly SoftphonePlugin<unknown>[],
    makeContext: (id: string) => PluginContext,
  ): Promise<void> {
    for (const plugin of sortPlugins(plugins)) {
      try {
        const instance = await plugin.setup(makeContext(plugin.id));
        this.loaded.push({ id: plugin.id, instance: instance ?? {} });
      } catch (error) {
        await this.dispose();
        throw new SoftphoneError('PLUGIN_ERROR', `Plugin "${plugin.id}" failed to set up`, {
          cause: error,
        });
      }
    }
  }

  api<T>(id: string): T | undefined {
    return this.loaded.find((p) => p.id === id)?.instance.api as T | undefined;
  }

  /** Run every beforeDial hook in order; a throwing hook is logged and skipped. */
  async beforeDial(number: string): Promise<string> {
    let current = number;
    for (const { id, instance } of this.loaded) {
      const hook = instance.hooks?.beforeDial;
      if (!hook) continue;
      try {
        const next = await hook(current);
        if (typeof next === 'string') current = next;
      } catch (error) {
        this.logger.warn(`beforeDial hook of "${id}" failed`, error);
      }
    }
    return current;
  }

  /** First non-undefined decision wins. */
  async onIncomingCall(call: Call): Promise<IncomingCallDecision | undefined> {
    for (const { id, instance } of this.loaded) {
      const hook = instance.hooks?.onIncomingCall;
      if (!hook) continue;
      try {
        const decision = await hook(call);
        if (decision) return decision;
      } catch (error) {
        this.logger.warn(`onIncomingCall hook of "${id}" failed`, error);
      }
    }
    return undefined;
  }

  /** Dispose in reverse setup order. Errors are logged, never thrown. */
  async dispose(): Promise<void> {
    const loaded = this.loaded.reverse();
    this.loaded = [];
    for (const { id, instance } of loaded) {
      try {
        await instance.dispose?.();
      } catch (error) {
        this.logger.warn(`Plugin "${id}" failed to dispose`, error);
      }
    }
  }
}
