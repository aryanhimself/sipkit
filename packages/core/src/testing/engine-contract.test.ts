import { afterEach, describe, it } from 'vitest';
import { runEngineContract } from './engine-contract';
import { createLoopbackHarness } from './loopback';

// V1-TEST-02: the shared engine contract against FakeEngine (loopback network).
// The native engine runs the same suite against Asterisk: packages/engine-native (test:contract).
runEngineContract({ describe, it, afterEach }, createLoopbackHarness());
