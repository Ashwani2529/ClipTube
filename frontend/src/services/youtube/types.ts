import type { AudioFormatGroup, ClipType, VideoFormatOption, VideoMeta } from '../../types'

/** Which layer did the YouTube-facing work. Drives the success metrics. */
export type StrategyName = 'browser' | 'server'

/**
 * How the media bytes were obtained. This is the distinction the experiment actually
 * measures — `capture` never touches our backend, `direct` uses the backend for a small
 * metadata call only, `server` routes the media through the backend.
 */
export type AcquisitionMode = 'capture' | 'direct' | 'server'

/** A single playable stream the browser may fetch for itself. */
export interface DirectStream {
  formatId: string
  url: string
  mimeType: string
  /** Total bytes, when YouTube reports it — used to plan Range requests. */
  contentLength: number | null
  hasAudio: boolean
  hasVideo: boolean
  ext: string
}

/**
 * Everything a strategy needs to hand to the media layer. `direct` is null whenever the
 * browser has no usable byte-level access, which is the common case.
 */
export interface ResolvedSource {
  videoId: string
  webpageUrl: string
  meta: VideoMeta
  video: VideoFormatOption[]
  audio: AudioFormatGroup[]
  direct: {
    streams: DirectStream[]
    /** Epoch ms after which the URLs stop working. */
    expiresAt: number | null
  } | null
  /** Which strategy produced this, for telemetry. */
  resolvedBy: StrategyName
}

export interface ClipRequest {
  videoId: string
  webpageUrl: string
  start: number
  end: number
  type: ClipType
  formatId: string
  /** Chosen height, used by the server fallback's format selector. */
  height: number | null
  /** Container the user should end up with. */
  ext: string
  title: string
}

/** The finished artefact, whoever built it. */
export interface ClipArtifact {
  blob: Blob | null
  /** Set instead of `blob` when the bytes live on the server and are streamed directly. */
  serverDownloadUrl: string | null
  fileName: string
  sizeBytes: number | null
  producedBy: StrategyName
  acquisition: AcquisitionMode
}

/** Reported by every long-running step so the existing progress bar keeps working. */
export interface ProgressReport {
  /** 0–100, or null when the step genuinely cannot report a percentage. */
  percent: number | null
  message: string
}

export type ProgressSink = (report: ProgressReport) => void

/**
 * The contract every extraction strategy implements. Adding a `FutureSource` means
 * implementing this and putting it in the ladder — nothing else changes.
 */
export interface YouTubeSource {
  readonly name: StrategyName

  /** Cheap check so the ladder can skip a strategy without paying for a failure. */
  isAvailable(): Promise<boolean>

  /** Metadata plus the format lists the picker renders. */
  resolveVideo(videoId: string, webpageUrl: string, signal: AbortSignal): Promise<ResolvedSource>
}
