/**
 * Builds the softphone instance for the configured engine.
 *
 * - `sipjs` (default): SIP.js WebRTC engine in the renderer.
 * - `mock`: MockSoftphone (demo / e2e, `SIPKIT_DESKTOP_ENGINE=mock`).
 * - `native`: an IPC-backed engine (V2-DESK-02). `packages/engine-native`
 *   registers its factory with {@link registerNativeEngineFactory}; until then
 *   (or when the main process has no native host) SIP.js is used.
 */
import {
  callHistoryPlugin,
  createSoftphone,
  ringtonePlugin,
  type EngineFactory,
  type SoftphoneApi,
  type SoftphoneConfigInput,
} from 'sipkit-core';
import { MockSoftphone } from 'sipkit-react/testing';
import type { EngineBridge } from '../shared/ipc';
import { serverHost, type AccountSettings, type EngineKind } from '../shared/settings';

export const BRAND_NAME = 'SipKit';

export function toSoftphoneConfig(account: AccountSettings, password: string, language: string): SoftphoneConfigInput {
  const config: SoftphoneConfigInput = {
    websocketUrls: [account.server],
    domain: account.domain || serverHost(account.server),
    username: account.extension,
    password,
    brandName: BRAND_NAME,
    language,
  };
  if (account.authUsername) config.authUsername = account.authUsername;
  if (account.displayName) config.displayName = account.displayName;
  return config;
}

type NativeEngineFactoryBuilder = (bridge: EngineBridge) => EngineFactory;
let nativeFactory: NativeEngineFactoryBuilder | null = null;

/** Extension point for V2-DESK-02: `registerNativeEngineFactory((bridge) => createIpcEngine(bridge))`. */
export function registerNativeEngineFactory(builder: NativeEngineFactoryBuilder | null): void {
  nativeFactory = builder;
}

export interface CreatePhoneOptions {
  engine: EngineKind;
  config: SoftphoneConfigInput;
  bridge?: EngineBridge;
}

export function createPhone({ engine, config, bridge }: CreatePhoneOptions): SoftphoneApi {
  if (engine === 'mock') {
    return new MockSoftphone(config, { engineName: 'mock-engine', plugins: [callHistoryPlugin()] });
  }
  const plugins = [callHistoryPlugin(), ringtonePlugin()];
  if (engine === 'native' && nativeFactory && bridge?.available()) {
    return createSoftphone({ config, plugins, engine: nativeFactory(bridge) });
  }
  if (engine === 'native') console.warn('[desktop] native engine not available, using SIP.js');
  return createSoftphone({ config, plugins });
}
