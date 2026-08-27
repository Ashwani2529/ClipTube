import { readonly, ref, type Ref } from 'vue'
import { extractVideoId } from '../lib/youtube'
import { BrowserMediaProcessor } from './media/browserProcessor'
import { ServerMediaProcessor } from './media/serverProcessor'
import type { MediaProcessor, PlayerController, ProcessContext } from './media/types'
import { TelemetryRecorder, type ClipTelemetry } from './telemetry'
import { BrowserYouTubeSource, type PlayerProbe } from './youtube/browserSource'
import { ClipError, toClipError, type ClipErrorCode } from './youtube/errors'
import { ServerYouTubeSource } from './youtube/serverSource'
import type { ClipArtifact, ClipRequest, ProgressReport, ResolvedSource, YouTubeSource } from './youtube/types'

/**
 * The explicit processing state machine. Every transition is made here, so no component
 * needs to know that more than one strategy exists.
 *
 * Ordering rule for both ladders: prefer the browser, fall back to the server exactly once,
 * and only when the failure was the kind another strategy could plausibly survive. A
 * `FORMAT_UNAVAILABLE` or a cancelled prompt stops immediately — retrying it would just
 * make the user wait twice for the same answer.
 */

export const CLIP_STATES = [
  'IDLE',
  'URL_VALIDATING',
  'CLIENT_RESOLUTION',
  'CLIENT_RESOLUTION_FAILED',
  'CLIENT_PROCESSING',
  'CLIENT_PROCESSING_FAILED',
  'SERVER_FALLBACK',
  'SERVER_PROCESSING',
  'SERVER_PROCESSING_FAILED',
  'COMPLETED',
  'CANCELLED',
  'ERROR',
] as const

export type ClipState = (typeof CLIP_STATES)[number]

export interface ControllerHooks {
  /** Reads duration and quality levels from the embedded player. */
  probe: PlayerProbe
  /** Drives playback for the capture path. Null until the player is mounted. */
  controller: () => PlayerController | null
}

export interface ClipControllerApi {
  state: Readonly<Ref<ClipState>>
  progress: Readonly<Ref<number | null>>
  message: Readonly<Ref<string>>
  error: Readonly<Ref<string | null>>
  errorCode: Readonly<Ref<ClipErrorCode | null>>
  source: Readonly<Ref<ResolvedSource | null>>
  lastTelemetry: Readonly<Ref<ClipTelemetry | null>>
  /** Set while a server job is running, so the stats counter can refresh. */
  serverJobId: Readonly<Ref<string | null>>

  resolve(urlText: string): Promise<ResolvedSource | null>
  runClip(request: Omit<ClipRequest, 'videoId' | 'webpageUrl'>): Promise<ClipArtifact | null>
  cancel(): void
  reset(): void
}

/** Hands a finished blob to the browser and releases the object URL afterwards. */
function saveBlob(blob: Blob, fileName: string): void {
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  // Revoking synchronously can cancel the download in some browsers; one turn of the event
  // loop plus a margin is enough for the fetch to have started.
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}

