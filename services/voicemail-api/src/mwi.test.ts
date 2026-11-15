import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createAmiRefresher } from './mwi.js';

let server: Server | undefined;

/** Minimal AMI: banner, Login (secret "good"), VoicemailRefresh, Logoff. */
async function fakeAmi(log: string[]): Promise<number> {
  server = createServer((socket: Socket) => {
    socket.write('Asterisk Call Manager/9.0.0\r\n');
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      let end: number;
      while ((end = buf.indexOf('\r\n\r\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 4);
        const f = Object.fromEntries(block.split('\r\n').map((l) => [l.split(':')[0]!.toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
        log.push(`${f.action}${f.mailbox ? ` ${f.mailbox}@${f.context}` : ''}`);
        if (f.action === 'Login')
          socket.write(
            f.secret === 'good'
              ? `Response: Success\r\nActionID: ${f.actionid}\r\nMessage: Authentication accepted\r\n\r\n`
              : `Response: Error\r\nActionID: ${f.actionid}\r\nMessage: Authentication failed\r\n\r\n`,
          );
        else if (f.action === 'VoicemailRefresh') socket.write(`Response: Success\r\nActionID: ${f.actionid}\r\n\r\n`);
        else if (f.action === 'Logoff') socket.end('Response: Goodbye\r\n\r\n');
      }
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

describe('AMI refresher', () => {
  it('logs in and sends VoicemailRefresh for the mailbox', async () => {
    const log: string[] = [];
    const port = await fakeAmi(log);
    const r = createAmiRefresher({ host: '127.0.0.1', port, username: 'vm', secret: 'good' });
    expect(await r.refresh('default', '1002')).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    expect(log).toEqual(['Login', 'VoicemailRefresh 1002@default', 'Logoff']);
  });

  it('resolves false on bad credentials or no server, never throws', async () => {
    const port = await fakeAmi([]);
    expect(await createAmiRefresher({ host: '127.0.0.1', port, username: 'vm', secret: 'bad' }).refresh('default', '1')).toBe(false);
    expect(await createAmiRefresher({ host: '127.0.0.1', port: 1, username: 'vm', secret: 'x', timeoutMs: 500 }).refresh('default', '1')).toBe(false);
  });
});

describe('loadConfig', () => {
  it('requires some authentication', () => {
    expect(() => loadConfig({})).toThrow(/No authentication/);
    expect(() => loadConfig({ VM_TOKEN_SECRET: 'short' })).toThrow(/32/);
  });

  it('parses env', () => {
    const c = loadConfig({
      VM_STATIC_TOKENS: '1001=aaaaaaaaaa, 2001@desk=bbbbbbbbbb',
      VM_CORS_ORIGINS: 'http://a.test, http://b.test',
      AMI_HOST: 'pbx',
      AMI_USERNAME: 'u',
      AMI_SECRET: 'p',
    });
    expect([...c.staticTokens]).toEqual([
      ['1001@default', 'aaaaaaaaaa'],
      ['2001@desk', 'bbbbbbbbbb'],
    ]);
    expect(c.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
    expect(c.ami).toEqual({ host: 'pbx', port: 5038, username: 'u', secret: 'p' });
  });
});
