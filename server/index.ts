import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { createApp } from './app.ts';
import { describeError } from './errors.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

// Last line of defence. After an uncaught exception the process state is unknown, so the only
// honest thing is to log and exit non-zero; a supervisor (systemd, Docker) restarts us.
// (README: "What if an 'error' has no listener?")
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { error: error.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', {
    error: reason instanceof Error ? reason.stack : String(reason),
  });
  process.exit(1);
});

const app = createApp({ config, logger });
const { url } = await app.start();
logger.info('listening', { url, logDir: config.logDir, staticDir: config.staticDir });

let stopping = false;
async function shutdown(signal: NodeJS.Signals) {
  if (stopping) {
    logger.warn('second signal: exiting now', { signal });
    process.exit(1);
  }
  stopping = true;
  logger.info('shutting down', { signal });
  try {
    await app.stop();
    logger.info('bye');
    process.exit(0);
  } catch (error) {
    logger.error('shutdown failed', { error: describeError(error) });
    process.exit(1);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
