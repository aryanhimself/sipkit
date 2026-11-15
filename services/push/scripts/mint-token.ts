/**
 * Mint an agent token the way a CRM backend would (HMAC-SHA256, PUSH_TOKEN_SECRET).
 *
 *   PUSH_TOKEN_SECRET=... pnpm --filter sipkit-push-service mint-token -- 1001 [ttlSeconds]
 */
import { mintToken } from '../src/tokens.ts';

const [extension, ttl] = process.argv.slice(2).filter((a) => a !== '--');
const secret = process.env.PUSH_TOKEN_SECRET ?? '';
if (!extension || !secret) {
  process.stderr.write('usage: PUSH_TOKEN_SECRET=... mint-token <extension> [ttlSeconds]\n');
  process.exit(1);
}
process.stdout.write(`${mintToken(secret, extension, ttl ? Number(ttl) : undefined)}\n`);
