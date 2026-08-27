import { unavailable } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { YtDlpSource } from './ytdlpSource';
import type { ResolvedVideo, ServerSource } from './types';

export type { DirectStream, ResolvedVideo, ServerSource } from './types';

/**
 * Server-side extraction ladder, in preference order. Adding a strategy means implementing
 * ServerSource and putting it in this array.
 */
const SOURCES: ServerSource[] = [new YtDlpSource()];

/**
 * Walks the ladder until one strategy resolves the video.
 *
 * Each strategy is attempted at most once. There is no retry loop here on purpose — the
 * yt-dlp layer already has its own bounded escalation for bot checks, and wrapping a second
 * unbounded loop around it is what previously pushed requests past the client's timeout.
 */
export async function resolveWithServerSources(
  videoId: string,
  url: string,
): Promise<ResolvedVideo> {
  const enabled = SOURCES.filter((source) => source.isEnabled());

  if (enabled.length === 0) {
    // A deliberate configuration, not a crash: this deployment is browser-only. Say so with
    // a 503 rather than letting it surface as an opaque 500.
    throw unavailable('Server-side extraction is not available on this deployment.');
  }

  let lastError: unknown = null;

  for (const source of enabled) {
    try {
      return await source.resolve(videoId, url);
    } catch (error) {
      lastError = error;
      logger.warn(`[resolve] source "${source.name}" failed`, error);
    }
  }

  throw lastError ?? new Error('Every server-side extraction strategy failed.');
}
