import { ClipError, toClipError } from '../youtube/errors'
import type { DirectStream, ProgressSink } from '../youtube/types'

/**
 * Fetches media bytes from `googlevideo` **in the browser**, over the user's own network.
 *
 * Whether this works at all is decided by one thing: does `googlevideo` return an
 * `Access-Control-Allow-Origin` header for our origin? We could not determine that from a
 * corporate network that blocks YouTube's InnerTube API, and it is not documented, so this
 * module probes it at runtime with a 2-byte Range request before committing the user to
 * anything. `probeDirectAccess` returning false is an expected outcome, not a bug — the
 * caller falls through to the next strategy and telemetry records which way it went.
 *
 * When it does work it is the best path available: byte-exact, no re-encode, at full
 * network speed, and our backend never carries the media.
 */

/** Never pull more than this into memory in one go; mobile Safari will kill the tab. */
const MAX_FETCH_BYTES = 320 * 1024 * 1024
/** Padding around the estimated byte window, to absorb bitrate variation. */
const RANGE_PADDING_FRACTION = 0.06
/** A whole file below this is cheaper to fetch outright than to reason about. */
const WHOLE_FILE_THRESHOLD_BYTES = 24 * 1024 * 1024
const PROBE_TIMEOUT_MS = 6_000

export interface DirectAccessProbe {
  allowed: boolean
  /** Whether the server honoured a Range request, needed for partial fetches. */
  supportsRanges: boolean
  /** Why it was refused, for telemetry only. */
  reason: string | null
}

/**
 * A single cheap request that answers "may this page read these bytes?". Uses Range so the
 * probe costs two bytes rather than a whole video, and `mode: 'cors'` so a refusal fails
 * fast instead of handing back an unreadable opaque response.
 */
export async function probeDirectAccess(
  stream: DirectStream,
  signal?: AbortSignal,
): Promise<DirectAccessProbe> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), PROBE_TIMEOUT_MS)
  const onOuterAbort = () => timeout.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    const response = await fetch(stream.url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      headers: { Range: 'bytes=0-1' },
      signal: timeout.signal,
    })

    // Cancel immediately; we only needed the headers.
    response.body?.cancel().catch(() => undefined)

    if (!response.ok && response.status !== 206) {
      return { allowed: false, supportsRanges: false, reason: `http ${response.status}` }
    }

    return {
      allowed: true,
      supportsRanges: response.status === 206,
      reason: null,
    }
  } catch (error) {
    // A CORS refusal is indistinguishable from a network error at this layer by design —
    // the browser deliberately withholds the detail. Either way, this path is unusable.
    const reason = timeout.signal.aborted
      ? 'probe timed out'
      : error instanceof Error
        ? error.message
        : 'blocked'
    return { allowed: false, supportsRanges: false, reason }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

export interface DirectFetchOptions {
  stream: DirectStream
  /** Clip bounds, used to estimate which bytes are worth fetching. */
  startSeconds: number
  endSeconds: number
  durationSeconds: number
  supportsRanges: boolean
  onProgress: ProgressSink
  signal: AbortSignal
}

export interface DirectFetchResult {
  blob: Blob
  /**
   * Seconds of material before the requested start that ended up in `blob`, so the caller
   * knows what to trim. Equals `startSeconds` when the whole file was fetched.
   */
  leadInSeconds: number
}

/**
 * Works out which byte window covers the requested range.
 *
 * This is a proportional estimate, not an index lookup: reading the real time-to-byte map
 * would mean parsing the container's index box, and YouTube's own `indexRange` is only
 * present for adaptive formats. The estimate is padded generously and ffmpeg then seeks
 * precisely inside whatever we fetched, so an imprecise window costs a little bandwidth
 * rather than correctness.
 */
function planByteWindow(options: DirectFetchOptions): { start: number; end: number; leadIn: number } | null {
  const total = options.stream.contentLength
  if (!total || !options.supportsRanges || options.durationSeconds <= 0) return null
  if (total <= WHOLE_FILE_THRESHOLD_BYTES) return null

  const pad = options.durationSeconds * RANGE_PADDING_FRACTION
  const from = Math.max(0, options.startSeconds - pad)
  const to = Math.min(options.durationSeconds, options.endSeconds + pad)

  const byteStart = Math.floor((from / options.durationSeconds) * total)
  const byteEnd = Math.min(total - 1, Math.ceil((to / options.durationSeconds) * total))

  if (byteEnd <= byteStart) return null

  return { start: byteStart, end: byteEnd, leadIn: options.startSeconds - from }
}

/**
 * Streams the required bytes into a Blob, reporting progress as it goes.
 *
 * Chunks are collected into an array and assembled once at the end rather than repeatedly
 * concatenating buffers, which would double peak memory.
 */
export async function fetchClipBytes(options: DirectFetchOptions): Promise<DirectFetchResult> {
  const window = planByteWindow(options)
  const headers: Record<string, string> = {}

  if (window) {
    headers.Range = `bytes=${window.start}-${window.end}`
  }

  const expectedBytes = window
    ? window.end - window.start + 1
    : options.stream.contentLength ?? null

  if (expectedBytes !== null && expectedBytes > MAX_FETCH_BYTES) {
    throw new ClipError(
      'CLIENT_PROCESSING_FAILED',
      `refusing to buffer ${expectedBytes} bytes in the browser`,
    )
  }

  try {
    const response = await fetch(options.stream.url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      headers,
      signal: options.signal,
    })

    if (!response.ok && response.status !== 206) {
      throw new ClipError('MEDIA_UNAVAILABLE', `http ${response.status}`)
    }
    if (!response.body) {
      throw new ClipError('MEDIA_UNAVAILABLE', 'response had no readable body')
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue

        chunks.push(value)
        received += value.byteLength

        if (received > MAX_FETCH_BYTES) {
          throw new ClipError('CLIENT_PROCESSING_FAILED', 'stream exceeded the memory budget')
        }

        options.onProgress({
          percent: expectedBytes ? Math.min(99, Math.round((received / expectedBytes) * 100)) : null,
          message: 'Downloading the section…',
        })
      }
    } finally {
      reader.releaseLock()
    }

    if (received === 0) throw new ClipError('MEDIA_UNAVAILABLE', 'empty response body')

    return {
      blob: new Blob(chunks as BlobPart[], { type: options.stream.mimeType }),
      leadInSeconds: window ? Math.max(0, window.leadIn) : options.startSeconds,
    }
  } catch (error) {
    if (options.signal.aborted) throw new ClipError('CANCELLED', 'aborted during download')
    throw toClipError(error, 'MEDIA_UNAVAILABLE')
  }
}
