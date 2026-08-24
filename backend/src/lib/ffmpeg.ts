import Ffmpeg from 'fluent-ffmpeg';
import { FFMPEG_PATH, FFPROBE_PATH } from './binaries';
import { logger } from './logger';

// The npm-provided paths are known at import time, so this is a one-off at module load.
Ffmpeg.setFfmpegPath(FFMPEG_PATH);
Ffmpeg.setFfprobePath(FFPROBE_PATH);

export interface ProbeResult {
  durationSeconds: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  audioCodec: string | null;
  videoCodec: string | null;
}

export async function probe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    Ffmpeg.ffprobe(filePath, (error, data) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const streams = data.streams ?? [];
      const video = streams.find((stream) => stream.codec_type === 'video');
      const audio = streams.find((stream) => stream.codec_type === 'audio');
      const rawDuration = data.format?.duration;
      const duration =
        typeof rawDuration === 'number'
          ? rawDuration
          : Number.parseFloat(String(rawDuration ?? ''));

      resolve({
        durationSeconds: Number.isFinite(duration) ? duration : null,
        hasVideo: Boolean(video),
        hasAudio: Boolean(audio),
        audioCodec: audio?.codec_name ?? null,
        videoCodec: video?.codec_name ?? null,
      });
    });
  });
}

export interface RemuxOptions {
  input: string;
  output: string;
  kind: 'video' | 'audio';
  /** Hard-caps the output length when yt-dlp's cut overshot the requested range. */
  limitSeconds?: number | null;
  onProgress?: (percent: number) => void;
}

/**
 * Copies streams into the final container without re-encoding: fixes the extension to
 * match the codec (webm/opus -> .opus, merged -> .mp4), moves the mp4 index to the
 * front for instant seeking, and trims any overshoot left by the keyframe-aligned cut.
 */
export async function remux(options: RemuxOptions): Promise<void> {
  const outputOptions =
    options.kind === 'video'
      ? ['-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart']
      : ['-vn', '-map', '0:a:0', '-c:a', 'copy'];

  if (options.limitSeconds && options.limitSeconds > 0) {
    outputOptions.push('-t', options.limitSeconds.toFixed(3));
  }

  await new Promise<void>((resolve, reject) => {
    const command = Ffmpeg(options.input)
      .outputOptions(outputOptions)
      .output(options.output);

    command.on('start', (commandLine: string) => {
      logger.info(`ffmpeg ${commandLine}`);
    });

    if (options.onProgress) {
      command.on('progress', (progress) => {
        if (typeof progress.percent === 'number' && Number.isFinite(progress.percent)) {
          options.onProgress?.(Math.max(0, Math.min(100, progress.percent)));
        }
      });
    }

    command.on('error', (error: Error) => {
      reject(new Error(`ffmpeg remux failed: ${error.message}`));
    });
    command.on('end', () => resolve());

    command.run();
  });
}
