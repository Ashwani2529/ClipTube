import { logger } from '../lib/logger';

/**
 * In-memory counters for the browser-first experiment.
 *
 * Deliberately not a database and deliberately not durable: the numbers reset when the
 * process restarts. The point is to answer "what share of clips avoid our backend touching
 * YouTube?" during the experiment, not to build a reporting system. Nothing recorded here
 * identifies a user or a video — no ids, URLs, titles or addresses ever reach this module.
 */

export const OUTCOMES = ['client_only', 'client_media', 'server', 'cancelled', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

const PLATFORMS = ['desktop', 'mobile', 'ios'] as const;
type Platform = (typeof PLATFORMS)[number];

export interface TelemetryInput {
  outcome: Outcome;
  browserResolution: 'success' | 'failure' | 'skipped';
  clientProcessing: 'success' | 'failure' | 'skipped';
  serverFallback: 'used' | 'not-used';
  acquisition: 'capture' | 'direct' | 'server' | null;
  failureCode: string | null;
  durationMs: number;
  clipSeconds: number;
  platform: string;
}

interface Counters {
  total: number;
  byOutcome: Record<Outcome, number>;
  browserResolution: { success: number; failure: number; skipped: number };
  clientProcessing: { success: number; failure: number; skipped: number };
  serverFallbackUsed: number;
  failureCodes: Map<string, number>;
  /** Running totals, so averages need no history. */
  clientDurationMs: { sum: number; count: number };
  serverDurationMs: { sum: number; count: number };
  byPlatform: Map<Platform, { total: number; clientOnly: number; clientMedia: number }>;
}

function emptyCounters(): Counters {
  return {
    total: 0,
    byOutcome: { client_only: 0, client_media: 0, server: 0, cancelled: 0, failed: 0 },
    browserResolution: { success: 0, failure: 0, skipped: 0 },
    clientProcessing: { success: 0, failure: 0, skipped: 0 },
    serverFallbackUsed: 0,
    failureCodes: new Map(),
    clientDurationMs: { sum: 0, count: 0 },
    serverDurationMs: { sum: 0, count: 0 },
    byPlatform: new Map(),
  };
}

let counters = emptyCounters();
const startedAt = new Date();

/** Guards against a malformed or hostile body skewing the numbers. */
function normalisePlatform(raw: string): Platform {
  return (PLATFORMS as readonly string[]).includes(raw) ? (raw as Platform) : 'desktop';
}

export function record(input: TelemetryInput): void {
  counters.total += 1;
  counters.byOutcome[input.outcome] += 1;
  counters.browserResolution[input.browserResolution] += 1;
  counters.clientProcessing[input.clientProcessing] += 1;

  if (input.serverFallback === 'used') counters.serverFallbackUsed += 1;

  if (input.failureCode) {
    counters.failureCodes.set(
      input.failureCode,
      (counters.failureCodes.get(input.failureCode) ?? 0) + 1,
    );
  }

  const bucket =
    input.outcome === 'server' ? counters.serverDurationMs : counters.clientDurationMs;
  if (input.outcome === 'client_only' || input.outcome === 'client_media' || input.outcome === 'server') {
    bucket.sum += input.durationMs;
    bucket.count += 1;
  }

  const platform = normalisePlatform(input.platform);
  const platformStats =
    counters.byPlatform.get(platform) ?? { total: 0, clientOnly: 0, clientMedia: 0 };
  platformStats.total += 1;
  if (input.outcome === 'client_only') platformStats.clientOnly += 1;
  if (input.outcome === 'client_media') platformStats.clientMedia += 1;
  counters.byPlatform.set(platform, platformStats);

  // One line per request makes the experiment readable straight from the deploy logs.
  logger.info(
    `[telemetry] outcome=${input.outcome} resolution=${input.browserResolution} ` +
      `client=${input.clientProcessing} acquisition=${input.acquisition ?? 'none'} ` +
      `fallback=${input.serverFallback} platform=${platform} ` +
      `clip=${input.clipSeconds}s took=${input.durationMs}ms` +
      (input.failureCode ? ` failure=${input.failureCode}` : ''),
  );
}

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;

const mean = (bucket: { sum: number; count: number }): number | null =>
  bucket.count === 0 ? null : Math.round(bucket.sum / bucket.count);

export interface MetricsSnapshot {
  since: string;
  total: number;
  /** The headline number: finished with no backend YouTube request at all. */
  clientOnlySuccessRatePercent: number;
  /** Browser fetched the media; backend supplied metadata only. */
  clientMediaRatePercent: number;
  /** Either of the above — the share where our egress carried no media. */
  mediaOffBackendRatePercent: number;
  serverFallbackRatePercent: number;
  browserResolutionSuccessRatePercent: number;
  clientProcessingSuccessRatePercent: number;
  averageClientMs: number | null;
  averageServerMs: number | null;
  outcomes: Record<Outcome, number>;
  failureReasons: Record<string, number>;
  byPlatform: Record<string, { total: number; clientOnlyRatePercent: number }>;
}

export function snapshot(): MetricsSnapshot {
  const completed =
    counters.byOutcome.client_only + counters.byOutcome.client_media + counters.byOutcome.server;

  // Resolution and processing rates exclude "skipped" so an unsupported browser does not
  // count as a failure of a path it never attempted.
  const resolutionAttempts =
    counters.browserResolution.success + counters.browserResolution.failure;
  const processingAttempts =
    counters.clientProcessing.success + counters.clientProcessing.failure;

  const byPlatform: MetricsSnapshot['byPlatform'] = {};
  for (const [platform, stats] of counters.byPlatform) {
    byPlatform[platform] = {
      total: stats.total,
      clientOnlyRatePercent: rate(stats.clientOnly, stats.total),
    };
  }

  return {
    since: startedAt.toISOString(),
    total: counters.total,
    clientOnlySuccessRatePercent: rate(counters.byOutcome.client_only, completed),
    clientMediaRatePercent: rate(counters.byOutcome.client_media, completed),
    mediaOffBackendRatePercent: rate(
      counters.byOutcome.client_only + counters.byOutcome.client_media,
      completed,
    ),
    serverFallbackRatePercent: rate(counters.byOutcome.server, completed),
    browserResolutionSuccessRatePercent: rate(counters.browserResolution.success, resolutionAttempts),
    clientProcessingSuccessRatePercent: rate(counters.clientProcessing.success, processingAttempts),
    averageClientMs: mean(counters.clientDurationMs),
    averageServerMs: mean(counters.serverDurationMs),
    outcomes: { ...counters.byOutcome },
    failureReasons: Object.fromEntries(counters.failureCodes),
    byPlatform,
  };
}

/** Test seam and a way to start a fresh measurement window without a redeploy. */
export function resetMetrics(): void {
  counters = emptyCounters();
}
