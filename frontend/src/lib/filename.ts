/**
 * Mirrors the backend's naming so a clip is called the same thing whether the browser or
 * the server produced it: `{slugified-title}-clip.{ext}`.
 */

const MAX_SLUG_LENGTH = 100

/** Unicode combining marks, built from escapes so the source stays ASCII-only. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g')

export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    // Decomposition leaves accents as separate marks; dropping them collapses each
    // character to its base letter rather than deleting the letter entirely.
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')

  return slug || 'clip'
}

export function clipFileName(title: string, ext: string): string {
  return `${slugify(title)}-clip.${ext}`
}
