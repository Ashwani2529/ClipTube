import net from 'net';
import { env } from '../config/env';
import { ytdlpPath } from '../lib/binaries';
import { run } from '../lib/exec';
import { logger } from '../lib/logger';

/**
 * Dynamic proxy rotation, modelled on yt-dlp-proxy: harvest a large list of free public
 * proxies, keep only the ones that can actually pull metadata from YouTube, and rotate to
 * the next one whenever a request comes back blocked.
 *
 * Free proxies die constantly, which is why the pool is validated rather than trusted,
 * re-validated on demand, and why every consumer is expected to retry on failure.
 */

interface ProxyEntry {
  /** Ready-to-use `--proxy` value, e.g. `http://user:pass@1.2.3.4:8080`. */
  url: string;
  host: string;
  port: number;
  country: string;
  /** Which provider supplied it, for logging. */
  source: string;
  /** True when the provider issued credentials with it. */
  authenticated: boolean;
}

const SUPPORTED_PROTOCOLS = new Set(['http', 'https', 'socks4', 'socks5']);

/**
 * `protocol://user:pass@host:port`, with the protocol defaulting to http — the same
 * string yt-dlp-proxy builds. Credentials are encoded because provider-issued passwords
 * are arbitrary strings.
 */
function buildProxyUrl(parts: {
  protocol?: string | null;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}): string {
  const protocol = parts.protocol && SUPPORTED_PROTOCOLS.has(parts.protocol)
    ? parts.protocol
    : 'http';

  const auth = parts.username
    ? `${encodeURIComponent(parts.username)}:${encodeURIComponent(parts.password ?? '')}@`
    : '';

  return `${protocol}://${auth}${parts.host}:${parts.port}`;
}

const toPort = (value: unknown): number | null => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
};

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

interface ProxyProvider {
  name: string;
  fetch: () => Promise<ProxyEntry[]>;
}

/**
 * OnWorks publishes a server list together with a `credentials` block that applies to
 * every server in it. Both are re-issued on each fetch, which is what makes this the
 * closest thing to "proxy credentials on demand".
 */
async function fetchOnworks(): Promise<ProxyEntry[]> {
  const payload = (await getJson(env.ytdlp.proxyOnworksUrl, 10_000)) as {
    data?: { servers?: Record<string, {
      proxies?: { proxy?: unknown; country?: unknown }[];
      credentials?: { username?: unknown; password?: unknown };
    }> };
  };

  const servers = payload?.data?.servers ?? {};

  return Object.values(servers).flatMap((server) => {
    const username = typeof server?.credentials?.username === 'string'
      ? server.credentials.username
      : null;
    const password = typeof server?.credentials?.password === 'string'
      ? server.credentials.password
      : null;

    return (server?.proxies ?? []).flatMap((entry): ProxyEntry[] => {
      if (typeof entry?.proxy !== 'string') return [];
      const [host, rawPort] = entry.proxy.split(':');
      const port = toPort(rawPort);
      if (!host || port === null) return [];

      return [{
        url: buildProxyUrl({ host, port, username, password }),
        host,
        port,
        country: String(entry.country ?? '').toUpperCase(),
        source: 'onworks',
        authenticated: Boolean(username),
      }];
    });
  });
}

/** SandVPN returns entries already shaped as host/port/username/password/country. */
async function fetchSandvpn(): Promise<ProxyEntry[]> {
  const payload = (await getJson(env.ytdlp.proxySandvpnUrl, 10_000)) as {
    host?: unknown;
    port?: unknown;
    protocol?: unknown;
    country?: unknown;
    username?: unknown;
    password?: unknown;
  }[];

  if (!Array.isArray(payload)) throw new Error('SandVPN did not return an array.');

  return payload.flatMap((raw): ProxyEntry[] => {
    const host = typeof raw.host === 'string' ? raw.host : null;
    const port = toPort(raw.port);
    if (!host || port === null) return [];

    const username = typeof raw.username === 'string' && raw.username ? raw.username : null;

    return [{
      url: buildProxyUrl({
        protocol: typeof raw.protocol === 'string' ? raw.protocol.toLowerCase() : null,
        host,
        port,
        username,
        password: typeof raw.password === 'string' ? raw.password : null,
      }),
      host,
      port,
      country: String(raw.country ?? '').toUpperCase(),
      source: 'sandvpn',
      authenticated: Boolean(username),
    }];
  });
}

