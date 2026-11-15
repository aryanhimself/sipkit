import { Messager, UserAgent, type Message } from 'sip.js';
import type { EngineIncomingMessage, EngineMessageResult, Logger } from '../../types';
import { baseContentType, parseDeliveryReport } from '../../chat/peer';
import { buildTargetUri } from './helpers';

/** Header carrying the client message id (echoed back in PBX delivery reports). */
export const MESSAGE_ID_HEADER = 'X-Sipkit-Message-Id';
/** Header marking a PBX delivery report: `failed;to=<user>;id=<message id>`. */
export const DELIVERY_HEADER = 'X-Sipkit-Delivery';
/** Safety net on top of SIP.js Timer F (32 s → synthesized 408). */
const SEND_TIMEOUT_MS = 40_000;

/** Translate a SIP.js incoming {@link Message} into the engine-neutral shape. */
export function toIncomingMessage(message: Message): EngineIncomingMessage {
  const request = message.request;
  const uri = request.from.uri;
  return {
    from: uri.user ?? uri.host,
    fromHost: uri.user ? uri.host : undefined,
    fromDisplayName: request.from.displayName || undefined,
    body: request.body ?? '',
    contentType: baseContentType(request.getHeader('Content-Type')) || 'text/plain',
    deliveryReport: parseDeliveryReport(request.getHeader(DELIVERY_HEADER)),
  };
}

/** Answer an incoming MESSAGE with the status the orchestrator chose. */
export function answerMessage(message: Message, statusCode: number, logger: Logger): void {
  const done = statusCode >= 200 && statusCode < 300 ? message.accept({ statusCode }) : message.reject({ statusCode });
  done.catch((error: unknown) => logger.debug('Answering MESSAGE failed', error));
}

/**
 * Send one out-of-dialog MESSAGE with SIP.js {@link Messager}. Digest auth
 * challenges are answered by SIP.js. Resolves with the final status; SIP.js
 * synthesizes 408 (timeout) and 503 (transport error) responses.
 */
export function sendSipMessage(
  ua: UserAgent,
  domain: string,
  target: string,
  body: string,
  options: { contentType: string; messageId: string },
  logger: Logger,
): Promise<EngineMessageResult> {
  const uriText = buildTargetUri(target, domain);
  const uri = UserAgent.makeURI(uriText);
  if (!uri) return Promise.reject(new Error(`Invalid chat target "${target}"`));
  const messager = new Messager(ua, uri, body, options.contentType, {
    extraHeaders: [`${MESSAGE_ID_HEADER}: ${options.messageId}`],
  });
  return new Promise<EngineMessageResult>((resolve, reject) => {
    let settled = false;
    const finish = (result: EngineMessageResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ code: 408, reason: 'Request Timeout' }), SEND_TIMEOUT_MS);
    logger.debug(`MESSAGE ${uriText}`);
    messager
      .message({
        requestDelegate: {
          onAccept: (response) =>
            finish({ code: response.message.statusCode ?? 200, reason: response.message.reasonPhrase }),
          onReject: (response) =>
            finish({ code: response.message.statusCode ?? 500, reason: response.message.reasonPhrase }),
        },
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}
