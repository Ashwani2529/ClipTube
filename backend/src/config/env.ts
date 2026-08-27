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
    /**
     * Raw value for `--extractor-args`. Setting this takes full control: it replaces the
     * composed value entirely, so player-client rotation and the PO token are both
     * skipped. Leave it blank unless you need an override the other settings can't express.
     */
    extractorArgs: str('YTDLP_EXTRACTOR_ARGS', ''),

    /**
     * Proof-of-origin token, sent as `po_token=<value>` alongside the player client.
     * Datacenter IPs are the case PO tokens exist for — YouTube will serve a request that
     * carries a valid one where it would otherwise demand sign-in. Format is
     * `<client>.<context>+<token>`, e.g. `web.gvs+AbC…`. Tokens expire, so this is best
     * pointed at something that refreshes them rather than pasted once by hand.
     */
    poToken: str('YTDLP_PO_TOKEN', ''),

    /**
     * Ceiling on how long the bot-check retry ladder may keep escalating. Each player
     * client can cost 20s+, so an unbounded ladder outlives the HTTP client's timeout and
     * the work is thrown away. Checked before each retry, so it never truncates a
     * download that is already succeeding.
     */
    unblockDeadlineMs: int('YTDLP_UNBLOCK_DEADLINE_MS', 45_000),

    /**
     * YouTube player clients to try, in order. Each is passed as
     * `--extractor-args youtube:player_client=<name>`, and a bot-checked request advances
     * to the next one. `default` is yt-dlp's own tuned set and is deliberately first —
     * which client survives the bot check changes with every YouTube and yt-dlp release,
     * so this is a list rather than a single hard-coded value.
     */
    playerClients: str('YTDLP_PLAYER_CLIENTS', 'default,mweb,web_safari,tv_simply,android_vr')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),

    /**
     * Harvest free public proxies, validate them against YouTube, and rotate through
     * them whenever a request is blocked as automated. Ignored when YTDLP_PROXY is set.
     */
    autoProxy: bool('YTDLP_AUTO_PROXY', false),

    /**
     * Proxy sources, tried in this order. The first two hand out credentialed proxies
     * (the username/password is minted per fetch); the last is a large list of
     * credential-free public proxies used only if the others come up empty.
     */
    proxyOnworksUrl: str('YTDLP_PROXY_ONWORKS_URL', 'https://www.onworks.net/vpn.json?v=07'),
    proxySandvpnUrl: str('YTDLP_PROXY_SANDVPN_URL', 'https://api.sandvpn.com/fetch-free-proxys'),
    proxyListUrl: str(
      'YTDLP_PROXY_LIST_URL',
      'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.json',
    ),

    /** Video used to prove a proxy can actually reach YouTube unblocked. */
    proxyTestUrl: str('YTDLP_PROXY_TEST_URL', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'),

    /** How many validated proxies to keep in the rotation. */
    proxyPoolSize: int('YTDLP_PROXY_POOL_SIZE', 5),

    /**
     * Random delay between requests (`--sleep-interval` / `--max-sleep-interval`), which
     * makes traffic look less automated. 0 disables it; only worth setting if you are
     * actually being rate-limited, since it slows every download.
     */
    sleepInterval: int('YTDLP_SLEEP_INTERVAL', 0),
    maxSleepInterval: int('YTDLP_MAX_SLEEP_INTERVAL', 0),

    /** Proxies in these countries are skipped (heavy filtering or poor routing). */
    proxyBlockedCountries: str('YTDLP_PROXY_BLOCKED_COUNTRIES', 'CN,KP,IR,TM,ER,SY,RU')
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean),

    /**
     * Cut exactly at the requested timestamps by re-encoding the section
     * (`--force-keyframes-at-cuts`). Off by default: it is slow, memory-hungry, and the
     * extra re-encode is a common source of ffmpeg crashes. Established yt-dlp front-ends
     * such as ytDownloader don't use it either.
     */
    forceKeyframes: bool('YTDLP_FORCE_KEYFRAMES', false),
  },
} as const;
