const ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
])

/**
 * Client-side mirror of the backend's parser so the URL box can validate without a
 * round trip. The backend still re-validates everything it receives.
 */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (ID_PATTERN.test(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null

  const fromQuery = url.searchParams.get('v')
  if (fromQuery && ID_PATTERN.test(fromQuery)) return fromQuery

  const segments = url.pathname.split('/').filter(Boolean)
  if (url.hostname.toLowerCase().endsWith('youtu.be')) {
    const first = segments[0]
    return first && ID_PATTERN.test(first) ? first : null
  }

  for (let i = 0; i < segments.length - 1; i += 1) {
    if (['shorts', 'embed', 'live', 'v'].includes(segments[i])) {
      const candidate = segments[i + 1]
      if (ID_PATTERN.test(candidate)) return candidate
    }
  }

  return null
}

let apiPromise: Promise<typeof YT> | null = null

/**
 * Loads the YouTube IFrame Player API exactly once. The API only offers a single global
 * ready callback, so the promise is cached and shared by every player instance.
 */
export function loadYouTubeIframeApi(): Promise<typeof YT> {
  if (window.YT?.Player) return Promise.resolve(window.YT)

  if (!apiPromise) {
    apiPromise = new Promise<typeof YT>((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        previous?.()
        resolve(window.YT)
      }

      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.async = true
      script.onerror = () => {
        apiPromise = null
        reject(new Error('Could not load the YouTube player.'))
      }
      document.head.appendChild(script)
    })
  }

  return apiPromise
}
