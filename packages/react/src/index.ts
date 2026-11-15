export { SoftphoneProvider, SoftphoneContext } from './context';
export type {
  SoftphoneProviderProps,
  SoftphoneProviderWithFactory,
  SoftphoneProviderWithInstance,
  SoftphoneFactory,
} from './context';
export { useSoftphone, useOptionalSoftphone } from './hooks/use-softphone';
export { useSoftphoneSnapshot } from './hooks/use-softphone-snapshot';
export { useRegistration } from './hooks/use-registration';
export type { UseRegistrationResult } from './hooks/use-registration';
export { useCalls, useIncomingCalls, isLiveCall, isIncomingRinging } from './hooks/use-calls';
export type { UseCallsOptions } from './hooks/use-calls';
export { useActiveCall } from './hooks/use-active-call';
export { useCallTimer, formatDuration } from './hooks/use-call-timer';
export type { CallTimer } from './hooks/use-call-timer';
export { useDevices } from './hooks/use-devices';
export type { UseDevicesResult } from './hooks/use-devices';
export { useVoicemail } from './hooks/use-voicemail';
export type { UseVoicemailResult } from './hooks/use-voicemail';
export { useVoicemailList, useVoicemailPlayer } from './hooks/use-voicemail-list';
export type { UseVoicemailListResult, UseVoicemailPlayerResult } from './hooks/use-voicemail-list';
export { useDnd } from './hooks/use-dnd';
export type { UseDndResult } from './hooks/use-dnd';
export { useConference } from './hooks/use-conference';
export { usePresence, usePresenceOf } from './hooks/use-presence';
export type { UsePresenceResult, OwnPresence } from './hooks/use-presence';
export { useChat, useConversation } from './hooks/use-chat';
export type { UseChatResult, UseConversationResult } from './hooks/use-chat';
export { useSoftphoneEvent } from './hooks/use-softphone-event';
export { usePlugin } from './hooks/use-plugin';
export { useCallQuality } from './hooks/use-call-quality';
export { useCallVideo } from './hooks/use-call-video';
export type { UseCallVideoResult } from './hooks/use-call-video';
export { usePush } from './hooks/use-push';
export type { UsePushResult } from './hooks/use-push';
export { shallowEqual } from './equality';
