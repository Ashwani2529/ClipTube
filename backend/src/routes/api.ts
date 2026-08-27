import fs from 'fs/promises';
import { Router, type Request, type Response } from 'express';
import { badRequest, conflict, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { normalizeYoutubeUrl } from '../lib/youtube';
import { parseTimeInput } from '../lib/time';
import { CLIP_TYPES, Job, type ClipType } from '../models/Job';
import { getDownloadCount, incrementDownloadCount } from '../models/Stats';
import { resolveWithServerSources } from '../services/sources';
import * as telemetry from '../services/telemetry.service';
import {
  createClipJob,
  getJob,
  processJob,
  removeJobFiles,
} from '../services/clip.service';
import type {
  ClipRequestBody,
  ClipResponse,
  JobStatusResponse,
  ResolveResponse,
  StatsResponse,
} from '../types/api';

export const apiRouter = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireJobId(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
    throw badRequest('That is not a valid job id.');
  }
  return raw;
}

const downloadUrlFor = (jobId: string) => `/api/download/${jobId}`;

function toStatusResponse(job: Awaited<ReturnType<typeof getJob>>): JobStatusResponse {
  return {
    jobId: job.jobId,
    status: job.status as JobStatusResponse['status'],
    progress: job.progress ?? 0,
    type: job.type as ClipType,
    title: job.title ?? '',
    fileName: job.fileName ?? null,
    sizeBytes: job.sizeBytes ?? null,
    error: job.error ?? null,
    downloadUrl: job.status === 'ready' ? downloadUrlFor(job.jobId) : null,
  };
}

/**
 * POST /api/resolve — everything the browser needs to build the clip itself.
 *
 * Metadata and format lists, plus signed stream URLs in `direct` when YouTube provides
 * them. This endpoint never transfers media: if the client can use the URLs, the bytes go
 * straight from YouTube to the user and our egress carries nothing.
 *
 * The frontend only reaches this after its own browser-side resolution has failed, so a
 * request arriving here already means the client path came up short.
 */
apiRouter.post('/resolve', async (req: Request, res: Response) => {
  const { url, videoId } = normalizeYoutubeUrl((req.body as { url?: unknown })?.url);
  const resolved = await resolveWithServerSources(videoId, url);

  if (resolved.video.length === 0 && resolved.audio.length === 0) {
    throw conflict('No downloadable formats were found for that video.');
  }

  const payload: ResolveResponse = {
    videoId,
    meta: resolved.meta,
    video: resolved.video,
    audio: resolved.audio,
    direct: resolved.direct,
  };

  res.json(payload);
});

/** POST /api/clip — creates a job and starts the download in the background. */
apiRouter.post('/clip', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as ClipRequestBody;
  const { url, videoId } = normalizeYoutubeUrl(body.url);

  const start = parseTimeInput(body.start ?? body.startTime, 'start');
  const end = parseTimeInput(body.end ?? body.endTime, 'end');
  if (end <= start) {
    throw badRequest('End time must be after start time.');
  }

  const type = body.type;
  if (typeof type !== 'string' || !CLIP_TYPES.includes(type as ClipType)) {
    throw badRequest("`type` must be either 'video' or 'audio'.");
  }

  const formatId = body.formatId;
  if (typeof formatId !== 'string' || !/^[\w.\-+]{1,64}$/.test(formatId)) {
    throw badRequest('`formatId` is missing or malformed.');
  }

  const job = await createClipJob({
    url,
    videoId,
    start,
    end,
    type: type as ClipType,
    formatId,
  });

  // Counted here, on job creation, so every press of Download registers regardless of
  // whether the clip later succeeds or the user actually saves the file.
  const totalDownloads = await incrementDownloadCount().catch((error: unknown) => {
    logger.warn('Could not increment download counter', error);
    return 0;
  });

  // Fire and forget: the client follows along via /api/status/:jobId.
  void processJob(job.jobId);

  const payload: ClipResponse = {
    jobId: job.jobId,
    status: 'queued',
    statusUrl: `/api/status/${job.jobId}`,
    downloadUrl: downloadUrlFor(job.jobId),
    totalDownloads,
  };

  res.status(202).json(payload);
});

/** GET /api/status/:jobId — polled by the client while the clip is being built. */
apiRouter.get('/status/:jobId', async (req: Request, res: Response) => {
  const job = await getJob(requireJobId(req.params.jobId));
  res.json(toStatusResponse(job));
});

