import { ProcessError, run } from '../lib/exec';
import { FFMPEG_PATH, YTDLP_PATH } from '../lib/binaries';
import { upstreamFailure } from '../lib/errors';
import { logger } from '../lib/logger';

/** The subset of yt-dlp's `-J` output this app relies on. */
export interface RawFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  width?: number | null;
  fps?: number | null;
  tbr?: number | null;
  vbr?: number | null;
  abr?: number | null;
  asr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  format_note?: string | null;
  protocol?: string | null;
  language?: string | null;
  dynamic_range?: string | null;
  audio_channels?: number | null;
}

export interface RawVideoInfo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number | null;
  thumbnail?: string | null;
  webpage_url?: string;
  is_live?: boolean;
  live_status?: string | null;
  formats?: RawFormat[];
}

const BASE_ARGS = ['--no-playlist', '--no-warnings', '--ignore-config'];

/** Turns yt-dlp's stderr into something worth showing a user. */
function describeFailure(error: unknown): string {
  if (!(error instanceof ProcessError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const stderr = error.stderr.toLowerCase();
  if (stderr.includes('private video')) return 'That video is private.';
  if (stderr.includes('video unavailable')) return 'That video is unavailable.';
  if (stderr.includes('members-only')) return 'That video is members-only.';
  if (stderr.includes('age')) return 'That video is age-restricted and cannot be fetched.';
  if (stderr.includes('sign in to confirm')) {
    return 'YouTube asked for sign-in verification for this video.';
  }
  if (stderr.includes('is not a valid url')) return 'yt-dlp rejected that URL.';
  if (stderr.includes('requested format is not available')) {
    return 'That format is no longer available — refresh the format list and try again.';
  }

  const firstError = error.stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('ERROR:'));

  return firstError ?? 'yt-dlp could not process that video.';
}

/** Fetches the full metadata blob (`yt-dlp -J`) for a single video. */
export async function fetchVideoInfo(url: string): Promise<RawVideoInfo> {
  try {
    const { stdout } = await run(YTDLP_PATH, [...BASE_ARGS, '--no-progress', '-J', url], {
      timeoutMs: 90_000,
    });
    const parsed = JSON.parse(stdout) as RawVideoInfo;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.formats)) {
      throw upstreamFailure('yt-dlp returned no formats for that video.');
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.error('Failed to parse yt-dlp JSON output', error);
      throw upstreamFailure('Could not read the response from yt-dlp.');
    }
    logger.error('yt-dlp metadata fetch failed', error);
    throw upstreamFailure(describeFailure(error));
  }
}

export interface DownloadSectionOptions {
  url: string;
  formatSelector: string;
  /** `*start-end` section bounds, in seconds. */
  startSeconds: number;
  endSeconds: number;
  /** Output template, e.g. `<dir>/clip.%(ext)s`. */
  outputTemplate: string;
  mergeContainer?: 'mp4' | null;
  onProgress?: (percent: number) => void;
  timeoutMs?: number;
}

const PROGRESS_PATTERN = /^progress:\s*(\d+(?:\.\d+)?)$/;

/**
 * Downloads just the requested section at the requested format.
 *
 * `--force-keyframes-at-cuts` makes yt-dlp re-encode around the cut points so the clip
 * starts exactly where the user asked instead of snapping to the previous keyframe.
 */
export async function downloadSection(options: DownloadSectionOptions): Promise<void> {
  const section = `*${options.startSeconds.toFixed(3)}-${options.endSeconds.toFixed(3)}`;

  const args = [
    ...BASE_ARGS,
    // yt-dlp needs ffmpeg for section cuts and merging; point it at the bundled one.
    '--ffmpeg-location',
    FFMPEG_PATH,
    '-f',
    options.formatSelector,
    '--download-sections',
    section,
    '--force-keyframes-at-cuts',
    '--no-part',
    '--no-mtime',
    '--newline',
    // Machine-readable progress on stdout instead of the interactive progress bar.
    '--progress-template',
    'progress:%(progress._percent_str)s',
    '-o',
    options.outputTemplate,
  ];

  if (options.mergeContainer) {
    args.push('--merge-output-format', options.mergeContainer);
  }

  args.push(options.url);

  try {
    await run(YTDLP_PATH, args, {
      timeoutMs: options.timeoutMs ?? 20 * 60_000,
      onStdoutLine: (line) => {
        const match = PROGRESS_PATTERN.exec(line.replace(/%/g, '').trim());
        if (match && options.onProgress) {
          options.onProgress(Math.min(100, Number.parseFloat(match[1] as string)));
        }
      },
    });
  } catch (error) {
    logger.error('yt-dlp download failed', error);
    throw upstreamFailure(describeFailure(error));
  }
}
