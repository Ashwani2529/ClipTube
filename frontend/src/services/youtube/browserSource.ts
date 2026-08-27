import type { AudioFormatGroup, VideoFormatOption, VideoMeta } from '../../types'
import { detectCapabilities, preferredRecorderMime } from '../capabilities'
import { ClipError } from './errors'
import { fetchOembedMeta } from './oembed'
import type { ResolvedSource, YouTubeSource } from './types'

/**
 * The browser-side YouTube source.
 *
 * What this can genuinely do, established by probing the live endpoints rather than
 * assuming:
 *
 *  - Metadata: yes. `youtube.com/oembed` returns `Access-Control-Allow-Origin: <origin>`,
 *    so title/author/thumbnail come straight from YouTube over the user's own network.
 *  - Duration and quality ladder: yes, via the embedded IFrame player, which is also the
 *    user's own connection to YouTube.
 *  - Media URLs: no. `POST /youtubei/v1/player` is the only source of `googlevideo` URLs
 *    and it answers a CORS preflight with 403 and no `Access-Control-Allow-*` headers, so
 *    page JavaScript can never read one. The embedded player is a cross-origin iframe, so
 *    its buffers are unreadable too.
 *
 * The consequence is that this source resolves the video without our backend touching
 * YouTube at all, but always reports `direct: null` — byte-level access has to come from
 * capturing what the player renders, which is the media layer's job.
 */

/** The IFrame player is the only in-browser source of duration and real quality levels. */
export interface PlayerProbe {
  /** Seconds; 0 until the player is ready. */
  getDuration(): number
  /** YouTube quality ids, e.g. `['hd1080', 'hd720', 'medium']`. */
  getAvailableQualityLevels(): string[]
}

/** YouTube's quality ids in ascending order, with the height each one represents. */
const QUALITY_HEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ['tiny', 144],
  ['small', 240],
  ['medium', 360],
  ['large', 480],
  ['hd720', 720],
  ['hd1080', 1080],
  ['hd1440', 1440],
  ['hd2160', 2160],
  ['highres', 4320],
]

const HEIGHT_BY_QUALITY = new Map(QUALITY_HEIGHTS)

function labelFor(height: number): string {
  return height >= 720 ? `${height}p HD` : `${height}p`
}

/**
 * Turns the player's quality ladder into the same option shape the format picker already
 * renders, so the existing UI needs no special case for the browser path.
 *
 * Sizes are deliberately null: the capture path produces bytes as it records, so any
 * figure we printed here would be a guess, and the dialog already handles null.
 */
function videoOptionsFrom(qualityLevels: string[], ext: string): VideoFormatOption[] {
  const heights = qualityLevels
    .map((level) => HEIGHT_BY_QUALITY.get(level))
    .filter((height): height is number => typeof height === 'number')

  const unique = [...new Set(heights)].sort((a, b) => b - a)

  return unique.map((height) => ({
    // Prefixed so a browser-issued id can never be mistaken for a yt-dlp format id if it
    // reaches the server fallback.
    formatId: `browser-${height}`,
    label: labelFor(height),
    height,
    width: null,
    fps: null,
    ext,
    vcodec: ext === 'mp4' ? 'avc1' : 'vp9',
    hasAudio: true,
    filesizeBytes: null,
    note: null,
    hdr: false,
  }))
}

function audioGroupsFrom(mimeType: string | null): AudioFormatGroup[] {
  if (!mimeType) return []

  const isMp4 = mimeType.startsWith('audio/mp4')
  const codec = isMp4 ? 'aac' : 'opus'
  const ext = isMp4 ? 'm4a' : 'webm'

  return [
    {
      codec,
      ext,
      label: codec.toUpperCase(),
      tiers: [
        {
          formatId: `browser-audio-${codec}`,
          bitrateKbps: null,
          label: 'Source quality',
          filesizeBytes: null,
          sampleRate: null,
          note: null,
        },
      ],
    },
  ]
}

export class BrowserYouTubeSource implements YouTubeSource {
  readonly name = 'browser' as const

  private readonly player: PlayerProbe

  constructor(player: PlayerProbe) {
    this.player = player
  }

  /**
   * Cheap and synchronous in practice — there is no point prompting for screen capture or
   * loading a 30 MB WebAssembly core on a browser that cannot finish the job.
   */
  async isAvailable(): Promise<boolean> {
    const caps = detectCapabilities()
    return caps.clientAcquisition && caps.clientProcessing
  }

  async resolveVideo(
    videoId: string,
    webpageUrl: string,
    signal: AbortSignal,
  ): Promise<ResolvedSource> {
    const duration = this.player.getDuration()
    if (!Number.isFinite(duration) || duration <= 0) {
      // The embed never became playable, which usually means YouTube refused it.
      throw new ClipError('YOUTUBE_SOURCE_UNAVAILABLE', 'player reported no duration')
    }

    const oembed = await fetchOembedMeta(webpageUrl, signal)

    const recorderMime = detectCapabilities().recorderMimeType
    const containerExt = recorderMime?.startsWith('video/mp4') ? 'mp4' : 'webm'

    const video = videoOptionsFrom(this.player.getAvailableQualityLevels(), containerExt)
    const audio = audioGroupsFrom(preferredRecorderMime('audio'))

    if (video.length === 0 && audio.length === 0) {
      throw new ClipError('FORMAT_UNAVAILABLE', 'player exposed no quality levels')
    }

    const meta: VideoMeta = {
      videoId,
      title: oembed.title,
      uploader: oembed.uploader,
      durationSeconds: duration,
      thumbnail: oembed.thumbnail,
      webpageUrl,
      isLive: false,
    }

    return {
      videoId,
      webpageUrl,
      meta,
      video,
      audio,
      // Always null, and not a limitation we can engineer around: see the class comment.
      direct: null,
      resolvedBy: 'browser',
    }
  }
}
