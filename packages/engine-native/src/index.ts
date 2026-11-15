/**
 * sipkit-engine-native — `SoftphoneEngine` over a native SIP stack
 * (baresip sidecar) via IPC. Browser/renderer safe: no Node imports here.
 * Node-only pieces (baresip adapter, stdio/TCP transports, CLI) live in
 * `sipkit-engine-native/node`. See docs/native-engine.md.
 */
export {
  NativeSipEngine,
  nativeSipEngine,
  accountFromConfig,
  targetUri,
  type NativeSipEngineOptions,
} from './engine';
export { NativeSipClient } from './client';
export {
  createMemoryTransportPair,
  createBridgeTransport,
  TransportBase,
  type NativeSipTransport,
  type NativeSipBridge,
  type Unsubscribe,
} from './transport';
export * from './protocol';
export { FakeSidecarNetwork, FakeSidecar } from './fake-sidecar';
