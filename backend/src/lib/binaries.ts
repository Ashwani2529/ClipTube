import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { PROJECT_ROOT } from '../config/env';

/**
 * Every binary ships with an npm dependency, so all three paths are known at import
 * time: no PATH lookup, no env override, and nothing is executed to check them.
 */

/** `ffmpeg-static`'s default export is the absolute path to the binary it installed. */
export const FFMPEG_PATH = ffmpegStatic as string;

/** `ffprobe-static` exposes `{ path, version }`. */
export const FFPROBE_PATH: string = ffprobeStatic.path;

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
