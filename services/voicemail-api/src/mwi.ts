import { connect } from 'node:net';
import type { Logger } from './logger.js';

/**
 * Tells Asterisk a mailbox changed on disk so it re-counts it and publishes MWI
 * (message-summary NOTIFY) at once.
 *
 * Why AMI `VoicemailRefresh`: app_voicemail only notices changes it did not
 * make itself when polling (`pollmailboxes=yes`, every `pollfreq` seconds) or
 * when told through this action. ARI's `/mailboxes` resource is for
 * res_mwi_external mailboxes and does not touch app_voicemail's counts.
 */
export interface MwiRefresher {
  refresh(context: string, mailbox: string): Promise<boolean>;
}

export const noopRefresher: MwiRefresher = { refresh: async () => false };

export interface AmiOptions {
  host: string;
  port?: number;
  username: string;
  secret: string;
  timeoutMs?: number;
  logger?: Logger;
}

/** Parse one AMI message block ("Key: value" lines). */
function parseBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function encode(fields: Record<string, string>): string {
  return `${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v.replace(/[\r\n]/g, '')}`)
    .join('\r\n')}\r\n\r\n`;
}

/**
 * One short AMI session per refresh: Login, VoicemailRefresh, Logoff. Mailbox
 * changes are rare (a click), so a persistent connection is not worth its
 * reconnect logic. Never throws; resolves false on any failure.
 */
export function createAmiRefresher(opts: AmiOptions): MwiRefresher {
  const timeoutMs = opts.timeoutMs ?? 3000;
  return {
    refresh(context, mailbox) {
      return new Promise<boolean>((resolvePromise) => {
        let buf = '';
        let stage: 'banner' | 'login' | 'refresh' | 'done' = 'banner';
        let settled = false;
        const socket = connect({ host: opts.host, port: opts.port ?? 5038 });
        const finish = (ok: boolean, why?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!ok) opts.logger?.warn(`AMI VoicemailRefresh ${mailbox}@${context} failed: ${why ?? 'unknown'}`);
          if (!socket.destroyed) {
            socket.end(encode({ Action: 'Logoff', ActionID: 'sipkit-vm-3' }));
            setTimeout(() => socket.destroy(), 200).unref();
          }
          resolvePromise(ok);
        };
        const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
        socket.setEncoding('utf8');
        socket.on('error', (e) => finish(false, e.message));
        socket.on('close', () => finish(stage === 'done', 'connection closed'));
        socket.on('data', (chunk: string) => {
          buf += chunk;
          if (stage === 'banner') {
            const nl = buf.indexOf('\r\n');
            if (nl < 0) return;
            if (!buf.startsWith('Asterisk Call Manager')) return finish(false, 'not an AMI server');
            buf = buf.slice(nl + 2);
            stage = 'login';
            socket.write(
              encode({ Action: 'Login', ActionID: 'sipkit-vm-1', Username: opts.username, Secret: opts.secret, Events: 'off' }),
            );
          }
          let end: number;
          while ((end = buf.indexOf('\r\n\r\n')) >= 0) {
            const msg = parseBlock(buf.slice(0, end));
            buf = buf.slice(end + 4);
            if (stage === 'login' && msg.actionid === 'sipkit-vm-1') {
              if (msg.response?.toLowerCase() !== 'success') return finish(false, `login: ${msg.message ?? msg.response}`);
              stage = 'refresh';
              socket.write(encode({ Action: 'VoicemailRefresh', ActionID: 'sipkit-vm-2', Context: context, Mailbox: mailbox }));
            } else if (stage === 'refresh' && msg.actionid === 'sipkit-vm-2') {
              if (msg.response?.toLowerCase() !== 'success') return finish(false, `refresh: ${msg.message ?? msg.response}`);
              stage = 'done';
              opts.logger?.debug(`AMI VoicemailRefresh ${mailbox}@${context} ok`);
              return finish(true);
            }
          }
        });
      });
    },
  };
}
