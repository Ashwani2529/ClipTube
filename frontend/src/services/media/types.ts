import type {
  AcquisitionMode,
  ClipArtifact,
  ClipRequest,
  ProgressSink,
  ResolvedSource,
  StrategyName,
} from '../youtube/types'

/**
 * Controls the embedded YouTube player. The capture path needs to drive playback precisely
 * — seek to the start, set the quality, play, stop at the end — so this is an explicit
 * contract rather than a reach into the Vue component.
 */
export interface PlayerController {
  seek(seconds: number, allowSeekAhead: boolean): void
  play(): void
  pause(): void
  getCurrentTime(): number
  /** Best-effort: YouTube may ignore the request and keep its own choice. */
  requestQuality(height: number): void
  /** Mutes/unmutes the embed; capture needs audio flowing to record it. */
  setMuted(muted: boolean): void
  /** The element the user should be nudged to share when capture starts. */
  getContainer(): HTMLElement | null
}

export interface ProcessContext {
  request: ClipRequest
  source: ResolvedSource
  player: PlayerController | null
  onProgress: ProgressSink
  signal: AbortSignal
}

/**
 * One media processor per environment. Callers receive a ClipArtifact and never learn
 * whether ffmpeg ran in a worker, in the browser's recorder, or on the server.
 */
export interface MediaProcessor {
  readonly name: StrategyName
  readonly acquisition: AcquisitionMode

  /** Cheap gate, checked before the user is prompted for anything. */
  canHandle(context: ProcessContext): Promise<boolean>

  process(context: ProcessContext): Promise<ClipArtifact>

  /** Release workers, streams and object URLs. Always called, including after failure. */
  dispose(): Promise<void>
}
