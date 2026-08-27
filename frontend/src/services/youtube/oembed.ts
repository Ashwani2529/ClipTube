import { ClipError, toClipError } from './errors'

/**
 * YouTube's oembed endpoint is the one YouTube API a third-party page may call directly:
 * it answers with `Access-Control-Allow-Origin: <our origin>`, verified against the live
 * endpoint. That makes it the only genuinely browser-to-YouTube metadata path available,
 * so it runs before we consider asking our own backend for anything.
 *
 * It gives title, author and thumbnail. It does NOT give duration — the IFrame player
 * supplies that once the video is embedded.
 */

const OEMBED_ENDPOINT = 'https://www.youtube.com/oembed'
const OEMBED_TIMEOUT_MS = 8_000

export interface OembedMeta {
  title: string
  uploader: string
  thumbnail: string | null
}

interface OembedPayload {
  title?: unknown
  author_name?: unknown
  thumbnail_url?: unknown
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Resolves basic metadata straight from YouTube. Throws a recoverable ClipError so the
 * caller can fall back to the backend rather than blocking the user.
 */
export async function fetchOembedMeta(
  webpageUrl: string,
  signal?: AbortSignal,
): Promise<OembedMeta> {
  const endpoint = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(webpageUrl)}&format=json`

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), OEMBED_TIMEOUT_MS)
  const onOuterAbort = () => timeout.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      // No credentials: this must stay an anonymous cross-origin request, both so the CORS
      // header YouTube returns is usable and so we never attach the user's YouTube session.
      credentials: 'omit',
      signal: timeout.signal,
    })

    if (response.status === 401 || response.status === 403) {
      throw new ClipError('YOUTUBE_SOURCE_UNAVAILABLE', `oembed ${response.status}`)
    }
    if (response.status === 404) {
      throw new ClipError('YOUTUBE_SOURCE_UNAVAILABLE', 'oembed 404 — video not found')
    }
    if (!response.ok) {
      throw new ClipError('CLIENT_RESOLUTION_FAILED', `oembed ${response.status}`)
    }

    const payload = (await response.json()) as OembedPayload

    return {
      title: asString(payload.title) ?? 'YouTube video',
      uploader: asString(payload.author_name) ?? '',
      thumbnail: asString(payload.thumbnail_url),
    }
  } catch (error) {
    if (signal?.aborted) throw new ClipError('CANCELLED', 'aborted by caller')
    if (timeout.signal.aborted) throw new ClipError('TIMEOUT', 'oembed timed out')
    throw toClipError(error, 'CLIENT_RESOLUTION_FAILED')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}