function saveFromUrl(url: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function createClipController(hooks: ControllerHooks): ClipControllerApi {
  const state = ref<ClipState>('IDLE')
  const progress = ref<number | null>(null)
  const message = ref('')
  const error = ref<string | null>(null)
  const errorCode = ref<ClipErrorCode | null>(null)
  const source = ref<ResolvedSource | null>(null)
  const lastTelemetry = ref<ClipTelemetry | null>(null)
  const serverJobId = ref<string | null>(null)

  let abort: AbortController | null = null

  const onProgress = (report: ProgressReport) => {
    progress.value = report.percent
    message.value = report.message
  }

  function fail(state_: ClipState, clipError: ClipError): void {
    state.value = state_
    error.value = clipError.userMessage
    errorCode.value = clipError.code
    message.value = ''
    progress.value = null
  }

  function reset(): void {
    abort?.abort()
    abort = null
    state.value = 'IDLE'
    progress.value = null
    message.value = ''
    error.value = null
    errorCode.value = null
    lastTelemetry.value = null
    serverJobId.value = null
  }

  function cancel(): void {
    abort?.abort()
    abort = null
    state.value = 'CANCELLED'
    message.value = ''
    progress.value = null
  }

  /**
   * Validates the URL, then walks the source ladder. The browser source is skipped rather
   * than failed when it reports itself unavailable, so an unsupported browser costs nothing.
   */
  async function resolve(urlText: string): Promise<ResolvedSource | null> {
    abort?.abort()
    abort = new AbortController()
    const signal = abort.signal

    error.value = null
    errorCode.value = null
    source.value = null

    state.value = 'URL_VALIDATING'
    const videoId = extractVideoId(urlText)
    if (!videoId) {
      fail('ERROR', new ClipError('INVALID_URL'))
      return null
    }

    const webpageUrl = `https://www.youtube.com/watch?v=${videoId}`
    const recorder = new TelemetryRecorder(0)

    const ladder: YouTubeSource[] = [
      new BrowserYouTubeSource(hooks.probe),
      new ServerYouTubeSource(),
    ]

    let lastError: ClipError | null = null

    for (const candidate of ladder) {
      if (signal.aborted) {
        fail('CANCELLED', new ClipError('CANCELLED'))
        return null
      }

      state.value = candidate.name === 'browser' ? 'CLIENT_RESOLUTION' : 'SERVER_FALLBACK'
      message.value = 'Reading the video…'

      if (!(await candidate.isAvailable())) {
        if (candidate.name === 'browser') recorder.markResolution('browser', false)
        continue
      }

      try {
        const resolved = await candidate.resolveVideo(videoId, webpageUrl, signal)
        recorder.markResolution(candidate.name, true)
        source.value = resolved
        message.value = ''
        return resolved
      } catch (thrown) {
        const clipError = toClipError(thrown, 'CLIENT_RESOLUTION_FAILED')
        recorder.markResolution(candidate.name, false)
        lastError = clipError

        if (clipError.code === 'CANCELLED') {
          fail('CANCELLED', clipError)
          return null
        }

        // A hard failure means no strategy will do better — stop rather than burning the
        // user's time on a second identical answer.
        if (!clipError.recoverable) break
      }
    }

    const finalError = lastError ?? new ClipError('YOUTUBE_SOURCE_UNAVAILABLE')
    fail('CLIENT_RESOLUTION_FAILED', finalError)
    lastTelemetry.value = recorder.failed(finalError.code)
    return null
  }

  /**
   * Runs the processor ladder for an already-resolved video. Each processor gets one
   * attempt; a browser failure that another layer could survive drops to the server.
   */
  async function runClip(
    partial: Omit<ClipRequest, 'videoId' | 'webpageUrl'>,
  ): Promise<ClipArtifact | null> {
    const resolved = source.value
    if (!resolved) {
      fail('ERROR', new ClipError('YOUTUBE_SOURCE_UNAVAILABLE', 'no resolved source'))
      return null
    }

    abort?.abort()
    abort = new AbortController()
    const signal = abort.signal

    error.value = null
    errorCode.value = null
    serverJobId.value = null
    progress.value = 0

    const request: ClipRequest = {
      ...partial,
      videoId: resolved.videoId,
      webpageUrl: resolved.webpageUrl,
    }

    const recorder = new TelemetryRecorder(request.end - request.start)
    recorder.markResolution(resolved.resolvedBy, true)

    const browserProcessor = new BrowserMediaProcessor()
    const serverProcessor = new ServerMediaProcessor()
    const processors: MediaProcessor[] = [browserProcessor, serverProcessor]

    let lastError: ClipError | null = null

    for (const processor of processors) {
      const context: ProcessContext = {
        request,
        source: resolved,
        player: hooks.controller(),
        onProgress,
        signal,
      }

      if (signal.aborted) {
        fail('CANCELLED', new ClipError('CANCELLED'))
        lastTelemetry.value = recorder.failed('CANCELLED')
        return null
      }

      if (!(await processor.canHandle(context))) {
        if (processor.name === 'browser') recorder.markClientProcessing(false, null)
        continue
      }

      state.value = processor.name === 'browser' ? 'CLIENT_PROCESSING' : 'SERVER_PROCESSING'

      try {
        const artifact = await processor.process(context)

        if (processor.name === 'browser') {
          recorder.markClientProcessing(true, artifact.acquisition)
        } else {
          recorder.markServerProcessing()
          serverJobId.value = serverProcessor.lastJobId
        }

        if (artifact.blob) saveBlob(artifact.blob, artifact.fileName)
        else if (artifact.serverDownloadUrl) saveFromUrl(artifact.serverDownloadUrl, artifact.fileName)

        state.value = 'COMPLETED'
        progress.value = 100
        message.value = 'Saved to your device.'
        lastTelemetry.value = recorder.succeeded(artifact.producedBy, artifact.acquisition)
        return artifact
      } catch (thrown) {
        const clipError = toClipError(
          thrown,
          processor.name === 'browser' ? 'CLIENT_PROCESSING_FAILED' : 'SERVER_FALLBACK_FAILED',
        )
        lastError = clipError

        if (processor.name === 'browser') {
          recorder.markClientProcessing(false, browserProcessor.acquisition)
          state.value = 'CLIENT_PROCESSING_FAILED'
        } else {
          serverJobId.value = serverProcessor.lastJobId
          state.value = 'SERVER_PROCESSING_FAILED'
        }

        if (clipError.code === 'CANCELLED') {
          fail('CANCELLED', clipError)
          lastTelemetry.value = recorder.failed('CANCELLED')
          return null
        }

        if (!clipError.recoverable) break

        if (processor.name === 'browser') {
          // Transparent handover: the user sees a message about finishing the clip, not a
          // failure they have to act on.
          state.value = 'SERVER_FALLBACK'
          onProgress({ percent: null, message: 'Finishing your clip…' })
        }
      } finally {
        await processor.dispose().catch(() => undefined)
      }
    }

    const finalError = lastError ?? new ClipError('SERVER_FALLBACK_FAILED')
    fail(
      finalError.code === 'CLIENT_PROCESSING_FAILED' ? 'CLIENT_PROCESSING_FAILED' : 'SERVER_PROCESSING_FAILED',
      finalError,
    )
    lastTelemetry.value = recorder.failed(finalError.code)
    return null
  }

  return {
    state: readonly(state),
    progress: readonly(progress),
    message: readonly(message),
    error: readonly(error),
    errorCode: readonly(errorCode),
    source: readonly(source) as Readonly<Ref<ResolvedSource | null>>,
    lastTelemetry: readonly(lastTelemetry) as Readonly<Ref<ClipTelemetry | null>>,
    serverJobId: readonly(serverJobId),
    resolve,
    runClip,
    cancel,
    reset,
  }
}
