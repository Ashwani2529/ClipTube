import { detectCapabilities, preferredRecorderMime } from '../capabilities'
import { ClipError, toClipError } from '../youtube/errors'
import type { ProgressSink } from '../youtube/types'
import type { PlayerController } from './types'

/**
 * Records the requested range straight off the embedded YouTube player.
 *
 * This is the only path where the media never touches our backend: the iframe fetches from
 * `googlevideo` over the user's own connection, and we record what it renders. It is
 * therefore the path the experiment is really testing.
 *
 * Two honest costs come with it:
 *  - it runs in real time, because we are recording playback rather than downloading bytes;
 *  - it re-encodes, so the result is a faithful capture rather than a byte-exact copy.
 *
 * Both are unavoidable given that page JavaScript cannot read a cross-origin media stream.
 */

/** Extra time allowed beyond the clip length before we give up on the recorder. */
const OVERRUN_GRACE_MS = 20_000
/** How often playback position is checked while recording. */
const TICK_MS = 200
/** Recorder chunk interval — small enough to keep peak memory near one chunk. */
const CHUNK_MS = 1_000
/** How long to wait for playback to actually reach the start position. */
const SEEK_SETTLE_TIMEOUT_MS = 15_000

export interface CaptureResult {
  blob: Blob
  /**
   * Seconds of material recorded *before* the requested start. The caller trims this off,
   * because seek-and-play latency means recording never begins exactly on the mark.
   */
  leadInSeconds: number
  /** Actual recorded span, used to bound the trim. */
  recordedSeconds: number
  mimeType: string
}

export interface CaptureOptions {
  player: PlayerController
  startSeconds: number
  endSeconds: number
  /** Audio-only clips discard the video track before recording. */
  audioOnly: boolean
  /** Requested output height, passed to the player as a quality hint. */
  height: number | null
  onProgress: ProgressSink
  signal: AbortSignal
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Prompts for tab capture. Chrome-only hints make the current tab the default choice, which
 * removes most of the friction; other browsers just show their standard picker.
 */
async function requestDisplayStream(wantAudio: boolean): Promise<MediaStream> {
  const constraints: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: { frameRate: { ideal: 30, max: 60 } },
    audio: wantAudio,
    // Non-standard but widely shipped in Chromium; ignored elsewhere.
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    systemAudio: 'include',
  }

  try {
    return await navigator.mediaDevices.getDisplayMedia(constraints)
  } catch (error) {
    // A refused permission prompt is a deliberate user action, not a browser limitation —
    // toClipError maps NotAllowedError to CANCELLED so we do not silently fall back.
    throw toClipError(error, 'BROWSER_UNSUPPORTED')
  }
}

/** Waits until the player is genuinely playing at or past `target`. */
async function settleAtStart(
  player: PlayerController,
  target: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + SEEK_SETTLE_TIMEOUT_MS
  let lastTime = -1
  let advancingTicks = 0

  while (Date.now() < deadline) {
    if (signal.aborted) throw new ClipError('CANCELLED', 'aborted while seeking')

    const now = player.getCurrentTime()
    // Require both "past the mark" and "actually moving", so we do not start recording
    // during a buffering stall and capture a frozen frame.
    if (now >= target - 0.35) {
      if (now > lastTime + 0.05) advancingTicks += 1
      else advancingTicks = 0
      if (advancingTicks >= 2) return
    }
    lastTime = now
    await wait(TICK_MS)
  }

  throw new ClipError('MEDIA_UNAVAILABLE', 'playback never reached the start position')
}

export async function captureRange(options: CaptureOptions): Promise<CaptureResult> {
  const caps = detectCapabilities()
  if (!caps.clientAcquisition) {
    throw new ClipError('BROWSER_UNSUPPORTED', 'no display capture or recorder support')
  }

  const { player, startSeconds, endSeconds, audioOnly, signal } = options
  const clipSeconds = endSeconds - startSeconds
  if (clipSeconds <= 0) throw new ClipError('CLIENT_PROCESSING_FAILED', 'empty range')

  const mimeType = preferredRecorderMime(audioOnly ? 'audio' : 'video')
  if (!mimeType) throw new ClipError('BROWSER_UNSUPPORTED', 'no recordable container')

  options.onProgress({ percent: null, message: 'Waiting for screen-share permission…' })

  const stream = await requestDisplayStream(true)
  const chunks: Blob[] = []
  let recorder: MediaRecorder | null = null

  /** Runs on every exit path, including abort. */
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop()
  }

  try {
    if (signal.aborted) throw new ClipError('CANCELLED', 'aborted before recording')

    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      // Without tab audio a video clip would be silent and an audio clip empty, so this is
      // a genuine failure rather than something to paper over.
      throw new ClipError(
        'MEDIA_UNAVAILABLE',
        'the shared surface provided no audio — tab audio was not shared',
      )
    }

    // Build exactly the stream we intend to record; dropping the video track for audio-only
    // clips avoids encoding frames we are about to throw away.
    const recordedStream = new MediaStream(
      audioOnly ? audioTracks : [...stream.getVideoTracks(), ...audioTracks],
    )

    if (!audioOnly && recordedStream.getVideoTracks().length === 0) {
      throw new ClipError('MEDIA_UNAVAILABLE', 'no video track in the shared surface')
    }

    if (options.height) player.requestQuality(options.height)
    player.setMuted(false)

    options.onProgress({ percent: null, message: 'Cueing the video…' })
    player.seek(startSeconds, true)
    player.play()
    await settleAtStart(player, startSeconds, signal)

    recorder = new MediaRecorder(recordedStream, { mimeType })

    const finished = new Promise<void>((resolve, reject) => {
      recorder!.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder!.onerror = () =>
        reject(new ClipError('CLIENT_PROCESSING_FAILED', 'the recorder failed'))
      recorder!.onstop = () => resolve()
    })

    const mediaTimeAtRecordStart = player.getCurrentTime()
    const wallClockStart = performance.now()
    recorder.start(CHUNK_MS)

    // Stop on playback position rather than wall clock, so a mid-clip buffering stall
    // lengthens the recording instead of truncating the clip.
    const hardDeadline = wallClockStart + clipSeconds * 1000 + OVERRUN_GRACE_MS
    while (true) {
      if (signal.aborted) throw new ClipError('CANCELLED', 'aborted while recording')

      const position = player.getCurrentTime()
      if (position >= endSeconds) break
      if (performance.now() > hardDeadline) break

      const done = Math.min(100, Math.max(0, ((position - startSeconds) / clipSeconds) * 100))
      options.onProgress({ percent: Math.round(done), message: 'Recording your clip…' })

      await wait(TICK_MS)
    }

    const mediaTimeAtRecordStop = player.getCurrentTime()
    player.pause()

    if (recorder.state !== 'inactive') recorder.stop()
    await finished

    if (chunks.length === 0) {
      throw new ClipError('CLIENT_PROCESSING_FAILED', 'the recorder produced no data')
    }

    return {
      blob: new Blob(chunks, { type: mimeType }),
      leadInSeconds: Math.max(0, startSeconds - mediaTimeAtRecordStart),
      recordedSeconds: Math.max(0, mediaTimeAtRecordStop - mediaTimeAtRecordStart),
      mimeType,
    }
  } catch (error) {
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // Already stopping; the tracks are torn down below either way.
      }
    }
    throw toClipError(error, 'CLIENT_PROCESSING_FAILED')
  } finally {
    // Releasing the capture immediately is what removes Chrome's "sharing this tab" bar.
    stopTracks()
    chunks.length = 0
  }
}