/** GET /api/download/:jobId — streams the clip, then deletes it from disk. */
apiRouter.get('/download/:jobId', async (req: Request, res: Response) => {
  const jobId = requireJobId(req.params.jobId);
  const job = await getJob(jobId);

  if (job.status === 'failed') {
    throw conflict(job.error ?? 'That clip failed to build.');
  }
  if (job.status === 'downloaded') {
    throw notFound('That clip has already been downloaded and removed from the server.');
  }
  if (job.status !== 'ready' || !job.filePath || !job.fileName) {
    throw conflict('That clip is not ready yet.');
  }

  const filePath = job.filePath;
  const fileName = job.fileName;

  try {
    await fs.access(filePath);
  } catch {
    await Job.updateOne(
      { jobId },
      { $set: { status: 'failed', error: 'The clip expired and was removed.', filePath: null } },
    );
    throw notFound('That clip is no longer on the server. Please clip it again.');
  }

  await Job.updateOne({ jobId }, { $set: { servedAt: new Date() } });

  // Only a fully flushed response counts as delivered; aborted transfers leave the file
  // in place so the user can retry, and the hourly sweep removes it either way.
  res.on('finish', () => {
    void (async () => {
      try {
        await removeJobFiles(jobId);
        await Job.updateOne(
          { jobId },
          { $set: { status: 'downloaded', filePath: null } },
        );
        logger.info(`Served and removed clip for job ${jobId}`);
      } catch (error) {
        logger.warn(`Could not clean up job ${jobId} after download`, error);
      }
    })();
  });

  res.download(filePath, fileName, (error) => {
    if (error) {
      logger.warn(`Download stream for job ${jobId} ended early`, error);
    }
  });
});

/** GET /api/stats — all-time download count. */
apiRouter.get('/stats', async (_req: Request, res: Response) => {
  const payload: StatsResponse = { totalDownloads: await getDownloadCount() };
  res.json(payload);
});

const OUTCOME_VALUES = new Set(telemetry.OUTCOMES as readonly string[]);
const TRISTATE = new Set(['success', 'failure', 'skipped']);
const ACQUISITIONS = new Set(['capture', 'direct', 'server']);

/** Bounded so a malformed or hostile body cannot distort the experiment's numbers. */
function clampNumber(raw: unknown, max: number): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return Math.min(Math.max(0, Math.round(value)), max);
}

function pick<T extends string>(raw: unknown, allowed: Set<string>, fallback: T): T {
  return typeof raw === 'string' && allowed.has(raw) ? (raw as T) : fallback;
}

/**
 * POST /api/telemetry — one record per finished clip attempt.
 *
 * Accepts only the enumerated operational fields below; anything else in the body is
 * ignored. Counters live in memory and are never persisted, so this cannot accumulate into
 * a history of what anyone clipped.
 */
apiRouter.post('/telemetry', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  telemetry.record({
    outcome: pick(body.outcome, OUTCOME_VALUES, 'failed'),
    browserResolution: pick(body.browserResolution, TRISTATE, 'skipped'),
    clientProcessing: pick(body.clientProcessing, TRISTATE, 'skipped'),
    serverFallback: body.serverFallback === 'used' ? 'used' : 'not-used',
    acquisition:
      typeof body.acquisition === 'string' && ACQUISITIONS.has(body.acquisition)
        ? (body.acquisition as 'capture' | 'direct' | 'server')
        : null,
    // Codes come from a fixed frontend vocabulary; truncated in case that ever drifts.
    failureCode:
      typeof body.failureCode === 'string' && body.failureCode !== ''
        ? body.failureCode.slice(0, 48)
        : null,
    durationMs: clampNumber(body.durationMs, 6 * 60 * 60_000),
    clipSeconds: clampNumber(body.clipSeconds, 24 * 60 * 60),
    platform: typeof body.platform === 'string' ? body.platform : 'desktop',
  });

  // Nothing to say back; the client fires this and forgets it.
  res.status(204).end();
});

/**
 * GET /api/metrics — aggregated results of the browser-first experiment.
 *
 * `clientOnlySuccessRatePercent` is the headline figure: the share of completed clips where
 * the backend made no YouTube request at all.
 */
apiRouter.get('/metrics', (_req: Request, res: Response) => {
  res.json(telemetry.snapshot());
});
