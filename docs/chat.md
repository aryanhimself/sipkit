# Chat (SIP MESSAGE)

Roadmap **V2-CHAT-01**. One-to-one instant messages between extensions over out-of-dialog SIP
`MESSAGE` requests (RFC 3428), routed by Asterisk `res_pjsip_messaging`. Off by default.

## Enable it

```ts
const softphone = createSoftphone({
  config: {
    ...credentials,
    chat: {
      enabled: true,        // send/receive MESSAGE, show the Chat tab (default false)
      persist: false,       // keep history in localStorage (default: memory only)
      historyLimit: 200,    // messages kept per conversation
      maxConversations: 100,
      maxLength: 1000,      // characters per outgoing message
      deliveryReports: true // honour PBX delivery reports (see below)
    },
  },
  // Optional: your own history store (server API, IndexedDB…). Wins over chat.persist.
  chatStorage: myStore,
});
```

`disabledFeatures: ['CHAT']` hides the UI. While `chat.enabled` is false
incoming MESSAGEs are answered **480 Temporarily Unavailable** and `sendMessage()` throws `NOT_SUPPORTED`.

## Core API

| | |
|---|---|
| `sendMessage(to, body)` | `to` is an extension or SIP URI. Resolves with the final `ChatMessage` (`sent` or `failed`). Throws `NOT_SUPPORTED` (chat off / engine without MESSAGE), `NOT_REGISTERED`, `INVALID_NUMBER`, `INVALID_ARGUMENT` (empty or longer than `maxLength`) |
| `markConversationRead(peer)` | Clears the unread count (`conversation:read`) |
| `deleteConversation(peer)` | Removes the conversation and its stored history |
| `snapshot.chat` | `{ conversations: ChatConversation[]; unread: number }`, newest activity first |
| `message:received` | `{ message, conversation }` for every incoming text message |
| `message:status` | `{ message, previous }`: `previous` is `undefined` when an outgoing message is created (`sending`), then `sending → sent` (2xx) or `→ failed` (4xx–6xx, timeout, transport error, delivery report) |
| `conversation:read` | `{ peer }` |

