import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PROJECT_ROOT } from '../config/env';
import { logger } from './logger';

/**
 * Every binary ships with an npm dependency, so all three paths are known at import
 * time: no PATH lookup, no env override, and nothing is executed to verify them.
 *
 * The two ffmpeg packages are loaded with `require` rather than an `import` because their
 * published typings differ between versions — some export the path string directly,
 * others an object with a `path` field. Reading whichever is present keeps this working
 * across versions instead of pinning to one shape.
 */
function resolveBinaryExport(moduleId: string): string {
  const loaded = require(moduleId) as unknown;

  const candidate =
    typeof loaded === 'string'
      ? loaded
      : ((loaded as { path?: unknown; default?: unknown })?.path ??
        (loaded as { default?: unknown })?.default);

  if (typeof candidate !== 'string' || candidate === '') {
    throw new Error(`"${moduleId}" did not provide a binary path.`);
  }

  return candidate;
}

/**
 * Resolution is deferred to first use rather than done at import.
 *
 * These binaries belong to the *server fallback* only. Resolving them at module load made
 * the whole process refuse to boot when they were absent — including the telemetry, stats
 * and resolve endpoints that need no binaries at all — which would have made the
 * browser-first path depend on the very tooling it is meant to avoid. Nothing is executed
 * to check them; this is still a plain module resolution, just a late one.
 */
function memoize(resolve: () => string): () => string {
  let value: string | null = null;
  return () => {
    if (value === null) value = resolve();
    return value;
  };
}

/** Absolute path to the ffmpeg binary installed by `ffmpeg-static`. */
export const ffmpegPath = memoize(() => resolveBinaryExport('ffmpeg-static'));

/** Absolute path to the ffprobe binary installed by `ffprobe-static`. */
export const ffprobePath = memoize(() => resolveBinaryExport('ffprobe-static'));

/** `youtube-dl-exec` installs yt-dlp into its own package folder. */
export const ytdlpPath = memoize(() =>
  path.join(
    PROJECT_ROOT,
    'node_modules',
    'youtube-dl-exec',
    'bin',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
  ),
);

let toolingAvailable: boolean | null = null;

/**
 * Whether the server-side fallback can run at all. Used to skip the yt-dlp strategy rather
 * than fail a request with it, so a browser-only deployment is a supported configuration.
 */
export function isServerToolingAvailable(): boolean {
  if (toolingAvailable !== null) return toolingAvailable;

  try {
    ffmpegPath();
    ffprobePath();
    ytdlpPath();
    toolingAvailable = true;
  } catch (error) {
    logger.warn(
      'Server-side extraction is disabled: its binaries are not installed. ' +
        'The browser-first path is unaffected.',
      error,
    );
    toolingAvailable = false;
  }

  return toolingAvailable;
}

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

let ffmpegDirectory: string | null = null;

/**
 * yt-dlp's `--ffmpeg-location` wants either a binary or a directory, and when given a
 * binary it looks for ffprobe *next to it*. ffmpeg-static and ffprobe-static install into
 * separate packages, so neither tool can see the other — yt-dlp ends up with no ffprobe
 * at all.
 *
 * Staging both into one directory (link if possible, copy if not) gives yt-dlp the layout
 * it expects, which is the same thing ytDownloader does by shipping a single ffmpeg/bin
 * folder. Falls back to the raw ffmpeg path if staging fails.
 */
export async function stageFfmpegDirectory(): Promise<string> {
  if (ffmpegDirectory) return ffmpegDirectory;

  const directory = path.join(os.tmpdir(), 'cliptube-ffmpeg');

  try {
    await fs.mkdir(directory, { recursive: true });

    await Promise.all(
      [
        { source: ffmpegPath(), name: `ffmpeg${EXE_SUFFIX}` },
        { source: ffprobePath(), name: `ffprobe${EXE_SUFFIX}` },
      ].map(async ({ source, name }) => {
        const target = path.join(directory, name);

        // Nothing to do if a previous boot already staged this binary.
        const existing = await fs.stat(target).catch(() => null);
        const wanted = await fs.stat(source);
        if (existing && existing.size === wanted.size) return;

        await fs.rm(target, { force: true });
        try {
          await fs.symlink(source, target);
        } catch {
          // Windows without developer mode, or a filesystem that has no symlinks.
          await fs.copyFile(source, target);
        }
        await fs.chmod(target, 0o755).catch(() => undefined);
      }),
    );

    ffmpegDirectory = directory;
    logger.info(`ffmpeg + ffprobe staged for yt-dlp in ${directory}`);
  } catch (error) {
    ffmpegDirectory = path.dirname(ffmpegPath());
    logger.warn(
      `Could not stage ffmpeg and ffprobe together; yt-dlp will only see ffmpeg.`,
      error,
    );
  }

  return ffmpegDirectory;
}

/** The staged directory, or the ffmpeg binary itself before staging has run. */
export function ffmpegLocation(): string {
  return ffmpegDirectory ?? ffmpegPath();
}

/** Resolved lazily so a missing binary cannot prevent startup. */
export function binaryPaths(): Readonly<Record<'yt-dlp' | 'ffmpeg' | 'ffprobe', string>> {
  return { 'yt-dlp': ytdlpPath(), ffmpeg: ffmpegPath(), ffprobe: ffprobePath() };
}
