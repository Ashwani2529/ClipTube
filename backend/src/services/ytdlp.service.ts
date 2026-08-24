import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ProcessError, run } from '../lib/exec';
import { YTDLP_PATH, ffmpegLocation } from '../lib/binaries';
import { upstreamFailure } from '../lib/errors';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { activeProxy, rotateProxy } from './proxy.service';

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

/** Writable copy of the configured cookie file; see prepareCookieFile(). */
let cookieFile: string | null = null;

/**
 * Cookies YouTube only sets for a signed-in session. A cookie file exported while logged
 * out parses fine and is accepted by yt-dlp, but YouTube still treats the request as
 * anonymous — which looks exactly like the bot check having ignored the cookies.
 */
const SIGNED_IN_COOKIES = [
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  'LOGIN_INFO',
];

/**
 * Reports what the cookie file actually contains. This is diagnosis only — nothing here
 * blocks startup, because yt-dlp is the real authority on whether cookies work.
 */
async function inspectCookieFile(filePath: string): Promise<void> {
  let contents: string;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    logger.warn(`Could not read the cookie file for inspection.`, error);
    return;
  }

  const lines = contents.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));

  if (lines.length === 0) {
    logger.warn('The cookie file has no cookie entries — YouTube will treat requests as anonymous.');
    return;
  }

  // Netscape format is tab-separated: domain, flag, path, secure, expiry, name, value.
  const names = new Set(
    lines.map((line) => line.split('\t')[5]).filter((name): name is string => Boolean(name)),
  );

  if (names.size === 0) {
    logger.warn(
      'The cookie file is not tab-separated Netscape format. Re-export it with a ' +
        '"Netscape/cookies.txt" exporter — yt-dlp cannot use JSON or header-string dumps.',
    );
    return;
  }

  const youtubeLines = lines.filter((line) => line.includes('youtube.com'));
  const signedIn = SIGNED_IN_COOKIES.filter((name) => names.has(name));

  if (youtubeLines.length === 0) {
    logger.warn(
      `The cookie file has ${lines.length} cookies but none for youtube.com — it was ` +
        'probably exported from the wrong site.',
    );
    return;
  }

  if (signedIn.length === 0) {
    logger.warn(
      `The cookie file has ${youtubeLines.length} youtube.com cookies but none of the ` +
        `signed-in session cookies (${SIGNED_IN_COOKIES.join(', ')}). It looks like a ` +
        'logged-out export, which will not clear the bot check. Re-export while signed in.',
    );
    return;
  }

  logger.info(
    `Cookie file looks signed in: ${youtubeLines.length} youtube.com cookies, ` +
      `including ${signedIn.join(', ')}.`,
  );
}

/**
 * `--cookies` is read *and written*: yt-dlp dumps the refreshed cookie jar back to the
 * file when it exits. Secret mounts are read-only (Render puts them in `/etc/secrets`),
 * so the configured file is copied somewhere writable and yt-dlp is pointed at the copy.
 *
 * Failures here are not fatal — we fall back to the original path and let yt-dlp decide.
 */
export async function prepareCookieFile(): Promise<void> {
  const source = env.ytdlp.cookiesFile;
  if (!source) {
    cookieFile = null;
    return;
  }

  try {
    await fs.access(source);
  } catch {
    cookieFile = null;
    logger.warn(
      `YTDLP_COOKIES_FILE is set to "${source}" but that file cannot be read — continuing without cookies.`,
    );
    return;
  }

  // Deliberately not inside env.tempDir: the cleanup sweep would delete it after the TTL.
  const destination = path.join(os.tmpdir(), 'cliptube-yt-dlp-cookies.txt');

  try {
    await fs.copyFile(source, destination);
    cookieFile = destination;
    logger.info(`Using cookies from ${source} (working copy at ${destination})`);
  } catch (error) {
    cookieFile = source;
    logger.warn(
      `Could not copy the cookie file to a writable location; using ${source} directly.`,
      error,
    );
  }

  await inspectCookieFile(cookieFile);
}

