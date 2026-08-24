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

/** Absolute path to the ffmpeg binary installed by `ffmpeg-static`. */
export const FFMPEG_PATH: string = resolveBinaryExport('ffmpeg-static');

/** Absolute path to the ffprobe binary installed by `ffprobe-static`. */
export const FFPROBE_PATH: string = resolveBinaryExport('ffprobe-static');

/** `youtube-dl-exec` installs yt-dlp into its own package folder. */
export const YTDLP_PATH: string = path.join(
  PROJECT_ROOT,
  'node_modules',
  'youtube-dl-exec',
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

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
        { source: FFMPEG_PATH, name: `ffmpeg${EXE_SUFFIX}` },
        { source: FFPROBE_PATH, name: `ffprobe${EXE_SUFFIX}` },
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
    ffmpegDirectory = path.dirname(FFMPEG_PATH);
    logger.warn(
      `Could not stage ffmpeg and ffprobe together; yt-dlp will only see ffmpeg.`,
      error,
    );
  }

  return ffmpegDirectory;
}

/** The staged directory, or the ffmpeg binary itself before staging has run. */
export function ffmpegLocation(): string {
  return ffmpegDirectory ?? FFMPEG_PATH;
}

export const BINARY_PATHS: Readonly<Record<'yt-dlp' | 'ffmpeg' | 'ffprobe', string>> = {
  'yt-dlp': YTDLP_PATH,
  ffmpeg: FFMPEG_PATH,
  ffprobe: FFPROBE_PATH,
};