/** Proxifly's public list: no credentials, high volume, low hit rate. */
async function fetchProxifly(): Promise<ProxyEntry[]> {
  const payload = (await getJson(env.ytdlp.proxyListUrl, 20_000)) as {
    ip?: unknown;
    port?: unknown;
    protocol?: unknown;
    geolocation?: { country?: unknown };
  }[];

  if (!Array.isArray(payload)) throw new Error('Proxy list was not an array.');

  return payload.flatMap((raw): ProxyEntry[] => {
    const host = typeof raw.ip === 'string' ? raw.ip : null;
    const port = toPort(raw.port);
    const protocol = typeof raw.protocol === 'string' ? raw.protocol.toLowerCase() : '';
    if (!host || port === null || !SUPPORTED_PROTOCOLS.has(protocol)) return [];

    return [{
      url: buildProxyUrl({ protocol, host, port }),
      host,
      port,
      country: String(raw.geolocation?.country ?? '').toUpperCase(),
      source: 'proxifly',
      authenticated: false,
    }];
  });
}

/** Credentialed providers first — they are far likelier to survive validation. */
const PROVIDERS: ProxyProvider[] = [
  { name: 'onworks', fetch: fetchOnworks },
  { name: 'sandvpn', fetch: fetchSandvpn },
  { name: 'proxifly', fetch: fetchProxifly },
];

/** yt-dlp only needs to answer "can you see this video", so the timeout can be tight. */
const VALIDATE_TIMEOUT_MS = 25_000;
const TCP_TIMEOUT_MS = 3_000;

/** Candidates that pass the cheap TCP check before the expensive yt-dlp check. */
const VALIDATION_SHORTLIST_FACTOR = 6;

const TCP_CONCURRENCY = 40;

/**
 * Validation spawns a real yt-dlp process per candidate. On a small instance (Render's
 * free tier is a fraction of a CPU) more than a couple at once starves the API itself,
 * which shows up as request timeouts while the pool is being built.
 */
const VALIDATE_CONCURRENCY = 2;

/**
 * Ceiling on yt-dlp validation runs per refresh. Kept low deliberately: public lists are
 * dominated by port-80 hosts that answer a TCP connect without being usable proxies at
 * all, so passing the cheap check says very little and grinding through hundreds of them
 * costs minutes for almost no chance of a hit.
 */
const MAX_VALIDATION_ATTEMPTS = 16;

/** Don't rebuild the pool more than once every few minutes. */
const REFRESH_COOLDOWN_MS = 3 * 60_000;

let pool: ProxyEntry[] = [];
let cursor = 0;
let lastRefreshAt = 0;
let inFlight: Promise<void> | null = null;

/** Runs `task` over `items` with a fixed number of workers. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results.push(await task(items[current] as T));
    }
  });

  await Promise.all(workers);
  return results;
}

/** Log-safe description: never includes the credentials embedded in `url`. */
function describe(entry: ProxyEntry): string {
  const auth = entry.authenticated ? ', authenticated' : '';
  return `${entry.host}:${entry.port} (${entry.source}${entry.country ? `, ${entry.country}` : ''}${auth})`;
}

/** Shuffles in place so every instance doesn't hammer the same proxies first. */
function shuffle(entries: ProxyEntry[]): ProxyEntry[] {
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j] as ProxyEntry, entries[i] as ProxyEntry];
  }
  return entries;
}

/**
 * Collects candidates from every provider. Provider order is preserved so credentialed
 * proxies are validated before the public ones, and a provider that is down or has
 * changed its response shape is skipped rather than failing the whole refresh.
 */
async function fetchCandidates(): Promise<ProxyEntry[]> {
  const blocked = new Set(env.ytdlp.proxyBlockedCountries);
  const seen = new Set<string>();
  const candidates: ProxyEntry[] = [];

  for (const provider of PROVIDERS) {
    try {
      const entries = await provider.fetch();
      const usable = entries.filter((entry) => {
        if (entry.country && blocked.has(entry.country)) return false;
        if (seen.has(entry.url)) return false;
        seen.add(entry.url);
        return true;
      });

      candidates.push(...shuffle(usable));
      logger.info(`Proxy provider ${provider.name}: ${usable.length} usable candidates.`);
    } catch (error) {
      logger.warn(`Proxy provider ${provider.name} failed`, error);
    }
  }

  return candidates;
}