/**
 * Args shared by every yt-dlp invocation, including the optional cookie/proxy/extractor
 * settings that get a cloud-hosted instance past YouTube's bot checks. Each is omitted
 * entirely when its variable is unset, so a blank value is always safe.
 */
function baseArgs(): string[] {
  const args = ['--no-playlist', '--no-warnings', '--ignore-config'];

  if (cookieFile) args.push('--cookies', cookieFile);

  // Read per call, not cached: rotation swaps these out between retries.
  const proxy = activeProxy();
  if (proxy) args.push('--proxy', proxy);

  if (env.ytdlp.extractorArgs) {
    args.push('--extractor-args', env.ytdlp.extractorArgs);
  } else {
    const client = env.ytdlp.playerClients[clientCursor];
    // `default` means "let yt-dlp choose", so no flag at all.
    if (client && client !== 'default') {
      args.push('--extractor-args', `youtube:player_client=${client}`);
    }
  }

  if (env.ytdlp.sleepInterval > 0) {
    args.push('--sleep-interval', String(env.ytdlp.sleepInterval));
    if (env.ytdlp.maxSleepInterval > env.ytdlp.sleepInterval) {
      args.push('--max-sleep-interval', String(env.ytdlp.maxSleepInterval));
    }
  }

  return args;
}

/** True when YouTube refused the request rather than the download itself failing. */
function isBlockedByYoutube(error: unknown): boolean {
  if (!(error instanceof ProcessError)) return false;
  const stderr = error.stderr.toLowerCase();
  return (
    stderr.includes('sign in to confirm') ||
    stderr.includes('not a bot') ||
    stderr.includes('http error 403') ||
    stderr.includes('unable to connect to proxy') ||
    (stderr.includes('proxy') && stderr.includes('timed out'))
  );
}

/** Index into env.ytdlp.playerClients for the client the next call will use. */
let clientCursor = 0;

/**
 * Moves to the next player client. Returns false once they are all spent, which resets
 * the cursor so the next request starts from the preferred client again.
 */
function rotatePlayerClient(): boolean {
  // An explicit --extractor-args override means the operator is in charge; don't fight it.
  if (env.ytdlp.extractorArgs) return false;

  if (clientCursor + 1 >= env.ytdlp.playerClients.length) {
    clientCursor = 0;
    return false;
  }

  clientCursor += 1;
  logger.warn(
    `YouTube blocked the request — retrying with player_client=${env.ytdlp.playerClients[clientCursor]}.`,
  );
  return true;
}

/**
 * Retries while YouTube keeps refusing us, escalating through the two levers we have:
 * first a different player client (cheap, no new network path), then a different proxy
 * (the loop yt-dlp-proxy runs). Non-block failures propagate immediately.
 */
async function withUnblockRetries<T>(operation: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isBlockedByYoutube(error)) throw error;
      // Exhausting the clients resets the cursor, so the proxy retry starts fresh.
      if (!rotatePlayerClient() && !rotateProxy()) throw error;
    }
  }
}

/** True when yt-dlp's helper ffmpeg died on a signal (code -11 is SIGSEGV). */
export function isFfmpegCrash(error: unknown): boolean {
  return (
    error instanceof ProcessError && /ffmpeg exited with code -\d+/i.test(error.stderr)
  );
}

/**
 * Raised when the section download can't be completed because the ffmpeg that yt-dlp
 * uses to fetch it crashed. Signals the caller to fall back to fetching the whole format
 * and trimming it locally, which keeps ffmpeg away from the network stream.
 */
export class SectionDownloadUnavailable extends Error {
  constructor(cause: unknown) {
    super('The section download failed because ffmpeg crashed.', { cause });
    this.name = 'SectionDownloadUnavailable';
  }
}

