import { loadConfig } from './config.ts';
import { createPushServer } from './server.ts';

const log = (message: string, data?: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), msg: message, ...data })}\n`);

const config = loadConfig();
const { server, service } = await createPushServer({ config, log });

// Housekeeping: drop expired / persistently failing subscriptions every hour.
const pruneTimer = setInterval(() => void service.prune().catch(() => undefined), 3600_000);
pruneTimer.unref();

server.listen(config.port, config.host, () => {
  log('listening', {
    port: config.port,
    store: config.storeFile || 'memory',
    devToken: Boolean(config.devToken),
    insecureEndpoints: config.allowInsecureEndpoints,
  });
});

const shutdown = () => {
  log('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
