import { createContext, useContext } from 'react';
import type { SoftphoneApi } from 'sipkit-core';
import type {
  Contact,
  SoftphoneExtensions,
  SoftphoneRenderContext,
  SoftphoneSlots,
} from './extensions';
import type { HistoryStore } from './history-store';

export type SoftphoneTheme = 'light' | 'dark' | 'system';
export type SoftphoneLayout = 'compact' | 'full';

export interface ConsultPair {
  originalId: string;
  consultId: string;
}

/** UI-level state shared by the feature components inside <Softphone />. */
export interface SoftphoneUIState {
  layout: SoftphoneLayout;
  extensions: SoftphoneExtensions;
  slots: SoftphoneSlots;
  contacts: Contact[];
  history: HistoryStore | null;
  theme: SoftphoneTheme;
  setTheme: (theme: SoftphoneTheme) => void;
  /** Requested UI locale (tag or 'auto'); see useI18n() for the resolved one. */
  locale: string;
  setLocale: (locale: string) => void;
  dialValue: string;
  setDialValue: (value: string | ((prev: string) => string)) => void;
  consult: ConsultPair | null;
  setConsult: (pair: ConsultPair | null) => void;
  openTab: (id: string) => void;
  /** Build the context object passed to extension render functions. */
  renderContext: () => SoftphoneRenderContext;
  api: SoftphoneApi | null;
  /** Conversation open in the Chat tab (peer key or target), or null for the list. */
  chatPeer: string | null;
  /** Open the Chat tab on a conversation (null = conversation list). */
  openChat: (peer: string | null) => void;
}

const noop = () => undefined;

export const SoftphoneUIContext = createContext<SoftphoneUIState>({
  layout: 'compact',
  extensions: {},
  slots: {},
  contacts: [],
  history: null,
  theme: 'light',
  setTheme: noop,
  locale: 'en',
  setLocale: noop,
  dialValue: '',
  setDialValue: noop,
  consult: null,
  setConsult: noop,
  openTab: noop,
  renderContext: () => {
    throw new Error('renderContext is only available inside <Softphone />');
  },
  api: null,
  chatPeer: null,
  openChat: noop,
});

export function useSoftphoneUI(): SoftphoneUIState {
  return useContext(SoftphoneUIContext);
}
