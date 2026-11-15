import { createContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SoftphoneApi, SoftphoneConfigInput } from 'sipkit-core';

export const SoftphoneContext = createContext<SoftphoneApi | null>(null);
SoftphoneContext.displayName = 'SoftphoneContext';

export type SoftphoneFactory = (
  config: SoftphoneConfigInput,
) => SoftphoneApi | Promise<SoftphoneApi>;

interface CommonProps {
  children?: ReactNode;
  /**
   * Call `start()` on mount when the instance is not started yet. Default true.
   * Set false if the host manages the lifecycle itself.
   */
  autoStart?: boolean;
  /** Rendered while an async factory is creating the instance. */
  fallback?: ReactNode;
  /** Called when creating or starting the instance fails. */
  onError?: (error: unknown) => void;
}

export interface SoftphoneProviderWithInstance extends CommonProps {
  /** An existing softphone instance. The provider does NOT stop it on unmount. */
  softphone: SoftphoneApi;
  config?: never;
  factory?: never;
}

export interface SoftphoneProviderWithFactory extends CommonProps {
  softphone?: never;
  /** Config passed to the factory. Read once on mount; later changes are applied via `updateConfig`. */
  config: SoftphoneConfigInput;
  /** Creates the instance (e.g. core `createSoftphone`). The provider owns and stops it on unmount. */
  factory: SoftphoneFactory;
}

export type SoftphoneProviderProps = SoftphoneProviderWithInstance | SoftphoneProviderWithFactory;

function maybeStart(api: SoftphoneApi, onError?: (e: unknown) => void): void {
  const { app } = api.getSnapshot();
  if (app === 'started') return;
  api.start().catch((error: unknown) => onError?.(error));
}

async function dispose(api: SoftphoneApi): Promise<void> {
  const destroyable = api as SoftphoneApi & { destroy?: () => Promise<void> | void };
  if (typeof destroyable.destroy === 'function') await destroyable.destroy();
  else await api.stop();
}

/**
 * Makes a softphone available to the hooks below.
 *
 * ```tsx
 * <SoftphoneProvider softphone={phone}>...</SoftphoneProvider>
 * <SoftphoneProvider config={{ username: '1001', ... }} factory={createSoftphone}>...</SoftphoneProvider>
 * ```
 */
export function SoftphoneProvider(props: SoftphoneProviderProps): ReactNode {
  const { children, autoStart = true, fallback = null, onError } = props;
  const external = props.softphone;
  const [owned, setOwned] = useState<SoftphoneApi | null>(null);
  const appliedKey = useRef<string | null>(null);

  // Externally supplied instance: optionally start it, never stop it.
  useEffect(() => {
    if (external && autoStart) maybeStart(external, onError);
  }, [external, autoStart]);

  // Factory: create on mount, dispose on unmount.
  const factory = props.factory;
  const config = props.config;
  useEffect(() => {
    if (external || !factory) return;
    let cancelled = false;
    let instance: SoftphoneApi | null = null;
    Promise.resolve()
      .then(() => factory(config ?? {}))
      .then((api) => {
        instance = api;
        if (cancelled) {
          void dispose(api);
          return;
        }
        setOwned(api);
        if (autoStart) maybeStart(api, onError);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError?.(error);
      });
    return () => {
      cancelled = true;
      setOwned(null);
      appliedKey.current = null;
      if (instance) void dispose(instance).catch(() => undefined);
    };
  }, [external, factory]);

  // Apply config changes to an owned instance.
  const configKey = config ? JSON.stringify(config) : '';
  useEffect(() => {
    if (!owned || !config) return;
    if (appliedKey.current === null) {
      // The factory already received this config.
      appliedKey.current = configKey;
      return;
    }
    if (appliedKey.current === configKey) return;
    appliedKey.current = configKey;
    owned.updateConfig(config).catch((e: unknown) => onError?.(e));
  }, [owned, configKey]);

  const api = external ?? owned;
  if (!api) return <>{fallback}</>;
  return <SoftphoneContext.Provider value={api}>{children}</SoftphoneContext.Provider>;
}
