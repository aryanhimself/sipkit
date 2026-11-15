/**
 * V1-TEST-02 engine contract against the native engine: two baresip sidecars
 * (containers on sipkit-dev_voip) registered as the plain-SIP UDP
 * endpoints 2001 / 2002 of an Asterisk dev PBX.
 *
 * Opt-in: `pnpm --filter sipkit-engine-native test:contract`
 * (scripts/contract.sh builds the image, starts the containers and sets the env below).
 *
 *   NATIVE_PBX          SIP server host[:port] the sidecars register with (default 172.28.0.10:5060)
 *   NATIVE_SIDECAR_A    baresip ctrl_tcp of party a / 2001 (default 127.0.0.1:44441)
 *   NATIVE_SIDECAR_B    baresip ctrl_tcp of party b / 2002 (default 127.0.0.1:44442)
 *   NATIVE_PASSWORD     SIP password (default sipkitdev123)
 *   NATIVE_SIDECAR_MODE "memory" (default: BaresipSidecar in-process over a memory transport)
 *                       or "stdio" (spawn dist/node/cli.js and speak JSON lines over its stdio; needs a build)
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'vitest';
import { resolveConfig } from 'sipkit-core';
import { runEngineContract, type ContractRole } from 'sipkit-core/testing';
import { NativeSipEngine } from '../engine';
import { createMemoryTransportPair, type NativeSipTransport } from '../transport';
import { BaresipSidecar } from '../node/baresip-sidecar';
import { spawnSidecarTransport } from '../node/json-lines';

const env = process.env;
const pbx = env.NATIVE_PBX ?? '172.28.0.10:5060';
const users: Record<ContractRole, string> = { a: '2001', b: '2002' };
const ctrl: Record<ContractRole, string> = {
  a: env.NATIVE_SIDECAR_A ?? '127.0.0.1:44441',
  b: env.NATIVE_SIDECAR_B ?? '127.0.0.1:44442',
};
const mode = env.NATIVE_SIDECAR_MODE === 'stdio' ? 'stdio' : 'memory';
const cli = fileURLToPath(new URL('../../dist/node/cli.js', import.meta.url));

function hostPort(address: string): { host: string; port: number } {
  const colon = address.lastIndexOf(':');
  return { host: address.slice(0, colon), port: Number(address.slice(colon + 1)) };
}

function sidecarTransport(role: ContractRole): NativeSipTransport {
  if (mode === 'stdio')
    return spawnSidecarTransport(process.execPath, [cli, '--baresip', ctrl[role]]);
  const [engineSide, sidecarSide] = createMemoryTransportPair();
  new BaresipSidecar(sidecarSide, hostPort(ctrl[role]));
  return engineSide;
}

runEngineContract(
  { describe, it, afterEach },
  {
    name: `NativeSipEngine + baresip (${mode}) vs Asterisk UDP 2001/2002 at ${pbx}`,
    createParty(role, overrides) {
      const config = resolveConfig({
        username: users[role],
        password: overrides?.password ?? env.NATIVE_PASSWORD ?? 'sipkitdev123',
        transportMode: 'native',
        sipServer: pbx,
        sipTransport: 'udp',
        registerExpires: 120,
      });
      return { engine: new NativeSipEngine({ transport: () => sidecarTransport(role) }), config };
    },
    address: (role) => users[role],
    transferTarget: '600',
    // The dev dialplan dials with Dial(...,tT): Asterisk eats # and * as feature-code prefixes.
    dtmfDigits: '1590',
    capabilities: { mediaStreams: false, remoteHoldSignalling: false, registrationFailure: true },
    timeoutMs: 10_000,
    // Let Asterisk tear down channels / contacts between tests.
    afterEach: () => new Promise((resolve) => setTimeout(resolve, 500)),
  },
);
