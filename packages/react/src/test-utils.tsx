import type { ReactNode } from 'react';
import { SoftphoneProvider } from './context';
import { MockSoftphone, type MockSoftphoneOptions } from './testing/mock-softphone';

export function createPhone(options: MockSoftphoneOptions = {}) {
  return new MockSoftphone(
    { username: '1001', password: 'secret', websocketUrls: ['wss://pbx.example.com/ws'] },
    { registerDelayMs: 0, ringDelayMs: 5, connectDelayMs: 20, ...options },
  );
}

export function wrapperFor(phone: MockSoftphone) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <SoftphoneProvider softphone={phone}>{children}</SoftphoneProvider>;
  };
}
