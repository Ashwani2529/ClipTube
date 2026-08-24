/** Unicode combining marks left behind by NFKD normalisation. */
const COMBINING_MARKS = /[̀-ͯ]/g;
const QUOTES = /['"‘’“”`]/g;

/**
 * Turns a video title into a filesystem-safe slug. Falls back to `clip` so the
 * filename is never empty for titles made entirely of punctuation, or of script that
 * strips to nothing.
 */
export function slugify(input: string, maxLength = 80): string {
  const slug = input
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(QUOTES, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  return slug || 'clip';
}
