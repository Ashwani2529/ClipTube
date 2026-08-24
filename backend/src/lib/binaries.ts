import path from 'path';
import { PROJECT_ROOT } from '../config/env';

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

export const BINARY_PATHS: Readonly<Record<'yt-dlp' | 'ffmpeg' | 'ffprobe', string>> = {
  'yt-dlp': YTDLP_PATH,
  ffmpeg: FFMPEG_PATH,
  ffprobe: FFPROBE_PATH,
};
