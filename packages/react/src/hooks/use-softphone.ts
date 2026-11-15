import { useContext } from 'react';
import type { SoftphoneApi } from 'sipkit-core';
import { SoftphoneContext } from '../context';

/** The softphone instance from the nearest `SoftphoneProvider`. Throws outside a provider. */
export function useSoftphone(): SoftphoneApi {
  const api = useContext(SoftphoneContext);
  if (!api) throw new Error('useSoftphone must be used inside <SoftphoneProvider>');
  return api;
}

/** Like `useSoftphone` but returns null outside a provider. */
export function useOptionalSoftphone(): SoftphoneApi | null {
  return useContext(SoftphoneContext);
}
