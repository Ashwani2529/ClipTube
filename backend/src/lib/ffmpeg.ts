import Ffmpeg from 'fluent-ffmpeg';
import { ffmpegPath, ffprobePath } from './binaries';
import { logger } from './logger';

let configured = false;

/**
 * Points fluent-ffmpeg at the npm-installed binaries on first use rather than at import.
 * Doing it at import would resolve the server fallback's binaries just because this module
 * was loaded, which is what previously stopped the process booting without them.
 */
function configureFfmpeg(): void {
  if (configured) return;
  Ffmpeg.setFfmpegPath(ffmpegPath());
  Ffmpeg.setFfprobePath(ffprobePath());
  configured = true;
}

export interface ProbeResult {
  durationSeconds: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  audioCodec: string | null;
  videoCodec: string | null;
}

export async function probe(filePath: string): Promise<ProbeResult> {
  configureFfmpeg();
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
  /**
   * Seek offset into the input. Set when the input is the whole video rather than an
   * already-cut section, so this pass does the trimming.
   */
  startSeconds?: number | null;
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
  configureFfmpeg();
  const outputOptions =
    options.kind === 'video'
      ? ['-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart']
      : ['-vn', '-map', '0:a:0', '-c:a', 'copy'];

  if (options.limitSeconds && options.limitSeconds > 0) {
    outputOptions.push('-t', options.limitSeconds.toFixed(3));
  }

  // `-nostdin` stops ffmpeg reading the parent's stdin, where an overwrite prompt would
  // otherwise block forever. Seeking before `-i` is the fast path: ffmpeg jumps to the
  // nearest preceding keyframe instead of decoding from the start of the file.
  const inputOptions = ['-nostdin'];
  if (options.startSeconds && options.startSeconds > 0) {
    inputOptions.push('-ss', options.startSeconds.toFixed(3));
  }

  await new Promise<void>((resolve, reject) => {
    const command = Ffmpeg(options.input)
      .inputOptions(inputOptions)
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