A `ChatConversation` has `peer`, optional `displayName` (from the sender's `From`), `messages`
(oldest first), `unread` and `updatedAt`. A `ChatMessage` has `id`, `peer`, `direction`, `body`,
`contentType` (`text/plain`), `at`, `status` and, for outgoing messages, the final SIP `code` and a failure `reason`.

**Conversation keys.** `chatPeerKey()` normalises targets: `sip:1002@<own domain>`, `1002@<own domain>` and
`10-02` all become `1002`; addresses on other domains keep the full URI (`sip:bob@example.com`).

**Incoming content.** Only `text/plain` is shown. RFC 3994 typing indicators
(`application/im-iscomposing+xml`) are accepted and ignored. Other types are answered **415**.

**Delivery status.** `sent` means the next hop (Asterisk) accepted the MESSAGE (`200`/`202`). It is not a
read receipt. SIP.js answers digest challenges and synthesizes `408` (no answer within Timer F, 32 s) and `503`
(transport error), which become `failed`.

### Delivery reports (PBX side)

Asterisk answers **202 Accepted** as soon as a MESSAGE matches an extension in its `message_context`, before
`MessageSend` runs, so the sender cannot see a later failure in the SIP response. The softphone therefore sends
each MESSAGE with `X-Sipkit-Message-Id: <message id>`, and the dev PBX dialplan replies with a delivery report when the
target has no registered contact:

```
MESSAGE sip:1001@…            (to the original sender)
X-Sipkit-Delivery: failed;to=2001;id=<X-Sipkit-Message-Id>
```

The softphone marks that message `failed` (reason "Not delivered") and never shows the report as chat. Without an
`id` it fails the latest outgoing message to `to`. Turn it off with `chat.deliveryReports: false`. Reproduce the
`[messages]` context below on a production PBX to get the same behaviour; without it, messages to offline users
stay `sent`.

### History storage

```ts
interface ChatHistoryStorage {
  load(account): ChatConversation[] | undefined | Promise<…>;
  save(account, conversations): void | Promise<void>;
  clear?(account): void | Promise<void>;
}
```

`account` is `"<username>@<domain>"`, so switching accounts switches history. Built in:
`createMemoryChatStorage()` (default) and `createLocalChatStorage(backend?, prefix?)` (what `chat.persist` uses,
key `sipkit:chat:<account>`). `save` runs after every change with the full list. Messages still `sending`
when the page went away load as `failed` ("Interrupted"). History that loads asynchronously is merged under
messages that arrived meanwhile.

## Engine contract

Optional, feature-detected like MWI:

```ts
interface SoftphoneEngine {
  sendMessage?(target, body, { contentType, messageId }): Promise<{ code: number; reason?: string }>;
}
interface EngineListener {
  onMessage?(message: EngineIncomingMessage): number | void; // SIP status to answer (default 200)
}
```

The SIP.js engine uses `Messager` (`engines/sipjs/messaging.ts`) and the UserAgent `onMessage` delegate.
`FakeEngine` has `sentMessages`, `messageResponses` (per target or `'*'`, a SIP code or `'pending'`),
`resolveMessage()`, `simulateIncomingMessage()` and `simulateDeliveryReport()`.

## React and UI

- `useChat()` → `{ enabled, conversations, unread, send(to, body), markRead(peer), deleteConversation(peer) }`.
- `useConversation(peerOrTarget)` → `{ peer, conversation, messages, unread, send(body), markRead() }`.
- `<Softphone />` adds a **Chat** tab (after History) with an unread badge, a conversation list with a
  "Start a conversation with" field, and a thread view: messages in a `role="log"` live region, delivery status
  and **Retry** for failed messages, a call button, delete, and a composer (Enter sends, Shift+Enter new line).
  An open, visible thread marks itself read. Contacts get a **Message** action. `ChatPanel` and
  `ChatUnreadBadge` are exported for custom layouts. All strings are in the i18n catalogue (`chat.*`, English and
  Nepali) and colours use theme tokens.
- `MockSoftphone` supports chat with options `chatSendDelayMs`, `unreachableChatNumbers` (answered 404),
  `chatAutoReply` and `chatStorage`, plus `simulateIncomingMessage()` and `simulateDeliveryFailure()`. The
  playground enables chat in both modes and has an "Incoming chat" mock control.

## Asterisk

`infra/asterisk/config/pbx`:

```ini
; pjsip.conf.tmpl – on every user endpoint template
message_context=messages
```

```ini
; extensions.conf
[messages]
exten => _[12]XXX,1,NoOp(MESSAGE ${MESSAGE(from)} -> ${EXTEN})
 same => n,Set(SENDER=${CUT(CUT(MESSAGE(from),@,1),:,2)})
 same => n,Set(MSGID=${MESSAGE_DATA(X-Sipkit-Message-Id)})
 same => n,GotoIf($["${PJSIP_DIAL_CONTACTS(${EXTEN})}" = ""]?undeliverable)
 same => n,MessageSend(pjsip:${EXTEN},${MESSAGE(from)})
 same => n,GotoIf($["${MESSAGE_SEND_STATUS}" = "SUCCESS"]?done)
 same => n(undeliverable),GotoIf($["${SENDER}" = ""]?done)
 same => n,Set(MESSAGE(body)=Message to ${EXTEN} could not be delivered)
 same => n,Set(MESSAGE_DATA(X-Sipkit-Delivery)=failed\;to=${EXTEN}\;id=${MSGID})
 same => n,MessageSend(pjsip:${SENDER},<sip:${EXTEN}@${CUT(CUT(MESSAGE(from),@,2),>,1)}>)
 same => n(done),Hangup()
```

(`;` starts a comment in dialplan files, hence `\;`.) Unknown extensions (no match in `[messages]`) get 404.
`MessageSend` is asynchronous in Asterisk 18+, so `MESSAGE_SEND_STATUS` only catches local errors; the
`PJSIP_DIAL_CONTACTS` check is what detects offline users. A message to a user registered on several devices
goes to one contact.

## Tests

- Core unit: `packages/core/src/__tests__/softphone.chat.test.ts` (status transitions, failures, validation,
  unread/markRead, foreign peers, content types, delivery reports, limits, persistence, account switch, async
  storage merge, SIP.js message mapping).
- React: `packages/react/src/hooks/use-chat.test.tsx`. UI: `packages/ui/src/features/chat/chat.test.tsx`
  (tab, badge, thread, retry, contact action, Nepali).
- Mock e2e: `apps/playground/e2e/chat.spec.ts`.
- Real Asterisk: `apps/playground/e2e/sip/chat.spec.ts`: 1001 → 1002 with unread count, reply back, 9999 → 404
  failed, unregistered 2001 → 202 then delivery report → failed.

## Limitations

- No read receipts or typing indicators (IMDN / RFC 3994 sending), no group chat, no SMS, no attachments.
- History is per browser unless a server-backed `chatStorage` is supplied; nothing syncs between devices, and
  messages that arrive while the user is offline are lost (Asterisk does not store them).
- `sent` only means the PBX accepted the message; without the delivery-report dialplan an offline target is not detected.
