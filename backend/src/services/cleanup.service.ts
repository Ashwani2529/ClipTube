import fs from 'fs/promises';
import path from 'path';
import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { Job } from '../models/Job';

/**
 * Deletes anything in the temp folder older than the TTL. This is the safety net for
 * clips whose download was never started or never finished — the happy path unlinks the
 * file as soon as the response is flushed.
 */
export async function sweepTempDirectory(): Promise<{ removed: number; failed: number }> {
  await fs.mkdir(env.tempDir, { recursive: true });

  const cutoff = Date.now() - env.tempFileTtlMinutes * 60_000;
  const entries = await fs.readdir(env.tempDir, { withFileTypes: true });

  let removed = 0;
  let failed = 0;

  for (const entry of entries) {
    const target = path.join(env.tempDir, entry.name);

    try {
      const stat = await fs.stat(target);
      // mtime covers both cases: a directory's mtime updates as files land in it.
      if (stat.mtimeMs > cutoff) continue;

      await fs.rm(target, { recursive: true, force: true });
      removed += 1;

      // A job whose files are gone can never be served again; mark it so /status is honest.
      if (entry.isDirectory()) {
        await Job.updateOne(
          { jobId: entry.name, status: { $in: ['ready', 'queued', 'downloading', 'processing'] } },
          { $set: { status: 'failed', error: 'The clip expired before it was downloaded.', filePath: null } },
        ).catch(() => undefined);
      }
    } catch (error) {
      failed += 1;
      logger.warn(`Could not remove stale temp entry ${target}`, error);
    }
  }

  if (removed > 0 || failed > 0) {
    logger.info(`Temp sweep: removed ${removed}, failed ${failed}`);
  }

  return { removed, failed };
}

let task: ScheduledTask | null = null;

/** Runs one sweep immediately, then on the configured cron schedule. */
export async function startCleanupSchedule(): Promise<void> {
  await sweepTempDirectory().catch((error: unknown) => {
    logger.error('Startup temp sweep failed', error);
  });

  if (!cron.validate(env.cleanupCron)) {
    logger.warn(`CLEANUP_CRON "${env.cleanupCron}" is not a valid expression — hourly default used.`);
  }

  const expression = cron.validate(env.cleanupCron) ? env.cleanupCron : '0 * * * *';

  task = cron.schedule(expression, () => {
    void sweepTempDirectory().catch((error: unknown) => {
      logger.error('Scheduled temp sweep failed', error);
    });
  });

  logger.info(
    `Temp cleanup scheduled (${expression}); files older than ${env.tempFileTtlMinutes} min are removed.`,
  );
}

export function stopCleanupSchedule(): void {
  task?.stop();
  task = null;
}
