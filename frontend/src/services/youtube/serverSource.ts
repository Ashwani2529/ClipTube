import { resolveVideoOnServer } from '../../lib/api'
import { ClipError, toClipError } from './errors'
import type { ResolvedSource, YouTubeSource } from './types'

/**
 * Fallback source: the backend runs yt-dlp and tells us what it found.
 *
 * `POST /api/resolve` is deliberately metadata-only — it never streams media. When YouTube
 * hands the backend usable stream URLs, they come back in `direct` so the *browser* can
 * fetch the bytes over the user's own connection. That keeps the media path off our egress
 * even when resolution had to happen server-side, and it is the difference between the
 * `client_media` and `server` outcomes in the telemetry.
 */
export class ServerYouTubeSource implements YouTubeSource {
  readonly name = 'server' as const

  /** Always worth trying: if the backend is unreachable the user has no path at all. */
  async isAvailable(): Promise<boolean> {
    return true
  }

  async resolveVideo(
    videoId: string,
    webpageUrl: string,
    signal: AbortSignal,
  ): Promise<ResolvedSource> {
    try {
      const payload = await resolveVideoOnServer(webpageUrl, signal)

      if (payload.video.length === 0 && payload.audio.length === 0) {
        throw new ClipError('FORMAT_UNAVAILABLE', 'server reported no formats')
      }

      return {
        videoId,
        webpageUrl,
        meta: payload.meta,
        video: payload.video,
        audio: payload.audio,
        direct: payload.direct
          ? { streams: payload.direct.streams, expiresAt: payload.direct.expiresAt }
          : null,
        resolvedBy: 'server',
      }
    } catch (error) {
      if (signal.aborted) throw new ClipError('CANCELLED', 'aborted by caller')
      throw toClipError(error, 'SERVER_FALLBACK_FAILED')
    }
  }
}
