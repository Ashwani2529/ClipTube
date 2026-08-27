import type { ProgressSink } from '../youtube/types'
import { ClipError, toClipError } from '../youtube/errors'

/**
 * Lazy ffmpeg.wasm wrapper.
 *
 * Bundle cost: `@ffmpeg/ffmpeg` itself is a thin ~100 kB wrapper, and this module is only
 * ever reached through a dynamic import, so none of it lands in the initial chunk. The
 * expensive part is the ~32 MB WebAssembly core, which is fetched from a CDN the first time
 * a clip actually needs re-muxing and then reused for the page's lifetime.
 *
 * We ship the **single-threaded** core on purpose. The multi-threaded one needs
 * `SharedArrayBuffer`, which needs COOP/COEP headers, which we cannot set on a static
 * frontend host without breaking the YouTube iframe embed. Single-threaded is slower but it
 * works everywhere WebAssembly does, including mobile Safari.
 */

const DEFAULT_CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd'

const CORE_BASE = import.meta.env.VITE_FFMPEG_CORE_URL ?? DEFAULT_CORE_BASE

type FFmpegInstance = import('@ffmpeg/ffmpeg').FFmpeg

let instancePromise: Promise<FFmpegInstance> | null = null

/**
 * Loads the core once and shares it. Concurrent callers await the same promise; a failed
 * load clears the cache so a later attempt can retry rather than inheriting the failure.
 */
