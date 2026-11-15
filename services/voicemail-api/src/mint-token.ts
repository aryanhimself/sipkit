#!/usr/bin/env node
/**
 * Mint a short-lived mailbox token (dev / ops helper; a CRM backend mints its own).
 *
 *   VM_TOKEN_SECRET=... node dist/mint-token.js 1001[@context] [ttlSeconds]
 */
import { mintToken } from './token.js';

const [box, ttl] = process.argv.slice(2);
const secret = process.env.VM_TOKEN_SECRET;
if (!box || !secret) {
  process.stderr.write('usage: VM_TOKEN_SECRET=... sipkit-voicemail-token <mailbox[@context]> [ttlSeconds]\n');
  process.exit(2);
}
const [mailbox, context] = box.split('@');
process.stdout.write(
  `${mintToken(secret, { mailbox: mailbox!, context: context || process.env.VM_DEFAULT_CONTEXT || 'default', ttlSeconds: Number(ttl ?? 3600) })}\n`,
);
