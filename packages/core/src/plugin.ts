import type { ResolvedConfig } from './config';
import type { Logger, SoftphoneApi, Unsubscribe, Call } from './types';

/**
 * Plugin system — the way to add features without touching the core.
 *
 * A plugin receives a context with the public API, a scoped logger and a
 * key/value storage. It can:
 *  - react to events (`ctx.api.on(...)`)
 *  - expose its own API (returned from `setup`), reachable via `api.plugin(id)`
 *  - transform dialed numbers (`hooks.beforeDial`)
 *  - veto/auto-handle incoming calls (`hooks.onIncomingCall`)
 *  - process the microphone before it is sent (`hooks.processMicrophone`), e.g. noise removal
 *
 * Examples shipped in-repo: call history, contacts, ringtones, CRM lookup.
 */

export interface PluginStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
}

export interface PluginContext {
  api: SoftphoneApi;
  config: ResolvedConfig;
  logger: Logger;
  storage: PluginStorage;
}

export type IncomingCallDecision =
  | { action: 'ring' }
  | { action: 'answer' }
  | { action: 'reject'; statusCode?: number }
  | { action: 'forward'; target: string };

/** Result of {@link PluginHooks.processMicrophone}. */
export interface ProcessedMicrophone {
  /** Stream with exactly one audio track; this is what the call sends. */
  stream: MediaStream;
  /** Release processing resources (audio graph, worklet). Called once, when the call stops using the stream. The engine stops the input tracks itself. */
  dispose?(): void;
}

export interface PluginHooks {
  /** Transform a number before dialing. Runs in plugin registration order. */
  beforeDial?(number: string): string | Promise<string>;
  /** First plugin returning a non-undefined decision wins. */
  onIncomingCall?(
    call: Call,
  ): IncomingCallDecision | undefined | Promise<IncomingCallDecision | undefined>;
  /**
   * Transform the captured microphone before it goes out on a call (noise removal, filters).
   * Runs for every new call and every microphone switch, in registration order; each hook gets
   * the previous hook's output. Return undefined to pass the input through. A throwing hook is
   * logged and skipped, so the call still has audio.
   */
  processMicrophone?(input: MediaStream): ProcessedMicrophone | undefined | Promise<ProcessedMicrophone | undefined>;
}

export interface PluginInstance<TApi = unknown> {
  api?: TApi;
  hooks?: PluginHooks;
  /** Called on Softphone.destroy(); release listeners/resources here. */
  dispose?(): void | Promise<void>;
}

export interface SoftphonePlugin<TApi = unknown> {
  /** Unique id, kebab-case, e.g. "call-history". */
  id: string;
  /** Plugin ids that must be registered before this one. */
  dependsOn?: string[];
  setup(ctx: PluginContext): PluginInstance<TApi> | Promise<PluginInstance<TApi>>;
}

/** Helper for type inference when authoring plugins. */
export function definePlugin<TApi>(plugin: SoftphonePlugin<TApi>): SoftphonePlugin<TApi> {
  return plugin;
}

export type { Unsubscribe };
