import './styles.css';

export { Softphone } from './softphone';
export type { SoftphoneProps } from './softphone';
export { MicrophoneAccess, VoiceProcessingSettings, type MicrophoneHelp } from './features/audio-settings';

// Feature components (compose your own layout inside <SoftphoneProvider>)
export { StatusBar, RegistrationPill } from './features/status-bar';
export type { StatusBarProps } from './features/status-bar';
export { LoginForm } from './features/login-form';
export type { LoginFormProps } from './features/login-form';
export { Dialpad } from './features/dialpad';
export type { DialpadProps } from './features/dialpad';
export { CallScreen, ActionButton, callStatusText } from './features/call-screen';
export type { CallScreenProps } from './features/call-screen';
export { TransferDialog } from './features/transfer-dialog';
export type { TransferDialogProps, TransferMode } from './features/transfer-dialog';
export { IncomingCallCard } from './features/incoming-call-card';
export type { IncomingCallCardProps } from './features/incoming-call-card';
export { LineSwitcher } from './features/line-switcher';
export { ConferencePanel, useConferenceCalls } from './features/conference-panel';
export { CallHistory, useCallHistory } from './features/call-history';
export type { CallHistoryProps } from './features/call-history';
export { ContactsList, useContacts, useContactLookup } from './features/contacts';
export type { ContactsListProps } from './features/contacts';
export { Settings } from './features/settings';
export { VoicemailBadge, DndToggle, VoicemailPanel, VoicemailTabBadge } from './features/voicemail';
export type { VoicemailBadgeProps, VoicemailPanelProps } from './features/voicemail';
export { PresenceLamp, BlfPanel, presenceDescription, presenceStateLabel } from './features/presence';
export type { PresenceLampProps, BlfPanelProps } from './features/presence';
export { ChatPanel, ChatUnreadBadge, UnreadCount } from './features/chat';
export type { ChatPanelProps } from './features/chat';
export { SoftphoneToaster } from './features/toaster';
export { CallQualityIndicator, CallQualityDetails } from './features/call-quality';
export type { CallQualityIndicatorProps } from './features/call-quality';
export { CallVideoView, useCameraToggle, useVideoAvailable } from './features/video';
export type { CallVideoViewProps } from './features/video';
export { PushSettings, PushPrompt, usePushLabelsSync, pushErrorText } from './features/push';
export type { PushPromptProps } from './features/push';

// Extensibility
export type {
  SoftphoneExtensions,
  SoftphoneSlots,
  SoftphoneTabExtension,
  CallActionExtension,
  PanelExtension,
  SoftphoneRenderContext,
  Contact,
  CallHistoryPluginApi,
  ContactsPluginApi,
} from './extensions';
export { useSoftphoneUI, SoftphoneUIContext } from './context';
export type { SoftphoneUIState, SoftphoneLayout, SoftphoneTheme, ConsultPair } from './context';
// Theming (docs/theming.md)
export {
  THEME_COLOR_TOKENS,
  THEME_OTHER_TOKENS,
  lightTokens,
  darkTokens,
  themeTokensToCssVars,
  parseThemeTokens,
  contrastRatio,
  parseColor,
} from './theme/tokens';
export type {
  ThemeColorToken,
  ThemeTokenName,
  ThemeTokens,
  ThemeTokenOverrides,
  ThemePalette,
} from './theme/tokens';
export { isFeatureEnabled } from './lib/features';

// i18n (V2-I18N-01)
export {
  en,
  ne,
  registerLocale,
  registeredLocales,
  resolveLocale,
  createI18n,
  I18nContext,
  useI18n,
  useT,
  createPseudoLocale,
  pseudoMessage,
} from './i18n';
export type {
  MessageKey,
  Messages,
  LocaleDefinition,
  ResolvedLocale,
  TextDirection,
  I18n,
  Translate,
  TranslateValues,
} from './i18n';
export { formatDuration as formatLocaleDuration, formatWhen, formatLocaleNumber } from './lib/format';
export type { SoftphoneFeature } from './lib/features';
export { cn } from './lib/utils';

// Re-export the React bindings for convenience
export * from 'sipkit-react';