/** Turns yt-dlp's stderr into something worth showing a user. */
function describeFailure(error: unknown): string {
  if (!(error instanceof ProcessError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const stderr = error.stderr.toLowerCase();
  if (stderr.includes('private video')) return 'That video is private.';
  if (stderr.includes('video unavailable')) return 'That video is unavailable.';
  if (stderr.includes('members-only')) return 'That video is members-only.';
  if (stderr.includes('age-restricted') || stderr.includes('confirm your age')) {
    return 'That video is age-restricted and cannot be fetched without sign-in.';
  }
  if (stderr.includes('sign in to confirm') || stderr.includes('not a bot')) {
    return (
      'YouTube blocked this request as automated. This usually happens on cloud/server ' +
      'IPs — set YTDLP_COOKIES_FILE or YTDLP_PROXY on the server to get past it.'
    );
  }
  if (stderr.includes('is not a valid url')) return 'yt-dlp rejected that URL.';
  if (stderr.includes('requested format is not available')) {
    return 'That format is no longer available — refresh the format list and try again.';
  }
  if (isFfmpegCrash(error)) {
    return 'ffmpeg crashed while cutting this clip. Try a lower quality or a shorter range.';
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
    const { stdout } = await withUnblockRetries(() =>
      run(YTDLP_PATH, [...baseArgs(), '--no-progress', '-J', url], { timeoutMs: 90_000 }),
    );
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
  /**
   * Estimated final size. Section downloads run through ffmpeg, which reports no
   * percentage, so bytes-on-disk against this estimate is the only progress signal.
   */
  expectedBytes?: number | null;
  timeoutMs?: number;
}

const PROGRESS_PATTERN = /^progress:\s*(\d+(?:\.\d+)?)$/;

function sectionArgs(options: DownloadSectionOptions, forceKeyframes: boolean): string[] {
  const section = `*${options.startSeconds.toFixed(3)}-${options.endSeconds.toFixed(3)}`;

  const args = [
    ...baseArgs(),
    // yt-dlp needs ffmpeg for section cuts and merging; point it at the bundled one.
    '--ffmpeg-location',
    ffmpegLocation(),
    '-f',
    options.formatSelector,
    '--download-sections',
    section,
    '--no-part',
    '--no-mtime',
    '--force-overwrites',
    '--newline',
    // Machine-readable progress on stdout instead of the interactive progress bar.
    '--progress-template',
    'progress:%(progress._percent_str)s',
    '-o',
    options.outputTemplate,
  ];

  if (forceKeyframes) {
    args.push('--force-keyframes-at-cuts');
  }

  if (options.mergeContainer) {
    args.push('--merge-output-format', options.mergeContainer);
  }

  args.push(options.url);
  return args;
}

/** Clears leftovers so a retry can't resume from, or pick up, a half-written file. */
async function clearWorkDir(outputTemplate: string): Promise<void> {
  const directory = path.dirname(outputTemplate);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
}

/** Total bytes of the files yt-dlp has written into the work directory so far. */
async function bytesOnDisk(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const stat = await fs.stat(path.join(directory, entry.name)).catch(() => null);
        return stat?.size ?? 0;
      }),
  );

  return sizes.reduce((total, size) => total + size, 0);
}

/**
 * Polls the work directory and turns bytes written into a percentage. This is what
 * actually drives the progress bar for section downloads, since yt-dlp's own progress
 * hook stays silent while ffmpeg does the fetching.
 */
function trackDiskProgress(options: {
  outputTemplate: string;
  expectedBytes?: number | null;
  onProgress?: (percent: number) => void;
}): () => void {
  const expected = options.expectedBytes ?? 0;
  if (expected <= 0 || !options.onProgress) return () => undefined;

  const directory = path.dirname(options.outputTemplate);
  const timer = setInterval(() => {
    void bytesOnDisk(directory)
      .then((bytes) => {
        // Capped below 100 so the bar never claims completion before the process exits.
        options.onProgress?.(Math.min(99, (bytes / expected) * 100));
      })
      .catch(() => undefined);
  }, 1000);

  return () => clearInterval(timer);
}

async function attemptSection(
  options: DownloadSectionOptions,
  forceKeyframes: boolean,
): Promise<void> {
  const stopTracking = trackDiskProgress(options);

  try {
    await withUnblockRetries(async () => {
      // Each attempt starts from a clean directory so a blocked run leaves nothing behind.
      await clearWorkDir(options.outputTemplate);

      return run(YTDLP_PATH, sectionArgs(options, forceKeyframes), {
        timeoutMs: options.timeoutMs ?? 20 * 60_000,
        onStdoutLine: (line) => {
          const match = PROGRESS_PATTERN.exec(line.replace(/%/g, '').trim());
          if (match && options.onProgress) {
            options.onProgress(Math.min(100, Number.parseFloat(match[1] as string)));
          }
        },
      });
    });
  } finally {
    stopTracking();
  }
}

