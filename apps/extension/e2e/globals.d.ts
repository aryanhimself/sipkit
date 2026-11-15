import type { SoftphoneApi } from 'sipkit-core';

declare global {
  interface Window {
    /** Set by the playground page. */
    __softphone?: SoftphoneApi;
    __sipkitInstancesCreated?: number;
  }
}
export {};
