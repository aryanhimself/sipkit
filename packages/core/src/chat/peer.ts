import { isSipUri, normalizeNumber } from '../internal/numbers';

/**
 * Conversation key for a chat target typed by the user or taken from a SIP
 * identity: "sip:1002@pbx" on the own domain → "1002"; numbers lose visual
 * separators; foreign-domain URIs stay full ("sip:bob@example.com").
 */
export function chatPeerKey(target: string, ownDomain: string): string {
  const value = target.trim();
  if (!value) return '';
  const uri = /^sips?:([^@;?>]+)@([^;?>:]+)/i.exec(value);
  if (uri) {
    const [, user, host] = uri;
    return host!.toLowerCase() === ownDomain.toLowerCase() ? user! : `sip:${user}@${host!.toLowerCase()}`;
  }
  if (isSipUri(value)) return value;
  // "1002@pbx" shorthand
  const at = value.indexOf('@');
  if (at > 0) return chatPeerKey(`sip:${value}`, ownDomain);
  return normalizeNumber(value);
}

/** Peer key for an incoming MESSAGE sender. */
export function incomingPeerKey(from: string, fromHost: string | undefined, ownDomain: string): string {
  if (!fromHost || isSipUri(from)) return chatPeerKey(from, ownDomain);
  return chatPeerKey(`sip:${from}@${fromHost}`, ownDomain);
}

/** Base MIME type, lower case, without parameters ("Text/Plain; charset=UTF-8" → "text/plain"). */
export function baseContentType(header: string | undefined): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

/** Parse `X-Sipkit-Delivery: failed;to=1003;id=abc`. */
export function parseDeliveryReport(
  header: string | undefined,
): { status: 'failed'; messageId?: string; to?: string } | undefined {
  if (!header) return undefined;
  const [status, ...params] = header.split(';').map((p) => p.trim());
  if (status?.toLowerCase() !== 'failed') return undefined;
  const get = (name: string) =>
    params
      .find((p) => p.toLowerCase().startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim() || undefined;
  return { status: 'failed', messageId: get('id'), to: get('to') };
}