/**
 * Downloads just the requested section at the requested format.
 *
 * `--download-sections` always routes the fetch through ffmpeg, because seeking into a
 * remote stream is ffmpeg's job — so ffmpeg runs on the network stream here regardless of
 * `--force-keyframes-at-cuts`. `--force-keyframes-at-cuts` additionally re-encodes around
 * the cut points for an exact start.
 *
 * If that ffmpeg dies on a signal (`code -11`), we first retry without the re-encode, and
 * if it still crashes we give up on this route entirely by throwing
 * `SectionDownloadUnavailable` — the caller then fetches the whole format with yt-dlp's
 * own HTTP downloader and trims it locally, which never hands ffmpeg a URL.
 */
export async function downloadSection(options: DownloadSectionOptions): Promise<void> {
  if (env.ytdlp.forceKeyframes) {
    try {
      await attemptSection(options, true);
      return;
    } catch (error) {
      if (!isFfmpegCrash(error)) {
        logger.error('yt-dlp download failed', error);
        throw upstreamFailure(describeFailure(error));
      }

      logger.warn(
        'ffmpeg crashed during the keyframe-forced cut — retrying with a keyframe-aligned cut.',
      );
    }
  }

  try {
    await attemptSection(options, false);
  } catch (error) {
    if (isFfmpegCrash(error)) {
      logger.warn(
        'ffmpeg crashed fetching the section — falling back to a full-format download.',
      );
      throw new SectionDownloadUnavailable(error);
    }

    logger.error('yt-dlp download failed', error);
    throw upstreamFailure(describeFailure(error));
  }
}

export interface DownloadFormatOptions {
  url: string;
  formatSelector: string;
  outputTemplate: string;
  mergeContainer?: 'mp4' | null;
  onProgress?: (percent: number) => void;
  expectedBytes?: number | null;
  timeoutMs?: number;
}

/**
 * Downloads a complete format with yt-dlp's native HTTP downloader — no
 * `--download-sections`, so ffmpeg is only involved in merging local files. Slower than a
 * section download because the whole video comes down, but it is the route that works
 * when ffmpeg cannot read the remote stream. The caller trims the result.
 */
export async function downloadFullFormat(options: DownloadFormatOptions): Promise<void> {
  // Rebuilt per attempt so a rotated proxy is picked up on retry.
  const buildArgs = (): string[] => {
    const args = [
      ...baseArgs(),
      '--ffmpeg-location',
      ffmpegLocation(),
      '-f',
      options.formatSelector,
      '--no-part',
      '--no-mtime',
      '--force-overwrites',
      '--newline',
      '--progress-template',
      'progress:%(progress._percent_str)s',
      '-o',
      options.outputTemplate,
    ];

    if (options.mergeContainer) {
      args.push('--merge-output-format', options.mergeContainer);
    }

    args.push(options.url);
    return args;
  };

  // The native downloader does report percentages, but disk sampling also covers the
  // merge step, so both feed the same progress callback.
  const stopTracking = trackDiskProgress(options);

  try {
    await withUnblockRetries(async () => {
      await clearWorkDir(options.outputTemplate);

      return run(YTDLP_PATH, buildArgs(), {
        timeoutMs: options.timeoutMs ?? 25 * 60_000,
        onStdoutLine: (line) => {
          const match = PROGRESS_PATTERN.exec(line.replace(/%/g, '').trim());
          if (match && options.onProgress) {
            options.onProgress(Math.min(100, Number.parseFloat(match[1] as string)));
          }
        },
      });
    });
  } catch (error) {
    logger.error('yt-dlp full-format download failed', error);
    throw upstreamFailure(describeFailure(error));
  } finally {
    stopTracking();
  }
}
