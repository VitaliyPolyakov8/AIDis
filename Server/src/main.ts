import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createPrismaClient } from './db/prisma.js';

const SESSION_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Logger is not configured yet; print a plain, readable message and exit.
      console.error(`[aidis] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const prisma = createPrismaClient(config.databaseUrl);
  const { app, ctx } = await buildApp({ config, prisma });

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    app.log.error({ err: error, event: 'db.unreachable' }, 'Database is not reachable at startup');
    await prisma.$disconnect();
    process.exit(1);
  }

  const purge = setInterval(() => {
    ctx.services.auth.purgeOldSessions().then(
      (count) => {
        if (count > 0) app.log.info({ event: 'auth.sessions_purged', count }, 'Old sessions purged');
      },
      (error: unknown) => {
        app.log.error({ err: error }, 'Session purge failed');
      },
    );
  }, SESSION_PURGE_INTERVAL_MS);
  purge.unref();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ event: 'shutdown', signal }, 'Shutting down');
    clearInterval(purge);
    const force = setTimeout(() => {
      app.log.error('Graceful shutdown timed out; exiting');
      process.exit(1);
    }, 10_000);
    force.unref();
    app
      .close()
      .then(() => prisma.$disconnect())
      .then(
        () => {
          app.log.info('Shutdown complete');
          process.exit(0);
        },
        (error: unknown) => {
          app.log.error({ err: error }, 'Error during shutdown');
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      event: 'startup',
      env: config.nodeEnv,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      voiceEnabled: config.livekit.enabled,
    },
    'AIDis backend started',
  );
}

main().catch((error: unknown) => {
  console.error('[aidis] Fatal startup error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
