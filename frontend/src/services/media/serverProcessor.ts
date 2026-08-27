import { createClip, downloadUrlFor, fetchJobStatus } from '../../lib/api'
import { ClipError, toClipError } from '../youtube/errors'
import type { AcquisitionMode, ClipArtifact } from '../youtube/types'
import type { MediaProcessor, ProcessContext } from './types'

/**
 * The unchanged server path: the backend runs yt-dlp and ffmpeg and we poll until the file
 * exists. This is the fallback, reached only when the browser could not acquire or process
 * the media itself.
 *
 * The clip is handed over as a URL rather than a Blob so the bytes stream straight from the
 * server to disk, never sitting in a JavaScript buffer.
 */

const POLL_INTERVAL_MS = 900
const MAX_WAIT_MS = 20 * 60_000

const STATUS_MESSAGE: Record<string, string> = {
  queued: 'Queued…',
  downloading: 'Fetching the section…',
  processing: 'Packaging your clip…',
  ready: 'Ready — saving to your device…',
  downloaded: 'Saved.',
  failed: 'Failed.',
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class ServerMediaProcessor implements MediaProcessor {
  readonly name = 'server' as const
  readonly acquisition: AcquisitionMode = 'server'

  /** Exposed so the caller can refresh the download counter after a server job starts. */
  lastJobId: string | null = null

  /** The server path has no client-side prerequisites. */
  async canHandle(): Promise<boolean> {
    return true
  }

  async process(context: ProcessContext): Promise<ClipArtifact> {
    const { request, onProgress, signal } = context

    onProgress({ percent: 0, message: 'Handing the clip to the server…' })

    let jobId: string
    try {
      const created = await createClip({
        url: request.webpageUrl,
        start: request.start,
        end: request.end,
        type: request.type,
        formatId: request.formatId,
      })
      jobId = created.jobId
      this.lastJobId = jobId
    } catch (error) {
      throw toClipError(error, 'SERVER_FALLBACK_FAILED')
    }

    const deadline = Date.now() + MAX_WAIT_MS

    while (true) {
      if (signal.aborted) throw new ClipError('CANCELLED', 'aborted while waiting on the server')
      if (Date.now() > deadline) throw new ClipError('TIMEOUT', 'server job exceeded the deadline')

      await wait(POLL_INTERVAL_MS)
      if (signal.aborted) throw new ClipError('CANCELLED', 'aborted while waiting on the server')

      let status: Awaited<ReturnType<typeof fetchJobStatus>>
      try {
        status = await fetchJobStatus(jobId)
      } catch (error) {
        throw toClipError(error, 'SERVER_FALLBACK_FAILED')
      }

      onProgress({
        percent: status.progress > 0 ? status.progress : null,
        message: STATUS_MESSAGE[status.status] ?? 'Working…',
      })

      if (status.status === 'failed') {
        throw new ClipError('SERVER_FALLBACK_FAILED', status.error ?? 'server job failed')
      }

      if (status.status === 'ready') {
        return {
          blob: null,
          serverDownloadUrl: downloadUrlFor(jobId),
          fileName: status.fileName ?? `${request.title}-clip.${request.ext}`,
          sizeBytes: status.sizeBytes,
          producedBy: 'server',
          acquisition: 'server',
        }
      }
    }
  }

  /** Nothing is held client-side; the server unlinks its own temp file after serving. */
  async dispose(): Promise<void> {}
}
