/**
 * Node-only half of sipkit-engine-native: the baresip sidecar adapter
 * and JSON-lines transports (stdio / TCP). Use from Node tests, the Electron
 * main process or a sidecar process; never from a renderer.
 */
export {
  BaresipSidecar,
  baresipAccountLine,
  reasonFromSipCode,
  userOfUri,
  type BaresipSidecarOptions,
} from './baresip-sidecar';
export { BaresipControl, type BaresipEvent, type BaresipResponse } from './baresip-control';
export { JsonLinesTransport, connectTcpTransport, spawnSidecarTransport } from './json-lines';
export { encodeNetstring, NetstringDecoder } from './netstring';
