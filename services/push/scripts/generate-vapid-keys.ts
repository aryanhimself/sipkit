/**
 * Generate a VAPID key pair (P-256) for the push service.
 *
 *   pnpm --filter sipkit-push-service gen:vapid            # prints .env lines
 *   pnpm --filter sipkit-push-service gen:vapid -- --json  # prints JSON
 *
 * Keep the private key secret (env / secret manager, never git). The public
 * key goes to browsers (GET /vapid-public-key or softphone `push.vapidPublicKey`).
 * Rotating the pair invalidates every existing subscription: agents must
 * re-enable push (the softphone re-subscribes automatically on next sign-in).
 */
import { randomBytes } from 'node:crypto';
import { generateVapidKeys } from '../src/sender.ts';

const keys = generateVapidKeys();
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(keys, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `VAPID_PUBLIC_KEY=${keys.publicKey}`,
      `VAPID_PRIVATE_KEY=${keys.privateKey}`,
      `PUSH_TOKEN_SECRET=${randomBytes(32).toString('base64url')}`,
      `PUSH_NOTIFY_SECRET=${randomBytes(24).toString('base64url')}`,
      '',
    ].join('\n'),
  );
}
