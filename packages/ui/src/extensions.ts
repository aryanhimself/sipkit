import type { ReactNode } from 'react';
import type { Call, Cdr, SoftphoneApi, SoftphoneSnapshot } from 'sipkit-core';

/** Passed to every extension render function. */
export interface SoftphoneRenderContext {
  api: SoftphoneApi;
  snapshot: SoftphoneSnapshot;
  /** The call the user is interacting with, if any. */
  activeCall: Call | null;
  /** Place a call (switches to the Phone view). */
  dial: (number: string) => void;
  /** Switch the visible tab ('phone', 'history', 'contacts', 'settings' or an extension tab id). */
  openTab: (id: string) => void;
}

/** An extra tab, e.g. a CRM lookup page. */
export interface SoftphoneTabExtension {
  /** Unique id (also used with `openTab`). */
  id: string;
  label: string;
  /** Icon element, e.g. `<BuildingIcon />` from lucide-react. */
  icon?: ReactNode;
  /** Sort position among tabs; built-ins use 0 (phone), 10, 20, 30 (settings = 100). Default 50. */
  order?: number;
  render: (ctx: SoftphoneRenderContext) => ReactNode;
}

/** An extra button in the in-call action grid (e.g. "Open ticket", "Record"). */
export interface CallActionExtension {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: (call: Call, ctx: SoftphoneRenderContext) => void | Promise<void>;
  /** Hide for some calls. Default: always visible. */
  isVisible?: (call: Call) => boolean;
  /** Toggle-style highlight (sets aria-pressed). */
  isActive?: (call: Call) => boolean;
  isDisabled?: (call: Call) => boolean;
}

/** A panel rendered next to (full layout) or below (compact layout) the phone. */
export interface PanelExtension {
  id: string;
  title?: string;
  /** When the panel is shown. Default 'always'. */
  when?: 'always' | 'in-call' | 'idle';
  /** Also show in the compact layout (below the main view). Default false. */
  showInCompact?: boolean;
  render: (ctx: SoftphoneRenderContext) => ReactNode;
}

export interface SoftphoneExtensions {
  tabs?: SoftphoneTabExtension[];
  callActions?: CallActionExtension[];
  panels?: PanelExtension[];
}

/** Small injection points in the built-in screens. */
export interface SoftphoneSlots {
  /** Extra content at the right of the status bar (before the menu). */
  headerActions?: (ctx: SoftphoneRenderContext) => ReactNode;
  /** Rendered under the caller name on the call screen and incoming call card (e.g. CRM match). */
  callInfo?: (call: Call, ctx: SoftphoneRenderContext) => ReactNode;
  /** Rendered above the dialpad when idle. */
  idleBanner?: (ctx: SoftphoneRenderContext) => ReactNode;
  /** Rendered at the bottom of the login form. */
  loginFooter?: (ctx: Pick<SoftphoneRenderContext, 'api'>) => ReactNode;
  /** Rendered at the bottom of the widget, above the tab bar. */
  footer?: (ctx: SoftphoneRenderContext) => ReactNode;
}

export interface Contact {
  id: string;
  name: string;
  number: string;
  /** Secondary text, e.g. company or department. */
  description?: string;
  email?: string;
  avatarUrl?: string;
}

/**
 * Plugin API shapes the UI understands (match core's `callHistoryPlugin` and
 * `contactsPlugin`). If a plugin with id 'call-history' / 'contacts' is
 * installed, the History / Contacts tabs read from it.
 */
export interface CallHistoryPluginApi {
  /** Records, newest first. Should return the same array until it changes. */
  list(): Cdr[];
  /** Change notification (core plugin). */
  onChange?(listener: (records: Cdr[]) => void): () => void;
  /** Alternative change notification name. */
  subscribe?(listener: () => void): () => void;
  clear?(): void;
}

export interface ContactsPluginApi {
  list(): Contact[] | Promise<Contact[]>;
  onChange?(listener: (contacts: Contact[]) => void): () => void;
  subscribe?(listener: () => void): () => void;
}
