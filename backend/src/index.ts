import fs from 'fs/promises';
import type { Server } from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/db';
import { binaryPaths, isServerToolingAvailable, stageFfmpegDirectory } from './lib/binaries';
import { logger } from './lib/logger';
import { startCleanupSchedule, stopCleanupSchedule } from './services/cleanup.service';
import { prepareCookieFile } from './services/ytdlp.service';
import { startProxyPool } from './services/proxy.service';

/**
 * Prints when this file was compiled, plus the settings that actually shape the yt-dlp
 * command. A stale `dist/` is otherwise invisible in the logs — the process starts
 * cleanly and only the spawn arguments give it away.
 */
async function logBuildIdentity(): Promise<void> {
  const compiledAt = await fs
    .stat(__filename)
    .then((stat) => stat.mtime.toISOString())
    .catch(() => 'unknown');

  logger.info(`build: ${__filename} compiled ${compiledAt}`);
  logger.info(
    `effective yt-dlp settings: forceKeyframes=${env.ytdlp.forceKeyframes} ` +
      `cookies=${env.ytdlp.cookiesFile ? 'set' : 'none'} ` +
      `proxy=${env.ytdlp.proxy ? 'fixed' : env.ytdlp.autoProxy ? 'auto' : 'none'} ` +
      `extractorArgs=${env.ytdlp.extractorArgs || '(rotating)'} ` +
      `playerClients=[${env.ytdlp.playerClients.join(',')}]`,
  );
}

async function bootstrap(): Promise<void> {
  logger.info('Starting ClipTube API…');

  await logBuildIdentity();

  await fs.mkdir(env.tempDir, { recursive: true });
  logger.info(`Temp directory: ${env.tempDir}`);

  // Everything from here to the end of the block belongs to the *server fallback*. The
  // browser-first path needs none of it, so a deployment without these binaries still boots
  // and serves /resolve, /telemetry and /metrics — the fallback simply reports itself
  // unavailable and the client path carries every request.
  if (isServerToolingAvailable()) {
    Object.entries(binaryPaths()).forEach(([name, binaryPath]) => {
      logger.info(`${name}: ${binaryPath}`);
    });

    // yt-dlp needs ffmpeg and ffprobe side by side; see stageFfmpegDirectory().
    await stageFfmpegDirectory();
    await prepareCookieFile();
    startProxyPool();
  } else {
    logger.warn('Server-side extraction is unavailable; running browser-first only.');
  }

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
