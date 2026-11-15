import type { RegistrationStatus } from 'sipkit-core';
import { shallowEqual } from '../equality';
import { useSoftphoneSnapshot } from './use-softphone-snapshot';

export interface UseRegistrationResult extends RegistrationStatus {
  isRegistered: boolean;
  /** connecting or registering */
  isPending: boolean;
}

/** Current registration status plus convenience flags. */
export function useRegistration(): UseRegistrationResult {
  const status = useSoftphoneSnapshot((s) => s.registration, shallowEqual);
  return {
    ...status,
    isRegistered: status.state === 'registered',
    isPending: status.state === 'connecting' || status.state === 'registering',
  };
}
