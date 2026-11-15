import type { ResolvedConfig } from 'sipkit-core';

/** Built-in features that can be turned off with `config.disabledFeatures` (case-insensitive). */
export type SoftphoneFeature = 'history' | 'contacts' | 'settings' | 'conference' | 'transfer' | 'voicemail' | 'dnd' | 'presence' | 'chat' | 'video';

export function isFeatureEnabled(
  config: Pick<ResolvedConfig, 'disabledFeatures'> | undefined,
  feature: SoftphoneFeature | (string & {}),
): boolean {
  const disabled = config?.disabledFeatures ?? [];
  return !disabled.some((f) => f.trim().toLowerCase() === feature.toLowerCase());
}
