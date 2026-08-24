import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { slugify } from '../lib/slugify';
import { probe, remux } from '../lib/ffmpeg';
import { HttpError, badRequest, notFound } from '../lib/errors';
import { Job, type ClipType, type JobDocument } from '../models/Job';
import { downloadSection } from './ytdlp.service';
import { findFormat, getVideoInfo, toMeta } from './formats.service';

/** Sub-directory per job keeps the human-readable filename collision-free. */
export const jobDirectory = (jobId: string): string => path.join(env.tempDir, jobId);

/** yt-dlp's cut is keyframe-aligned; anything past this gets trimmed by ffmpeg. */
const DURATION_TOLERANCE_SECONDS = 0.75;

/** Progress budget: yt-dlp owns 0–90, the ffmpeg pass owns 90–100. */
const DOWNLOAD_PROGRESS_CEILING = 90;

export interface CreateClipInput {
  url: string;
  videoId: string;
  start: number;
  end: number;
  type: ClipType;
  formatId: string;
}

function containerForAudioCodec(acodec: string | null | undefined, sourceExt: string): string {
  const base = (acodec ?? '').split('.')[0]?.toLowerCase() ?? '';

  if (base === 'mp4a' || base === 'aac') return 'm4a';
  if (base === 'opus') return 'opus';
  if (base === 'mp3') return 'mp3';
  if (base === 'vorbis') return 'ogg';
  if (base === 'flac') return 'flac';
  if (base === 'ac-3' || base === 'ac3') return 'ac3';
  if (base === 'ec-3' || base === 'eac3') return 'eac3';

  return sourceExt || 'm4a';
}

/**
 * A video-only format has to be merged with an audio track. Preferring m4a audio keeps
 * the mp4 merge a straight stream copy instead of a transcode.
 */
function buildFormatSelector(type: ClipType, formatId: string, hasAudio: boolean): string {
  if (type === 'audio') return formatId;
  if (hasAudio) return formatId;
  return `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio/${formatId}`;
}

/**
 * Intermediate download name. The leading dot guarantees it can never collide with the
 * slugified final filename, so the ffmpeg pass never reads and writes the same path.
 */
const SOURCE_STEM = '.download';

/**
 * Finds what yt-dlp actually wrote. It picks the largest matching file rather than the
 * first, so a stray leftover fragment can't be mistaken for the clip.
 */
async function findDownloadedFile(directory: string): Promise<string | null> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());

  const preferred = files.filter((entry) => entry.name.startsWith(`${SOURCE_STEM}.`));
  const pool = preferred.length > 0 ? preferred : files;

  const sized = await Promise.all(
    pool.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      return { filePath, size: stat?.size ?? 0 };
    }),
  );

  const largest = sized.sort((a, b) => b.size - a.size)[0];
  return largest && largest.size > 0 ? largest.filePath : null;
}

export async function removeJobFiles(jobId: string): Promise<void> {
  await fs.rm(jobDirectory(jobId), { recursive: true, force: true });
}

/**
 * Validates the request against the source video and persists a queued job. The heavy
 * work is kicked off separately by `processJob` so the HTTP response returns at once.
 */
export async function createClipJob(input: CreateClipInput): Promise<JobDocument> {
  const info = await getVideoInfo(input.videoId, input.url);
  const meta = toMeta(info, input.videoId, input.url);

  if (meta.isLive) {
    throw badRequest('Live streams cannot be clipped.');
  }

  const format = findFormat(info, input.formatId);
  if (!format) {
    throw badRequest('That format is not available for this video. Refresh and try again.');
  }

  const duration = meta.durationSeconds;
  if (duration > 0 && input.start >= duration) {
    throw badRequest('Start time is past the end of the video.');
  }

  const end = duration > 0 ? Math.min(input.end, duration) : input.end;
  if (end - input.start < 0.5) {
    throw badRequest('The clip must be at least half a second long.');
  }
  if (end - input.start > env.maxClipSeconds) {
    throw badRequest(
      `Clips are limited to ${Math.floor(env.maxClipSeconds / 60)} minutes. Pick a shorter range.`,
    );
  }

  return Job.create({
    jobId: uuidv4(),
    url: input.url,
    videoId: input.videoId,
    title: meta.title,
    start: input.start,
    end,
    type: input.type,
    formatId: input.formatId,
    status: 'queued',
    progress: 0,
  });
}

