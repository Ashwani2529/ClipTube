import type { ClipType, JobStatus } from '../models/Job';

export interface VideoMeta {
  videoId: string;
  title: string;
  uploader: string;
  durationSeconds: number;
  thumbnail: string | null;
  webpageUrl: string;
  isLive: boolean;
}

export interface VideoFormatOption {
  formatId: string;
  /** Human label such as `1080p60`. */
  label: string;
  height: number;
  width: number | null;
  fps: number | null;
  /** Source container reported by yt-dlp (`mp4`, `webm`, …). */
  ext: string;
  vcodec: string;
  /** True when the format already carries audio and needs no merge. */
  hasAudio: boolean;
  filesizeBytes: number | null;
  note: string | null;
  hdr: boolean;
}

export interface AudioTierOption {
  formatId: string;
  /** Average bitrate in kbps, rounded. */
  bitrateKbps: number | null;
  label: string;
  filesizeBytes: number | null;
  sampleRate: number | null;
  note: string | null;
}

export interface AudioFormatGroup {
  /** Normalised codec key: `aac`, `opus`, `mp3`, … */
  codec: string;
  /** Container the clip will be saved in for this codec. */
  ext: string;
  label: string;
  tiers: AudioTierOption[];
}

export interface FormatsResponse {
  meta: VideoMeta;
  video: VideoFormatOption[];
  audio: AudioFormatGroup[];
}

export interface ClipRequestBody {
  url?: unknown;
  start?: unknown;
  end?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  type?: unknown;
  formatId?: unknown;
}

export interface ClipResponse {
  jobId: string;
  status: JobStatus;
  statusUrl: string;
  downloadUrl: string;
  totalDownloads: number;
}

export interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  progress: number;
  type: ClipType;
  title: string;
  fileName: string | null;
  sizeBytes: number | null;
  error: string | null;
  downloadUrl: string | null;
}

export interface StatsResponse {
  totalDownloads: number;
}
