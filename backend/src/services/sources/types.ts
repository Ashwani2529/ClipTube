import type { AudioFormatGroup, VideoFormatOption, VideoMeta } from '../../types/api';

/**
 * A stream the *browser* may fetch for itself. Handing these out is how the media path
 * stays off our egress even when resolution had to happen server-side.
 */
export interface DirectStream {
  formatId: string;
  url: string;
  mimeType: string;
  contentLength: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  ext: string;
}

export interface ResolvedVideo {
  meta: VideoMeta;
  video: VideoFormatOption[];
  audio: AudioFormatGroup[];
  /** Null when no format carried a usable URL. */
  direct: { streams: DirectStream[]; expiresAt: number | null } | null;
}

/**
 * Server-side extraction strategy. Only yt-dlp implements this today; the interface exists
 * so an alternative extractor can be added to the ladder in `sources/index.ts` without any
 * caller changing.
 *
 * The browser-side source is not represented here on purpose — it runs in the frontend, and
 * modelling it server-side would invite exactly the "move yt-dlp and call it client-side"
 * mistake this refactor is meant to avoid.
 */
export interface ServerSource {
  readonly name: string;

  /** Cheap gate so the ladder can skip a strategy that is not configured. */
  isEnabled(): boolean;

  resolve(videoId: string, url: string): Promise<ResolvedVideo>;
}