/** Throttled progress writes — the poller only needs a coarse number. */
function progressWriter(jobId: string) {
  let lastWrittenAt = 0;
  let lastValue = -1;

  return (value: number) => {
    const rounded = Math.round(value);
    const now = Date.now();
    if (rounded === lastValue || now - lastWrittenAt < 750) return;

    lastValue = rounded;
    lastWrittenAt = now;
    void Job.updateOne({ jobId }, { $set: { progress: rounded } }).catch((error: unknown) => {
      logger.warn(`Could not persist progress for job ${jobId}`, error);
    });
  };
}

/**
 * Runs the full pipeline for a job: download the requested section with yt-dlp, then
 * copy it into its final container with ffmpeg. Never throws — failures are recorded on
 * the job document so the client can surface them.
 */
export async function processJob(jobId: string): Promise<void> {
  const job = await Job.findOne({ jobId });
  if (!job) {
    logger.warn(`processJob called for unknown job ${jobId}`);
    return;
  }

  const directory = jobDirectory(jobId);
  const reportProgress = progressWriter(jobId);

  try {
    await fs.mkdir(directory, { recursive: true });
    await Job.updateOne({ jobId }, { $set: { status: 'downloading', progress: 0 } });

    const info = await getVideoInfo(job.videoId, job.url);
    const format = findFormat(info, job.formatId);
    if (!format) {
      throw new HttpError(410, 'That format expired before the download started.');
    }

    const type = job.type as ClipType;
    const hasAudio = Boolean(format.acodec && format.acodec !== 'none');
    const targetExt =
      type === 'video' ? 'mp4' : containerForAudioCodec(format.acodec, format.ext ?? 'm4a');

    await downloadSection({
      url: job.url,
      formatSelector: buildFormatSelector(type, job.formatId, hasAudio),
      startSeconds: job.start,
      endSeconds: job.end,
      outputTemplate: path.join(directory, `${SOURCE_STEM}.%(ext)s`),
      mergeContainer: type === 'video' ? 'mp4' : null,
      onProgress: (percent) =>
        reportProgress((percent / 100) * DOWNLOAD_PROGRESS_CEILING),
    });

    const sourcePath = await findDownloadedFile(directory);
    if (!sourcePath) {
      throw new Error('yt-dlp finished but produced no file.');
    }

    await Job.updateOne(
      { jobId },
      { $set: { status: 'processing', progress: DOWNLOAD_PROGRESS_CEILING } },
    );

    const requestedDuration = job.end - job.start;
    const probed = await probe(sourcePath).catch((error: unknown) => {
      logger.warn(`ffprobe failed for job ${jobId}`, error);
      return null;
    });

    const overshoot =
      probed?.durationSeconds != null &&
      probed.durationSeconds - requestedDuration > DURATION_TOLERANCE_SECONDS;

    const fileName = `${slugify(job.title || 'clip')}-clip.${targetExt}`;
    const finalPath = path.join(directory, fileName);

    await remux({
      input: sourcePath,
      output: finalPath,
      kind: type,
      limitSeconds: overshoot ? requestedDuration : null,
      onProgress: (percent) =>
        reportProgress(
          DOWNLOAD_PROGRESS_CEILING + (percent / 100) * (100 - DOWNLOAD_PROGRESS_CEILING),
        ),
    });
    await fs.rm(sourcePath, { force: true });

    const stat = await fs.stat(finalPath);

    await Job.updateOne(
      { jobId },
      {
        $set: {
          status: 'ready',
          progress: 100,
          filePath: finalPath,
          fileName,
          sizeBytes: stat.size,
          error: null,
          completedAt: new Date(),
        },
      },
    );

    logger.info(`Job ${jobId} ready — ${fileName} (${stat.size} bytes)`);
  } catch (error) {
    const message =
      error instanceof HttpError || error instanceof Error
        ? error.message
        : 'The clip could not be created.';

    logger.error(`Job ${jobId} failed`, error);

    await Job.updateOne(
      { jobId },
      { $set: { status: 'failed', error: message, filePath: null, fileName: null } },
    ).catch(() => undefined);

    await removeJobFiles(jobId).catch(() => undefined);
  }
}

export async function getJob(jobId: string): Promise<JobDocument> {
  const job = await Job.findOne({ jobId });
  if (!job) throw notFound('No job with that id.');
  return job;
}
