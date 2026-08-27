import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ProcessError, run } from '../lib/exec';
import { ytdlpPath, ffmpegLocation } from '../lib/binaries';
import { upstreamFailure } from '../lib/errors';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { activeProxy, rotateProxy } from './proxy.service';

/** The subset of yt-dlp's `-J` output this app relies on. */
export interface RawFormat {
  format_id?: string;
  /**
   * Direct media URL. Handed to the browser by /api/resolve so the client can fetch the
   * bytes over its own connection instead of through our egress.
   */
  url?: string | null;
  /** Present on adaptive formats; lets a client map a time range onto a byte range. */
  init_range?: { start?: number; end?: number } | null;
  index_range?: { start?: number; end?: number } | null;
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
    // Explicit override: passed verbatim, so it must carry everything the user wants.
    args.push('--extractor-args', env.ytdlp.extractorArgs);
  } else {
    // Composed into one `youtube:` value — a second --extractor-args for the same
    // extractor would override the first rather than merge with it.
    const parts: string[] = [];

    const client = env.ytdlp.playerClients[currentClientIndex()];
    // `default` means "let yt-dlp choose", so it contributes nothing.
    if (client && client !== 'default') parts.push(`player_client=${client}`);

    if (env.ytdlp.poToken) parts.push(`po_token=${env.ytdlp.poToken}`);

    if (parts.length > 0) args.push('--extractor-args', `youtube:${parts.join(';')}`);
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

/**
 * True when this player client answered but gave us nothing to download. Some clients
 * return metadata with the stream URLs withheld, so format selection finds no candidates
 * — even on a plain `-J`, which still applies the default selector. That is a dead end for
 * the client, not for the video, so it's worth retrying on a different one.
 */
function isFormatUnavailable(error: unknown): boolean {
  if (!(error instanceof ProcessError)) return false;
  const stderr = error.stderr.toLowerCase();
  return (
    stderr.includes('requested format is not available') ||
    stderr.includes('no video formats found') ||
    stderr.includes('unable to extract player response')
  );
}

/**
 * Where the *next* operation starts its search. Sticky so a client that works keeps being
 * used, but it is only ever advanced by a successful call — never mid-retry, or concurrent
 * requests would move each other's position.
 */
let stickyClientIndex = 0;

/**
 * Per-operation client position. Two requests rotating at the same time each need their
 * own cursor; a shared one makes them skip clients and trample each other's retries.
 */
const clientScope = new AsyncLocalStorage<{ index: number }>();

/** The client this call should use: the operation's own cursor, else the sticky one. */
function currentClientIndex(): number {
  return clientScope.getStore()?.index ?? stickyClientIndex;
}

function advancePlayerClient(store: { index: number }, reason: string): void {
  const clients = env.ytdlp.playerClients;
  if (clients.length === 0) return;

  store.index = (store.index + 1) % clients.length;
  logger.warn(`${reason} — retrying with player_client=${clients[store.index]}.`);
}

/**
 * Retries while YouTube keeps refusing us, escalating through the two levers we have:
 * first every player client in turn (cheap, no new network path), then a different proxy
 * (the loop yt-dlp-proxy runs). Anything else propagates immediately.
 *
 * Each client is tried at most once per operation, so a video that genuinely has no
 * usable formats fails after one pass instead of looping.
 */
async function withUnblockRetries<T>(operation: () => Promise<T>): Promise<T> {
  // An explicit --extractor-args override means the operator is in charge; don't fight it.
  const clientBudget = env.ytdlp.extractorArgs
    ? 1
    : Math.max(1, env.ytdlp.playerClients.length);

  const store = { index: stickyClientIndex };
  const deadline = Date.now() + env.ytdlp.unblockDeadlineMs;

  return clientScope.run(store, async () => {
    let clientsTried = 1;

    for (;;) {
      try {
        const result = await operation();
        // Remember what worked so the next request starts there instead of re-probing.
        stickyClientIndex = store.index;
        return result;
      } catch (error) {
        const blocked = isBlockedByYoutube(error);
        const emptyClient = isFormatUnavailable(error);
        if (!blocked && !emptyClient) throw error;

        // Each client can cost 20s+; without a ceiling the HTTP caller times out first
        // and the work is wasted anyway.
        if (Date.now() > deadline) {
          logger.warn(
            `Giving up unblock retries after ${env.ytdlp.unblockDeadlineMs}ms — ` +
              `tried ${clientsTried} player client(s).`,
          );
          throw error;
        }

        if (clientsTried < clientBudget) {
          clientsTried += 1;
          advancePlayerClient(
            store,
            blocked ? 'YouTube blocked the request' : 'That client returned no usable formats',
          );
          continue;
        }

        // Out of clients: a new exit IP is the only thing left worth trying.
        if (blocked && rotateProxy()) {
          clientsTried = 1;
          continue;
        }

        throw error;
      }
    }
  });
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
    // Naming what is already configured keeps this from suggesting a fix that's in place.
    const haveCookies = Boolean(cookieFile);
    const haveProxy = Boolean(env.ytdlp.proxy) || env.ytdlp.autoProxy;

    if (haveCookies && !haveProxy) {
      return (
        'YouTube blocked this request as automated even with cookies. Datacenter IPs are ' +
        'blocked far more aggressively than home connections, and replaying a session ' +
        'from a different network makes it worse rather than better. Route yt-dlp through ' +
        'a residential proxy (YTDLP_PROXY), supply a PO token (YTDLP_PO_TOKEN), or run ' +
        'the server from a residential connection.'
      );
    }

    return (
      'YouTube blocked this request as automated. This is normal on cloud/server IPs — ' +
      `${haveCookies ? '' : 'set YTDLP_COOKIES_FILE, '}` +
      'use a residential proxy (YTDLP_PROXY) or a PO token (YTDLP_PO_TOKEN).'
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
      run(ytdlpPath(), [...baseArgs(), '--no-progress', '-J', url], { timeoutMs: 90_000 }),
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
  logger.info(
    `section download attempt: forceKeyframes=${forceKeyframes}, ` +
      `ffmpeg-location=${ffmpegLocation()}, expectedBytes=${options.expectedBytes ?? 'unknown'}`,
  );

  const stopTracking = trackDiskProgress(options);

  try {
    await withUnblockRetries(async () => {
      // Each attempt starts from a clean directory so a blocked run leaves nothing behind.
      await clearWorkDir(options.outputTemplate);

      return run(ytdlpPath(), sectionArgs(options, forceKeyframes), {
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

      return run(ytdlpPath(), buildArgs(), {
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
