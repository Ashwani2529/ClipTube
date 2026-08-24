import fs from 'fs/promises';
import type { Server } from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/db';
import { BINARY_PATHS } from './lib/binaries';
import { logger } from './lib/logger';
import { startCleanupSchedule, stopCleanupSchedule } from './services/cleanup.service';

async function bootstrap(): Promise<void> {
  logger.info('Starting ClipTube API…');

  Object.entries(BINARY_PATHS).forEach(([name, binaryPath]) => {
    logger.info(`${name}: ${binaryPath}`);
  });

  await fs.mkdir(env.tempDir, { recursive: true });
  logger.info(`Temp directory: ${env.tempDir}`);

  await connectDatabase();
  await startCleanupSchedule();

  const server: Server = createApp().listen(env.port, () => {
    logger.info(`API listening on http://localhost:${env.port}`);
    logger.info(`Allowed origins: ${env.corsOrigins.join(', ') || '(any)'}`);
  });

  // Clip downloads can take a while; don't let Node cut long responses short.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down.`);

    stopCleanupSchedule();
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });

    // Don't hang forever on keep-alive connections.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Startup failed:\n${message}`);
  process.exit(1);
});
