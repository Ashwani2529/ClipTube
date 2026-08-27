import { isServerToolingAvailable } from '../../lib/binaries';
import { logger } from '../../lib/logger';
import { buildFormatLists, getVideoInfo, toMeta } from '../formats.service';
import type { RawFormat } from '../ytdlp.service';
import type { DirectStream, ResolvedVideo, ServerSource } from './types';

/**
 * The existing yt-dlp extractor, now behind the ServerSource interface.
 *
 * This is the fallback path, and the only place proxy configuration applies. The browser
 * path never reaches this module, so the primary architecture has no proxy dependency at
 * all — which is the thing the experiment is trying to establish.
 */

const isPresent = (codec: string | null | undefined): boolean =>
  Boolean(codec) && codec !== 'none';

/**
 * googlevideo signs URLs with an `expire` query parameter (unix seconds). Passing the real
 * deadline to the client means it can decide to re-resolve rather than start a long download
 * that will die halfway through.
 */
function expiryFrom(urls: string[]): number | null {
  let earliest: number | null = null;

  for (const raw of urls) {
    try {
      const expire = new URL(raw).searchParams.get('expire');
      if (!expire) continue;
      const seconds = Number.parseInt(expire, 10);
      if (!Number.isFinite(seconds)) continue;
      const ms = seconds * 1000;
      if (earliest === null || ms < earliest) earliest = ms;
    } catch {
      // Unparseable URL: treat as "unknown expiry" rather than failing the whole resolve.
    }
  }

  return earliest;
}

function mimeFor(format: RawFormat): string {
  const ext = format.ext ?? 'mp4';
  const hasVideo = isPresent(format.vcodec);
  const base = hasVideo ? 'video' : 'audio';

  if (ext === 'mp4' || ext === 'm4a') return `${base}/mp4`;
  if (ext === 'webm') return `${base}/webm`;
  return `${base}/${ext}`;
}

/**
 * Only formats the browser can actually use are offered.
 *
 * `https` protocol is required: a DASH or HLS manifest URL is not something a page can turn
 * into media without a full player implementation, so offering one would set the client up
 * to fail after the user had already committed.
 */
function toDirectStreams(formats: RawFormat[]): DirectStream[] {
  return formats
    .filter((format) => {
      if (!format.format_id || !format.url) return false;
      if (format.protocol !== 'https') return false;
      return isPresent(format.vcodec) || isPresent(format.acodec);
    })
    .map((format) => ({
      formatId: format.format_id as string,
      url: format.url as string,
      mimeType: mimeFor(format),
      contentLength: format.filesize ?? format.filesize_approx ?? null,
      hasAudio: isPresent(format.acodec),
      hasVideo: isPresent(format.vcodec),
      ext: format.ext ?? 'mp4',
    }));
}

export class YtDlpSource implements ServerSource {
  readonly name = 'yt-dlp';

  /**
   * Disabled outright when the binaries are absent, so a browser-only deployment is a
   * supported configuration rather than a server that boots and then fails every request.
   */
  isEnabled(): boolean {
    return isServerToolingAvailable();
  }

  async resolve(videoId: string, url: string): Promise<ResolvedVideo> {
    const info = await getVideoInfo(videoId, url);
    const formats = info.formats ?? [];
    const streams = toDirectStreams(formats);

    logger.info(
      `[resolve] ${this.name} returned ${formats.length} formats, ` +
        `${streams.length} directly fetchable by the client`,
    );

    return {
      meta: toMeta(info, videoId, url),
      ...buildFormatLists(formats),
      direct:
        streams.length > 0
          ? { streams, expiresAt: expiryFrom(streams.map((stream) => stream.url)) }
          : null,
    };
  }
}
