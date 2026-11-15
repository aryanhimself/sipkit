/** Test utilities: `import { FakeEngine, createTestSoftphone } from 'sipkit-core/testing'`. */
export { FakeEngine, type FakeEngineCommand, type FakeEngineOptions } from './fake-engine';
export {
  createTestSoftphone,
  createFakeMediaDevices,
  TEST_CONFIG,
  type CreateTestSoftphoneOptions,
} from './create-test-softphone';
export { createSyntheticVideo, supportsSyntheticVideo, type SyntheticVideo } from './synthetic-video';
export { createMockVoicemailBackend, type MockVoicemailBackend, type MockVoicemailInput } from '../voicemail-list/mock-backend';
export { createToneWav } from '../voicemail-list/mock-backend';
export {
  runEngineContract,
  RecordingListener,
  type ContractRole,
  type ContractTestApi,
  type EngineContractCapabilities,
  type EngineContractHarness,
  type EngineContractParty,
  type RecordedEngineEvent,
} from './engine-contract';
export { LoopbackEngine, LoopbackNetwork, createLoopbackHarness } from './loopback';
export { FakePushPlatform, type FakePushPlatformOptions } from './fake-push-platform';
