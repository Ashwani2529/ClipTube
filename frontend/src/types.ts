export type ClipType = 'video' | 'audio'

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'ready'
  | 'downloaded'
  | 'failed'

export interface VideoMeta {
  videoId: string
  title: string
  uploader: string
  durationSeconds: number
  thumbnail: string | null
  webpageUrl: string
  isLive: boolean
}

export interface VideoFormatOption {
  formatId: string
  label: string
  height: number
  width: number | null
  fps: number | null
  ext: string
  vcodec: string
  hasAudio: boolean
  filesizeBytes: number | null
  note: string | null
  hdr: boolean
}

export interface AudioTierOption {
  formatId: string
  bitrateKbps: number | null
  label: string
  filesizeBytes: number | null
  sampleRate: number | null
  note: string | null
}

export interface AudioFormatGroup {
  codec: string
  ext: string
  label: string
  tiers: AudioTierOption[]
}

export interface FormatsResponse {
  meta: VideoMeta
  video: VideoFormatOption[]
  audio: AudioFormatGroup[]
}

export interface ClipResponse {
  jobId: string
  status: JobStatus
  statusUrl: string
  downloadUrl: string
  totalDownloads: number
}

export interface JobStatusResponse {
  jobId: string
  status: JobStatus
  progress: number
  type: ClipType
  title: string
  fileName: string | null
  sizeBytes: number | null
  error: string | null
  downloadUrl: string | null
}

export interface StatsResponse {
  totalDownloads: number
}

/** The clip bounds shared by the slider and the two timestamp fields. */
export interface ClipRange {
  start: number
  end: number
}