async function getFFmpeg(): Promise<FFmpegInstance> {
  if (instancePromise) return instancePromise

  instancePromise = (async () => {
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import('@ffmpeg/ffmpeg'),
      import('@ffmpeg/util'),
    ])

    const ffmpeg = new FFmpeg()

    // The core has to be served same-origin to be usable as a worker script, so both files
    // are rehosted as blob URLs.
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    ])

    await ffmpeg.load({ coreURL, wasmURL })
    return ffmpeg
  })()

  try {
    return await instancePromise
  } catch (error) {
    instancePromise = null
    throw new ClipError(
      'BROWSER_UNSUPPORTED',
      `ffmpeg.wasm failed to load: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/** True when the core is already warm, so callers can skip a "preparing" message. */
export function isFfmpegReady(): boolean {
  return instancePromise !== null
}

export interface RemuxOptions {
  input: Blob
  /** Seconds into `input` to start at. Omit or 0 to keep the start. */
  startSeconds?: number
  /** Clip length in seconds. Omit to run to the end. */
  durationSeconds?: number
  /** Container to produce: `mp4`, `webm`, `m4a`, … */
  outputExt: string
  /** Drop the video track — used for audio-only clips. */
  audioOnly?: boolean
  onProgress?: ProgressSink
  signal?: AbortSignal
}

/**
 * Chooses the cheapest set of arguments that can produce the requested output.
 *
 * Stream copy is tried first and is the normal case: a recorded or fetched segment already
 * holds the right codecs, so trimming is a container operation. Re-encoding only happens
 * when the source codecs cannot live in the requested container.
 */
function buildArgs(options: RemuxOptions, inputName: string, outputName: string): string[] {
  const args: string[] = []

  // Input-side -ss is the fast path: ffmpeg seeks by keyframe instead of decoding and
  // discarding everything before the start.
  if (options.startSeconds && options.startSeconds > 0) {
    args.push('-ss', options.startSeconds.toFixed(3))
  }

  args.push('-i', inputName)

  if (options.durationSeconds && options.durationSeconds > 0) {
    args.push('-t', options.durationSeconds.toFixed(3))
  }

  if (options.audioOnly) {
    args.push('-vn', '-c:a', 'copy')
  } else {
    args.push('-c', 'copy')
  }

  // WebM-sourced audio (Opus) cannot be copied into MP4 on every core build; letting
  // ffmpeg pick the encoder for the container avoids a hard failure on that combination.
  if (options.outputExt === 'mp4') {
    args.push('-movflags', '+faststart')
  }

  args.push(outputName)
  return args
}

/** MIME type for the produced Blob, so the browser saves it with the right handler. */
function mimeFor(ext: string): string {
  switch (ext) {
    case 'mp4':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case 'm4a':
      return 'audio/mp4'
    case 'opus':
    case 'oga':
      return 'audio/ogg'
    case 'mp3':
      return 'audio/mpeg'
    default:
      return 'application/octet-stream'
  }
}

/**
 * Trims and/or re-containers a media blob entirely in the browser.
 *
 * Files are removed from the virtual filesystem in a `finally` block — ffmpeg.wasm holds
 * its FS in memory, so leaving a 200 MB input behind would keep that memory pinned for the
 * rest of the session, which mobile devices will not tolerate.
 */
export async function remuxInBrowser(options: RemuxOptions): Promise<Blob> {
  const ffmpeg = await getFFmpeg()
  const { fetchFile } = await import('@ffmpeg/util')

  const inputExt = options.input.type.includes('mp4') ? 'mp4' : 'webm'
  const inputName = `in.${inputExt}`
  const outputName = `out.${options.outputExt}`

  const onProgress = options.onProgress
  const handleProgress = ({ progress }: { progress: number }) => {
    if (!onProgress) return
    // ffmpeg reports 0–1 and occasionally overshoots slightly on short inputs.
    const percent = Math.max(0, Math.min(100, Math.round(progress * 100)))
    onProgress({ percent, message: 'Building your clip…' })
  }

  ffmpeg.on('progress', handleProgress)

  const onAbort = () => {
    // Terminating is the only way to interrupt a running exec; the next call reloads.
    try {
      ffmpeg.terminate()
    } finally {
      instancePromise = null
    }
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(options.input))

    let exitCode = await ffmpeg.exec(buildArgs(options, inputName, outputName))

    if (exitCode !== 0 && !options.audioOnly) {
      // Stream copy refused the container/codec pairing. Re-encode audio only, which is
      // far cheaper than a full video re-encode and fixes the common Opus-into-MP4 case.
      const fallbackArgs = buildArgs(options, inputName, outputName).map((arg) =>
        arg === 'copy' ? 'copy' : arg,
      )
      const withAudioEncode = [
        ...fallbackArgs.slice(0, fallbackArgs.length - 1),
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        outputName,
      ].filter((arg, index, all) => !(arg === '-c' && all[index + 1] === 'copy'))

      exitCode = await ffmpeg.exec(withAudioEncode)
    }

    if (exitCode !== 0) {
      throw new ClipError('CLIENT_PROCESSING_FAILED', `ffmpeg exited with ${exitCode}`)
    }

    const data = await ffmpeg.readFile(outputName)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data

    if (bytes.length === 0) {
      throw new ClipError('CLIENT_PROCESSING_FAILED', 'ffmpeg produced an empty file')
    }

    return new Blob([bytes as BlobPart], { type: mimeFor(options.outputExt) })
  } catch (error) {
    if (options.signal?.aborted) throw new ClipError('CANCELLED', 'aborted during remux')
    throw toClipError(error, 'CLIENT_PROCESSING_FAILED')
  } finally {
    ffmpeg.off('progress', handleProgress)
    options.signal?.removeEventListener('abort', onAbort)

    // Best effort: the instance may already be terminated by an abort.
    await ffmpeg.deleteFile(inputName).catch(() => undefined)
    await ffmpeg.deleteFile(outputName).catch(() => undefined)
  }
}

/** Frees the WebAssembly core and its in-memory filesystem. */
export async function disposeFfmpeg(): Promise<void> {
  if (!instancePromise) return
  const pending = instancePromise
  instancePromise = null
  try {
    const ffmpeg = await pending
    ffmpeg.terminate()
  } catch {
    // Already gone; nothing to release.
  }
}
