const CLOCK_PATTERN = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]?\d)$/
const SHORT_PATTERN = /^([0-5]?\d):([0-5]?\d)$/

/** Formats seconds as `hh:mm:ss` — the shape the timestamp inputs expect. */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds || 0))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/** Compact label for durations: `1:04:07`, `4:07`, `0:07`. */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds || 0))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** Parses `hh:mm:ss` or `mm:ss`. Returns null when the text isn't a valid timestamp. */
export function parseClock(input: string): number | null {
  const raw = input.trim()
  if (!raw) return null

  const full = CLOCK_PATTERN.exec(raw)
  if (full) {
    const hours = Number.parseInt(full[1] ?? '0', 10)
    return hours * 3600 + Number.parseInt(full[2], 10) * 60 + Number.parseInt(full[3], 10)
  }

  const short = SHORT_PATTERN.exec(raw)
  if (short) {
    return Number.parseInt(short[1], 10) * 60 + Number.parseInt(short[2], 10)
  }

  return null
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
