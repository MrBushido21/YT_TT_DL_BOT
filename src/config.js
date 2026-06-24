import path from 'node:path';
import os from 'node:os';

/**
 * Centralised settings. Tweak here, not in business logic.
 */
export const config = {
  // Telegram Bot API hard limit for sending files is 50 MB.
  // We keep a small safety margin so we never hit the wall.
  maxFileSizeBytes: 49 * 1024 * 1024,

  // How many downloads run at the same time.
  concurrency: 2,

  // Where temporary files live. Each download gets a randomUUID-based name.
  // Default: ./downloads relative to the project. Override with TEMP_DIR env.
  tempDir: process.env.TEMP_DIR
    ? path.resolve(process.env.TEMP_DIR)
    : path.resolve('./downloads'),

  // Fallback to OS tmp if you prefer:
  // tempDir: path.join(os.tmpdir(), 'tgbotdownloader'),

  // External binaries. Must be on PATH, or give absolute paths here.
  ytDlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',

  // Hard timeout for a single yt-dlp invocation (ms).
  downloadTimeoutMs: 5 * 60 * 1000,

  // Transient errors (e.g. TikTok "rehydration") are flaky: the same URL
  // often succeeds on a later attempt. Total attempts and delay between them.
  ytDlpRetries: 5,
  ytDlpRetryDelayMs: 1500,

  // YouTube quality presets exposed via inline buttons.
  // Each maps to a yt-dlp -f format string. Ordered worst -> best for fallback.
  youtubeQualities: {
    '360': {
      label: '360p',
      format: 'bestvideo[height<=360]+bestaudio/best[height<=360]',
    },
    '720': {
      label: '720p',
      format: 'bestvideo[height<=720]+bestaudio/best[height<=720]',
    },
    '1080': {
      label: '1080p',
      format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    },
  },

  // Order used when a chosen quality is too large: step down from here.
  qualityFallbackOrder: ['1080', '720', '360'],
};
