import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createAmiRefresher, noopRefresher } from './mwi.js';
import { createVoicemailServer } from './server.js';
import { Spool } from './spool.js';

export { createVoicemailServer, createHandler, parseRange, type ServerDeps } from './server.js';
export { Spool, SpoolError, parseCallerId, parseMessageInfo, type VoicemailMessage } from './spool.js';
export { mintToken, verifyToken, type TokenClaims } from './token.js';
export { createAmiRefresher, noopRefresher, type MwiRefresher } from './mwi.js';
export { loadConfig, type ServiceConfig } from './config.js';

function main(): void {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  if (config.devToken) log.warn('VM_DEV_TOKEN is set: one token opens EVERY mailbox. Development only.');
  if (config.corsOrigins.includes('*')) log.warn('VM_CORS_ORIGINS=* allows any web origin');
  const refresher = config.ami ? createAmiRefresher({ ...config.ami, logger: log }) : noopRefresher;
  if (!config.ami) log.info('AMI not configured: MWI follows changes through Asterisk pollmailboxes only');
  const server = createVoicemailServer({ config, spool: new Spool({ root: config.spoolDir }), refresher, logger: log });
  server.listen(config.port, config.host, () =>
    log.info('voicemail-api listening', {
      port: config.port,
      spool: config.spoolDir,
      auth: [config.tokenSecret && 'hmac', config.staticTokens.size > 0 && 'static', config.devToken && 'dev']
        .filter(Boolean)
        .join(','),
    }),
  );
  const stop = () => {
    log.info('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
