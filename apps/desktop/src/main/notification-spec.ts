/**
 * Builds OS notification options per platform (V2-DESK-03). Pure, unit tested.
 *
 * - macOS: one "Answer" action button, the close button reads "Decline".
 *   (Action buttons need the notification style "Alerts" and a signed app.)
 * - Windows: toast XML with Answer/Decline buttons that activate
 *   `sipkit://answer?call=…` URLs, which reach the app as a
 *   second-instance argv and are handled like any other app URL.
 * - Linux / others: plain notification; clicking it shows the window.
 */
import type { NotificationConstructorOptions } from 'electron';
import { APP_SCHEME } from '../shared/dial-url';
import type { IncomingCallInfo, MissedCallInfo } from '../shared/ipc';

export interface NotificationStrings {
  incomingTitle: string;
  missedTitle: string;
  answer: string;
  decline: string;
}

export interface IncomingNotificationSpec {
  options: NotificationConstructorOptions;
  /** Index of the "Answer" button in `options.actions` (macOS), if any. */
  answerActionIndex: number | null;
  /** The close button means "decline" (macOS `closeButtonText`). */
  closeMeansDecline: boolean;
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function callerLabel(call: IncomingCallInfo): string {
  const name = call.displayName?.trim();
  return name && name !== call.number ? `${name} (${call.number})` : call.number;
}

export function incomingCallNotification(
  platform: string,
  call: IncomingCallInfo,
  strings: NotificationStrings,
): IncomingNotificationSpec {
  const body = callerLabel(call);
  const base: NotificationConstructorOptions = {
    title: strings.incomingTitle,
    body,
    // The widget plays the ringtone; a second sound would double up.
    silent: true,
    urgency: 'critical',
    timeoutType: 'never',
  };
  if (platform === 'darwin') {
    return {
      options: { ...base, actions: [{ type: 'button', text: strings.answer }], closeButtonText: strings.decline },
      answerActionIndex: 0,
      closeMeansDecline: true,
    };
  }
  if (platform === 'win32') {
    const id = encodeURIComponent(call.callId);
    const toastXml =
      `<toast scenario="incomingCall" activationType="protocol" launch="${APP_SCHEME}://show">` +
      `<visual><binding template="ToastGeneric"><text>${escapeXml(strings.incomingTitle)}</text>` +
      `<text>${escapeXml(body)}</text></binding></visual>` +
      `<audio silent="true"/>` +
      `<actions>` +
      `<action content="${escapeXml(strings.answer)}" activationType="protocol" arguments="${APP_SCHEME}://answer?call=${id}"/>` +
      `<action content="${escapeXml(strings.decline)}" activationType="protocol" arguments="${APP_SCHEME}://decline?call=${id}"/>` +
      `</actions></toast>`;
    return { options: { ...base, toastXml }, answerActionIndex: null, closeMeansDecline: false };
  }
  return { options: base, answerActionIndex: null, closeMeansDecline: false };
}

export function missedCallNotification(call: MissedCallInfo, strings: NotificationStrings): NotificationConstructorOptions {
  return { title: strings.missedTitle, body: callerLabel(call), silent: false };
}
