import { badRequest } from './errors';

const CLOCK_PATTERN = /^(?:(\d+):)?([0-5]?\d):([0-5]?\d)(?:\.(\d{1,3}))?$/;

/**
 * Accepts either a number of seconds or an `hh:mm:ss(.mmm)` / `mm:ss` string and
 * returns seconds. Throws a 400 for anything else.
 */
export function parseTimeInput(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw badRequest(`\`${field}\` must be a non-negative number of seconds.`);
    }
    return value;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`\`${field}\` is required (seconds or hh:mm:ss).`);
  }

  const raw = value.trim();

  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Number.parseFloat(raw);
  }

  const match = CLOCK_PATTERN.exec(raw);
  if (!match) {
    throw badRequest(`\`${field}\` must be seconds or hh:mm:ss.`);
  }

  const hours = Number.parseInt(match[1] ?? '0', 10);
  const minutes = Number.parseInt(match[2] as string, 10);
  const seconds = Number.parseInt(match[3] as string, 10);
  const millis = match[4] ? Number.parseInt(match[4].padEnd(3, '0'), 10) : 0;

  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** Formats seconds as `hh:mm:ss.mmm`, the shape yt-dlp and ffmpeg both accept. */
export function toClockString(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);

  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}
