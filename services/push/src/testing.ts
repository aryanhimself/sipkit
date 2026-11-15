import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Test helpers: a browser-like subscriber key pair, an RFC 8291 (aes128gcm)
 * decryptor and a local fake push service. They let tests verify real,
 * encrypted Web Push messages end to end without Google/Mozilla push servers
 * (headless Chromium cannot create real push subscriptions).
 */

export interface SubscriberKeys {
  /** base64url uncompressed P-256 public key (the subscription's `keys.p256dh`). */
  p256dh: string;
  /** base64url 16-byte auth secret (`keys.auth`). */
  auth: string;
  /** base64url private key (keep in the test). */
  privateKey: string;
}

export function createSubscriberKeys(): SubscriberKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** Decrypt an `aes128gcm` Web Push body (RFC 8188 + RFC 8291) with the subscriber's keys. */
export function decryptWebPush(body: Buffer, keys: SubscriberKeys): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20]!;
  const senderPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  if (ciphertext.length > rs) throw new Error('multi-record payloads are not supported');

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'));
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const secret = ecdh.computeSecret(senderPublic);
  const prkKey = hmac(Buffer.from(keys.auth, 'base64url'), secret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, senderPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('bad padding delimiter');
  return plain.subarray(0, end).toString('utf8');
}

export interface ReceivedPush {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface FakePushEndpoint {
  url: string;
  received: ReceivedPush[];
  /** Status code answered to the next pushes (e.g. 410 to simulate an expired subscription). */
  respondWith(status: number): void;
  close(): Promise<void>;
}

/** A local stand-in for FCM / Mozilla autopush: records every push it receives. */
export async function startFakePushEndpoint(host = '127.0.0.1', advertisedHost = host): Promise<FakePushEndpoint> {
  const received: ReceivedPush[] = [];
  let status = 201;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${advertisedHost}:${port}`,
    received,
    respondWith: (s) => {
      status = s;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
