import { ref } from 'vue'
import { createClip, describeError, downloadUrlFor, fetchJobStatus, type CreateClipInput } from './api'
import type { JobStatus } from '../types'

export type ClipPhase = 'idle' | 'starting' | 'working' | 'ready' | 'failed'

const POLL_INTERVAL_MS = 900
const MAX_WAIT_MS = 20 * 60_000

const PHASE_LABEL: Record<JobStatus, string> = {
  queued: 'Queued…',
  downloading: 'Fetching the section from YouTube…',
  processing: 'Packaging your clip…',
  ready: 'Ready — saving to your device…',
  downloaded: 'Saved.',
  failed: 'Failed.',
}

/** Hands the file to the browser; Content-Disposition makes it a save, not a navigation. */
function triggerBrowserDownload(jobId: string): void {
  const anchor = document.createElement('a')
  anchor.href = downloadUrlFor(jobId)
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Drives one clip request end to end: create the job, poll until the file exists, then
 * hand it to the browser. Only one job runs per dialog at a time.
 */
export function useClipJob() {
  const phase = ref<ClipPhase>('idle')
  const progress = ref(0)
  const message = ref('')
  const error = ref<string | null>(null)
  const fileName = ref<string | null>(null)

  let cancelled = false

  function reset(): void {
    cancelled = true
    phase.value = 'idle'
    progress.value = 0
    message.value = ''
    error.value = null
    fileName.value = null
  }

  function fail(reason: string): void {
    phase.value = 'failed'
    error.value = reason
    message.value = ''
  }

  /** Resolves with the created job id (useful for refreshing the stats counter). */
  async function start(input: CreateClipInput): Promise<string | null> {
    cancelled = false
    phase.value = 'starting'
    progress.value = 0
    error.value = null
    fileName.value = null
    message.value = 'Creating the job…'

    let jobId: string
    try {
      const created = await createClip(input)
      jobId = created.jobId
    } catch (requestError) {
      fail(describeError(requestError, 'Could not start the clip.'))
      return null
    }

    phase.value = 'working'
    const deadline = Date.now() + MAX_WAIT_MS

    while (!cancelled) {
      if (Date.now() > deadline) {
        fail('This clip is taking too long. Try a shorter range or a lower quality.')
        return jobId
      }

      await wait(POLL_INTERVAL_MS)
      if (cancelled) return jobId

      let status: Awaited<ReturnType<typeof fetchJobStatus>>
      try {
        status = await fetchJobStatus(jobId)
      } catch (statusError) {
        fail(describeError(statusError, 'Lost track of the clip job.'))
        return jobId
      }

      progress.value = status.progress
      message.value = PHASE_LABEL[status.status] ?? ''
      fileName.value = status.fileName

      if (status.status === 'failed') {
        fail(status.error ?? 'The clip could not be created.')
        return jobId
      }

      if (status.status === 'ready') {
        progress.value = 100
        phase.value = 'ready'
        message.value = PHASE_LABEL.ready
        triggerBrowserDownload(jobId)
        return jobId
      }
    }

    return jobId
  }

  return { phase, progress, message, error, fileName, start, reset }
}

export type { CreateClipInput }
