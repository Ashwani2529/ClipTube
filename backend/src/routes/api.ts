import fs from 'fs/promises';
import { Router, type Request, type Response } from 'express';
import { badRequest, conflict, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { normalizeYoutubeUrl } from '../lib/youtube';
import { parseTimeInput } from '../lib/time';
import { CLIP_TYPES, Job, type ClipType } from '../models/Job';
import { getDownloadCount, incrementDownloadCount } from '../models/Stats';
import { getFormats } from '../services/formats.service';
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

/** POST /api/formats — normalised video/audio format lists for a YouTube URL. */
apiRouter.post('/formats', async (req: Request, res: Response) => {
  const { url, videoId } = normalizeYoutubeUrl((req.body as { url?: unknown })?.url);
  const formats = await getFormats(videoId, url);

  if (formats.video.length === 0 && formats.audio.length === 0) {
    throw conflict('yt-dlp reported no downloadable formats for that video.');
  }

  res.json(formats);
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
