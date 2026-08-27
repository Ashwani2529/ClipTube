import { clipFileName } from '../../lib/filename'
import { detectCapabilities } from '../capabilities'
import { ClipError, toClipError } from '../youtube/errors'
import type { AcquisitionMode, ClipArtifact, DirectStream } from '../youtube/types'
import { captureRange } from './captureRecorder'
import { fetchClipBytes, probeDirectAccess } from './directFetch'
import { disposeFfmpeg, remuxInBrowser } from './ffmpeg'
import type { MediaProcessor, ProcessContext } from './types'

/**
 * Builds the clip entirely on the user's device.
 *
 * Two acquisition modes, tried in this order:
 *
 *  1. `direct` — fetch the bytes from `googlevideo` ourselves. Byte-exact and fast, but
 *     only possible when the backend was able to hand us stream URLs *and* those URLs
 *     permit a cross-origin read. Probed, never assumed.
 *  2. `capture` — record the embedded player. Always available on a browser with screen
 *     capture, needs no server involvement whatsoever, but runs in real time and
 *     re-encodes.
 *
 * Either way the trim happens here via ffmpeg.wasm, and the caller just gets a Blob.
 */
export class BrowserMediaProcessor implements MediaProcessor {
  readonly name = 'browser' as const

  /** Set during `process` so telemetry can record which mode actually ran. */
  private mode: AcquisitionMode = 'capture'

  get acquisition(): AcquisitionMode {
    return this.mode
  }

  async canHandle(context: ProcessContext): Promise<boolean> {
    const caps = detectCapabilities()
    if (!caps.clientProcessing) return false

    // Direct fetch needs no player, so it is viable even without capture support.
    if (this.pickDirectStream(context) !== null) return true

    return caps.clientAcquisition && context.player !== null
  }

  /** Chooses the stream that matches the request, if the source offered any. */
  private pickDirectStream(context: ProcessContext): DirectStream | null {
    const direct = context.source.direct
    if (!direct || direct.streams.length === 0) return null

    if (direct.expiresAt !== null && direct.expiresAt <= Date.now()) return null

    const wantAudioOnly = context.request.type === 'audio'
    const exact = direct.streams.find((stream) => stream.formatId === context.request.formatId)

    if (exact && (!wantAudioOnly || exact.hasAudio)) return exact

    // A muxed stream is preferred over a video-only one: without it we would have to fetch
    // and mux two streams, which doubles the bandwidth and the memory.
    return (
      direct.streams.find((stream) =>
        wantAudioOnly ? stream.hasAudio && !stream.hasVideo : stream.hasVideo && stream.hasAudio,
      ) ?? null
    )
  }

  async process(context: ProcessContext): Promise<ClipArtifact> {
    const { request, onProgress, signal } = context
    const audioOnly = request.type === 'audio'
    const clipSeconds = request.end - request.start

    const direct = this.pickDirectStream(context)

    if (direct) {
      const probe = await probeDirectAccess(direct, signal)
      if (probe.allowed) {
        this.mode = 'direct'
        return this.viaDirectFetch(context, direct, probe.supportsRanges)
      }
      // Expected on most origins. Fall through to capture rather than failing.
    }

    const caps = detectCapabilities()
    if (!caps.clientAcquisition || !context.player) {
      throw new ClipError('BROWSER_UNSUPPORTED', 'no client acquisition path available')
    }

    this.mode = 'capture'

    const capture = await captureRange({
      player: context.player,
      startSeconds: request.start,
      endSeconds: request.end,
      audioOnly,
      height: request.height,
      onProgress,
      signal,
    })

    onProgress({ percent: null, message: 'Trimming your clip…' })

    // The recording brackets the requested range loosely, so trim to the exact bounds. The
    // recorded material starts at `leadInSeconds` before the mark.
    const blob = await remuxInBrowser({
      input: capture.blob,
      startSeconds: capture.leadInSeconds,
      durationSeconds: clipSeconds,
      outputExt: request.ext,
      audioOnly,
      onProgress,
      signal,
    })

    return this.toArtifact(context, blob)
  }

  private async viaDirectFetch(
    context: ProcessContext,
    stream: DirectStream,
    supportsRanges: boolean,
  ): Promise<ClipArtifact> {
    const { request, onProgress, signal } = context
    const audioOnly = request.type === 'audio'

    const fetched = await fetchClipBytes({
      stream,
      startSeconds: request.start,
      endSeconds: request.end,
      durationSeconds: context.source.meta.durationSeconds,
      supportsRanges,
      onProgress,
      signal,
    })

    onProgress({ percent: null, message: 'Trimming your clip…' })

    const blob = await remuxInBrowser({
      input: fetched.blob,
      startSeconds: fetched.leadInSeconds,
      durationSeconds: request.end - request.start,
      outputExt: request.ext,
      audioOnly,
      onProgress,
      signal,
    })

    return this.toArtifact(context, blob)
  }

  private toArtifact(context: ProcessContext, blob: Blob): ClipArtifact {
    return {
      blob,
      serverDownloadUrl: null,
      fileName: clipFileName(context.request.title, context.request.ext),
      sizeBytes: blob.size,
      producedBy: 'browser',
      acquisition: this.mode,
    }
  }

  /**
   * Frees the WebAssembly core. Called on every exit path — a 32 MB core plus its in-memory
   * filesystem is far too much to leave resident on a phone after the clip is saved.
   */
  async dispose(): Promise<void> {
    await disposeFfmpeg().catch(() => undefined)
  }
}

export { toClipError }
