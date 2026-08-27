/**
 * One error vocabulary shared by every strategy, so the controller can decide whether to
 * fall back without knowing which layer failed.
 */
export const CLIP_ERROR_CODES = [
  'INVALID_URL',
  'BROWSER_UNSUPPORTED',
  'YOUTUBE_SOURCE_UNAVAILABLE',
  'MEDIA_UNAVAILABLE',
  'FORMAT_UNAVAILABLE',
  'CLIENT_RESOLUTION_FAILED',
  'CLIENT_PROCESSING_FAILED',
  'SERVER_FALLBACK_FAILED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'UNKNOWN',
] as const

export type ClipErrorCode = (typeof CLIP_ERROR_CODES)[number]

/**
 * Codes that mean "this strategy cannot do it, but another one might". Anything else is a
 * hard stop — falling back would just fail the same way and waste the user's time.
 */
const RECOVERABLE: ReadonlySet<ClipErrorCode> = new Set<ClipErrorCode>([
  'BROWSER_UNSUPPORTED',
  'YOUTUBE_SOURCE_UNAVAILABLE',
  'MEDIA_UNAVAILABLE',
  'CLIENT_RESOLUTION_FAILED',
  'CLIENT_PROCESSING_FAILED',
  'NETWORK_ERROR',
  'TIMEOUT',
])

/**
 * Wording aimed at the person using ClipTube. Deliberately says nothing about strategies,
 * yt-dlp, proxies or WebAssembly — those are our problems, not theirs.
 */
const USER_MESSAGE: Record<ClipErrorCode, string> = {
  INVALID_URL: 'Paste a YouTube link, for example youtube.com/watch?v=… or youtu.be/…',
  BROWSER_UNSUPPORTED: 'This browser cannot build the clip on its own — finishing it on the server instead.',
  YOUTUBE_SOURCE_UNAVAILABLE: 'YouTube would not hand over this video. It may be private, age-restricted or region-locked.',
  MEDIA_UNAVAILABLE: 'The media for this video could not be read.',
  FORMAT_UNAVAILABLE: 'That quality is no longer available — refresh the list and try again.',
  CLIENT_RESOLUTION_FAILED: 'Could not read this video in your browser.',
  CLIENT_PROCESSING_FAILED: 'Your browser could not finish the clip.',
  SERVER_FALLBACK_FAILED: 'The clip could not be created. Please try again in a moment.',
  NETWORK_ERROR: 'Network problem while building the clip. Check your connection and try again.',
  TIMEOUT: 'This clip is taking too long. Try a shorter range or a lower quality.',
  CANCELLED: 'Cancelled.',
  UNKNOWN: 'Something went wrong while building the clip.',
}

export class ClipError extends Error {
  readonly code: ClipErrorCode

  /** Kept for logging only — never rendered, so stack traces cannot leak into the UI. */
  readonly detail: string | undefined

  constructor(code: ClipErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(detail ?? code, options)
    this.name = 'ClipError'
    this.code = code
    this.detail = detail
  }

  /** True when it is worth handing the request to the next strategy. */
  get recoverable(): boolean {
    return RECOVERABLE.has(this.code)
  }

  get userMessage(): string {
    return USER_MESSAGE[this.code]
  }
}

export function isClipError(value: unknown): value is ClipError {
  return value instanceof ClipError
}

/** Normalises anything thrown anywhere in the pipeline into a ClipError. */
export function toClipError(value: unknown, fallback: ClipErrorCode = 'UNKNOWN'): ClipError {
  if (isClipError(value)) return value

  if (value instanceof DOMException) {
    // getDisplayMedia / MediaRecorder rejections arrive as DOMExceptions.
    if (value.name === 'NotAllowedError' || value.name === 'AbortError') {
      return new ClipError('CANCELLED', value.message, { cause: value })
    }
    if (value.name === 'NotSupportedError' || value.name === 'NotFoundError') {
      return new ClipError('BROWSER_UNSUPPORTED', value.message, { cause: value })
    }
  }

  if (value instanceof TypeError && /fetch|network|load failed/i.test(value.message)) {
    // A cross-origin block surfaces here as an opaque TypeError with no status code.
    return new ClipError('NETWORK_ERROR', value.message, { cause: value })
  }

  const detail = value instanceof Error ? value.message : String(value)
  return new ClipError(fallback, detail, { cause: value })
}

export function userMessageFor(value: unknown, fallback = USER_MESSAGE.UNKNOWN): string {
  return isClipError(value) ? value.userMessage : fallback
}
