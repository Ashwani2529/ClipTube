import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/** Backend project root (one level above `src`, or above `dist` once compiled). */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function int(key: string, fallback: number): number {
  const parsed = Number.parseInt(str(key, ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = str(key, '').toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

const tempDirSetting = str('TEMP_DIR', 'temp');

export const env = {
  port: int('PORT', 4000),
  mongoUri: str('MONGO_URI', 'mongodb://127.0.0.1:27017/cliptube'),

  /** Absolute path to the folder that holds in-flight clips. */
  tempDir: path.isAbsolute(tempDirSetting)
    ? tempDirSetting
    : path.join(PROJECT_ROOT, tempDirSetting),

  tempFileTtlMinutes: int('TEMP_FILE_TTL_MINUTES', 60),
  cleanupCron: str('CLEANUP_CRON', '0 * * * *'),
  maxClipSeconds: int('MAX_CLIP_SECONDS', 1800),

  corsOrigins: str('CORS_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /**
   * Escape hatches for YouTube's bot checks, which reject datacenter IPs far more often
   * than home connections. All optional — blank means "don't pass the flag".
   */
  ytdlp: {
    /** Netscape cookie file, passed as `--cookies`. The reliable fix for bot checks. */
    cookiesFile: str('YTDLP_COOKIES_FILE', ''),
    /** Proxy URL, passed as `--proxy`. A residential proxy also clears bot checks. */
    proxy: str('YTDLP_PROXY', ''),
    /** Raw value for `--extractor-args`, e.g. `youtube:player_client=tv,web_safari`. */
    extractorArgs: str('YTDLP_EXTRACTOR_ARGS', ''),

    /**
     * Cut exactly at the requested timestamps by re-encoding the section
     * (`--force-keyframes-at-cuts`). Accurate but slow and memory-hungry; turn it off on
     * small instances to get fast keyframe-aligned cuts instead.
     */
    forceKeyframes: bool('YTDLP_FORCE_KEYFRAMES', true),
  },
} as const;