/** Cheap liveness filter: most free proxies are simply dead. */
function tcpReachable(entry: ProxyEntry): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(entry.port, entry.host);
  });
}

/**
 * The real test: ask yt-dlp to read the test video's id through the proxy. This proves
 * both that the proxy forwards traffic and that YouTube serves it without a bot check —
 * a generic speed test can't tell us the second thing.
 */
async function servesYoutube(entry: ProxyEntry): Promise<boolean> {
  try {
    await run(
      ytdlpPath(),
      [
        '--no-playlist',
        '--no-warnings',
        '--ignore-config',
        '--no-progress',
        '--socket-timeout',
        '10',
        '--proxy',
        entry.url,
        '--skip-download',
        '--print',
        '%(id)s',
        env.ytdlp.proxyTestUrl,
      ],
      { timeoutMs: VALIDATE_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuilds the validated pool. Concurrent callers share one refresh, and a cooldown stops
 * a burst of failures from triggering a refresh storm.
 */
export async function refreshProxyPool(force = false): Promise<void> {
  if (!env.ytdlp.autoProxy || env.ytdlp.proxy) return;
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastRefreshAt < REFRESH_COOLDOWN_MS) return;

  inFlight = (async () => {
    lastRefreshAt = Date.now();

    try {
      const candidates = await fetchCandidates();
      logger.info(`Proxy pool: ${candidates.length} candidates fetched.`);

      const shortlistTarget = env.ytdlp.proxyPoolSize * VALIDATION_SHORTLIST_FACTOR;
      const reachable: ProxyEntry[] = [];

      // Probe in batches so we can stop as soon as the shortlist is full.
      for (let i = 0; i < candidates.length && reachable.length < shortlistTarget; i += 200) {
        const batch = candidates.slice(i, i + 200);
        const alive = await mapLimit(batch, TCP_CONCURRENCY, async (entry) =>
          (await tcpReachable(entry)) ? entry : null,
        );
        reachable.push(...alive.filter((entry): entry is ProxyEntry => entry !== null));
      }

      logger.info(`Proxy pool: ${reachable.length} reachable, validating against YouTube…`);

      const validated: ProxyEntry[] = [];
      // Bounded so a list of entirely blocked proxies can't spin in the background.
      const attemptLimit = Math.min(reachable.length, MAX_VALIDATION_ATTEMPTS);

      for (let i = 0; i < attemptLimit && validated.length < env.ytdlp.proxyPoolSize; i += VALIDATE_CONCURRENCY) {
        const batch = reachable.slice(i, i + VALIDATE_CONCURRENCY);
        const working = await mapLimit(batch, VALIDATE_CONCURRENCY, async (entry) =>
          (await servesYoutube(entry)) ? entry : null,
        );
        validated.push(...working.filter((entry): entry is ProxyEntry => entry !== null));
      }

      pool = validated.slice(0, env.ytdlp.proxyPoolSize);
      cursor = 0;

      if (pool.length === 0) {
        logger.warn('Proxy pool: no free proxy could reach YouTube. Cookies are more reliable.');
      } else {
        logger.info(`Proxy pool ready: ${pool.map(describe).join(', ')}`);
      }
    } catch (error) {
      logger.warn('Proxy pool refresh failed', error);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** The `--proxy` value to use right now, or null to go direct. */
export function activeProxy(): string | null {
  if (env.ytdlp.proxy) return env.ytdlp.proxy;
  if (!env.ytdlp.autoProxy) return null;
  return pool[cursor]?.url ?? null;
}

/**
 * Called after a blocked request. Advances to the next proxy and reports whether another
 * one is worth trying; triggers a background refresh once the pool is exhausted.
 */
export function rotateProxy(): boolean {
  if (env.ytdlp.proxy || !env.ytdlp.autoProxy) return false;

  const failed = pool[cursor];
  if (failed) {
    logger.warn(`Proxy ${describe(failed)} was blocked — rotating.`);
  }

  cursor += 1;

  if (cursor >= pool.length) {
    pool = [];
    cursor = 0;
    void refreshProxyPool(true);
    return false;
  }

  return true;
}

/** Warms the pool at startup without blocking boot. */
export function startProxyPool(): void {
  if (!env.ytdlp.autoProxy || env.ytdlp.proxy) return;
  logger.info('Auto-proxy enabled — building the initial proxy pool in the background.');
  void refreshProxyPool(true);
}
