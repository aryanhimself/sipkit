import { MockSoftphone, type MockSoftphoneOptions } from 'sipkit-react/testing';
import type { SoftphoneConfigInput } from 'sipkit-core';

export function createPhone(config: SoftphoneConfigInput = {}, options: MockSoftphoneOptions = {}) {
  return new MockSoftphone(
    { username: '1001', password: 'secret', websocketUrls: ['wss://pbx.example.com/ws'], ...config },
    { registerDelayMs: 0, ringDelayMs: 5, connectDelayMs: 30, ...options },
  );
}
