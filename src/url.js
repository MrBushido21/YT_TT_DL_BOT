/**
 * URL validation and platform detection.
 */

/**
 * Extract the first http(s) URL from arbitrary text, or null.
 * @param {string} text
 * @returns {string|null}
 */
export function extractUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s]+/i);
  if (!match) return null;

  const raw = match[0].replace(/[).,]+$/, ''); // trim trailing punctuation
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Detect the platform from a URL.
 * @param {string} url
 * @returns {'youtube'|'tiktok'|'unknown'}
 */
export function detectPlatform(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }

  if (
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtu.be' ||
    host === 'youtube-nocookie.com'
  ) {
    return 'youtube';
  }

  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    return 'tiktok';
  }

  return 'unknown';
}
