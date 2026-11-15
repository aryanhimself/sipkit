import { createContext, useContext } from 'react';

/**
 * Where Radix portals (dialogs, menus, tooltips) render. The Softphone root
 * provides its own element so popups stay inside `.sipkit-phone` (theme
 * scope) and inside the Shadow DOM when embedded as a web component.
 */
export interface PortalEnvironment {
  container: HTMLElement | null;
  /** True when rendered inside a Shadow DOM (focus trapping is disabled there). */
  inShadowRoot: boolean;
}

export const PortalContext = createContext<PortalEnvironment>({
  container: null,
  inShadowRoot: false,
});

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContext).container ?? undefined;
}

/** Modal (focus-trapping) popups don't work reliably in Shadow DOM; use non-modal there. */
export function useModalDefault(): boolean {
  return !useContext(PortalContext).inShadowRoot;
}
