/**
 * Feature detection for the client-side paths. Everything here is a real capability probe
 * rather than user-agent sniffing, except where a platform lies about what it supports
 * (noted inline). Nothing in this file throws — an unsupported browser must degrade to the
 * server fallback, never break the page.
 */

export interface Capabilities {
  /** ffmpeg.wasm needs WebAssembly and a Worker to run off the main thread. */
  wasm: boolean
  workers: boolean
  /** Only the multi-threaded ffmpeg core needs these; we ship the single-threaded one. */
  sharedArrayBuffer: boolean
  crossOriginIsolated: boolean

  /** Tab/window capture — the only way a page can read YouTube's decoded media. */
  displayCapture: boolean
  mediaRecorder: boolean
  /** First MediaRecorder container the platform admits to supporting. */
  recorderMimeType: string | null

  /** Rough RAM signal, in GB. Undefined on Safari and Firefox. */
  deviceMemoryGb: number | null
  mobile: boolean
  ios: boolean

  /** True when the browser can plausibly build a clip without our server. */
  clientProcessing: boolean
  /** True when the browser can plausibly acquire media without our server. */
  clientAcquisition: boolean
}

/**
 * Containers in preference order. MP4 first because it is what users expect to receive and
 * it needs no remux; WebM is the reliable fallback on Chrome and Firefox.
 */
const RECORDER_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

const AUDIO_ONLY_MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
]

function firstSupportedMime(candidates: string[]): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null
  }
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

export function preferredRecorderMime(type: 'video' | 'audio'): string | null {
  return firstSupportedMime(type === 'audio' ? AUDIO_ONLY_MIME_CANDIDATES : RECORDER_MIME_CANDIDATES)
}

/**
 * iPadOS reports itself as "Macintosh", so touch points are the only reliable signal. This
 * matters because iOS Safari has no getDisplayMedia at all — every iOS request has to fall
 * back to the server, and we want to know that rather than fail mid-flow.
 */
function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPhone|iPod/.test(ua)) return true
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)
}

function detectMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const withUaData = navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  if (typeof withUaData.userAgentData?.mobile === 'boolean') return withUaData.userAgentData.mobile
  return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent)
}

let cached: Capabilities | null = null

export function detectCapabilities(): Capabilities {
  if (cached) return cached

  const wasm = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'
  const workers = typeof Worker === 'function'
  const sharedArrayBuffer = typeof SharedArrayBuffer === 'function'
  const crossOriginIsolated =
    typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false

  const displayCapture =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'

  const mediaRecorder = typeof MediaRecorder === 'function'
  const recorderMimeType = preferredRecorderMime('video')

  const withMemory = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { deviceMemory?: number })
    : undefined
  const deviceMemoryGb = typeof withMemory?.deviceMemory === 'number' ? withMemory.deviceMemory : null

  const ios = detectIos()
  const mobile = detectMobile()

  cached = {
    wasm,
    workers,
    sharedArrayBuffer,
    crossOriginIsolated,
    displayCapture,
    mediaRecorder,
    recorderMimeType,
    deviceMemoryGb,
    mobile,
    ios,
    clientProcessing: wasm && workers,
    // Capture is gated on a real MediaRecorder container; a browser that exposes the API but
    // supports no container would fail only after prompting the user, which is worse.
    clientAcquisition: displayCapture && mediaRecorder && recorderMimeType !== null,
  }

  return cached
}

/** Test seam — the cache would otherwise pin the first result for the page's lifetime. */
export function resetCapabilitiesCache(): void {
  cached = null
}

/** Short, non-identifying descriptor attached to telemetry. */
export function platformTag(caps = detectCapabilities()): string {
  if (caps.ios) return 'ios'
  if (caps.mobile) return 'mobile'
  return 'desktop'
}
