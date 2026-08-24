import { badRequest } from './errors';

const ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

/**
 * Extracts the 11-character video id from any of the common YouTube URL shapes
 * (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`). Returns null when the
 * input is not a recognisable single-video YouTube URL.
 */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Bare id pasted straight in.
  if (ID_PATTERN.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;

  const fromQuery = url.searchParams.get('v');
  if (fromQuery && ID_PATTERN.test(fromQuery)) return fromQuery;

  const segments = url.pathname.split('/').filter(Boolean);
  if (url.hostname.toLowerCase().endsWith('youtu.be')) {
    const first = segments[0];
    if (first && ID_PATTERN.test(first)) return first;
    return null;
  }

  const keyed = ['shorts', 'embed', 'live', 'v'];
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (keyed.includes(segments[i] as string)) {
      const candidate = segments[i + 1] as string;
      if (ID_PATTERN.test(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Validates the incoming URL and rebuilds it into a canonical watch URL. Rebuilding
 * (rather than forwarding user input) keeps arbitrary strings and extra flags such as
 * playlist ids out of the yt-dlp argument list.
 */
export function normalizeYoutubeUrl(input: unknown): { url: string; videoId: string } {
  if (typeof input !== 'string') {
    throw badRequest('`url` must be a string.');
  }

  const videoId = extractVideoId(input);
  if (!videoId) {
    throw badRequest('That does not look like a YouTube video URL.');
  }

  return { url: `https://www.youtube.com/watch?v=${videoId}`, videoId };
}
