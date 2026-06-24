import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * Thrown for known, user-facing problems. `userMessage` is safe to show.
 * The original technical detail stays in `cause` for the console log.
 */
export class DownloadError extends Error {
  constructor(userMessage, cause, { retriable = false } = {}) {
    super(userMessage);
    this.name = 'DownloadError';
    this.userMessage = userMessage;
    this.cause = cause;
    // Transient failures worth retrying automatically before giving up.
    this.retriable = retriable;
  }
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run yt-dlp, retrying on transient errors (e.g. TikTok's flaky
 * "rehydration" failure, where the same URL succeeds on a later attempt).
 * @param {string[]} args
 * @param {string} [purpose] for logs
 */
async function runYtDlp(args, purpose = 'yt-dlp') {
  let lastErr;
  for (let attempt = 1; attempt <= config.ytDlpRetries; attempt++) {
    try {
      return await spawnYtDlpOnce(args, purpose);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof DownloadError) || !err.retriable) throw err;
      if (attempt < config.ytDlpRetries) {
        console.warn(
          `[${purpose}] transient error, retry ${attempt}/${config.ytDlpRetries - 1}: ${err.userMessage}`,
        );
        await sleep(config.ytDlpRetryDelayMs);
      }
    }
  }
  throw lastErr;
}

/**
 * Run yt-dlp once and resolve with { stdout, stderr }.
 * Rejects (with a DownloadError mapped from stderr) on non-zero exit.
 * @param {string[]} args
 * @param {string} [purpose] for logs
 */
function spawnYtDlpOnce(args, purpose = 'yt-dlp') {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytDlpPath, args, { windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new DownloadError(
          '⏱️ Скачивание заняло слишком много времени и было прервано.',
          new Error(`${purpose} timed out after ${config.downloadTimeoutMs}ms`),
        ),
      );
    }, config.downloadTimeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Most common cause: binary not found on PATH.
      if (err.code === 'ENOENT') {
        reject(
          new DownloadError(
            '⚙️ Не найден yt-dlp на сервере. Обратитесь к администратору бота.',
            err,
          ),
        );
      } else {
        reject(new DownloadError('❌ Внутренняя ошибка при запуске загрузчика.', err));
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        // Always surface the raw yt-dlp failure at the source, so it's logged
        // even if a downstream handler swallows or remaps the error.
        console.error(`[${purpose}] yt-dlp exited ${code}:\n${stderr.trim()}`);
        reject(mapYtDlpError(stderr, code));
      }
    });
  });
}

/**
 * Turn a raw yt-dlp stderr into a friendly DownloadError.
 * @param {string} stderr
 * @param {number} code
 */
function mapYtDlpError(stderr, code) {
  const s = stderr.toLowerCase();
  const tech = new Error(`yt-dlp exited with code ${code}: ${stderr.trim()}`);

  if (s.includes('private video') || s.includes('login required') || s.includes('sign in')) {
    return new DownloadError('🔒 Это видео приватное или требует входа в аккаунт.', tech);
  }
  if (s.includes('video unavailable') || s.includes('not available') || s.includes('removed')) {
    return new DownloadError('🚫 Видео недоступно или было удалено.', tech);
  }
  if (s.includes('geo') && (s.includes('block') || s.includes('restrict'))) {
    return new DownloadError('🌍 Видео заблокировано в регионе сервера.', tech);
  }
  if (s.includes('rehydration') || s.includes('universal data')) {
    return new DownloadError(
      '⚠️ TikTok временно не отдал данные о видео. Попробуйте прислать ссылку ещё раз.',
      tech,
      { retriable: true },
    );
  }
  if (s.includes('age') && s.includes('confirm')) {
    return new DownloadError('🔞 Видео с возрастным ограничением — скачать не получилось.', tech);
  }
  if (s.includes('nsig') || s.includes('throttl') || s.includes('failed to extract') || s.includes('player')) {
    return new DownloadError(
      '⚠️ YouTube временно ограничивает загрузку (throttling). Попробуйте позже или обновите yt-dlp.',
      tech,
      { retriable: true },
    );
  }
  if (s.includes('timed out') || s.includes('connection reset') || s.includes('temporary failure')) {
    return new DownloadError('🌐 Временная сетевая ошибка. Попробуйте ещё раз.', tech, {
      retriable: true,
    });
  }
  if (s.includes('unsupported url') || s.includes('unable to extract')) {
    return new DownloadError('🤷 Не удалось распознать или обработать эту ссылку.', tech);
  }

  return new DownloadError('❌ Не удалось скачать видео. Попробуйте другую ссылку.', tech);
}

/**
 * Fetch metadata as JSON (no download).
 * @param {string} url
 * @returns {Promise<object>}
 */
export async function getInfo(url) {
  const { stdout } = await runYtDlp(
    ['--no-warnings', '--no-playlist', '--dump-single-json', url],
    'getInfo',
  );
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new DownloadError('🤷 Не удалось получить информацию о видео.', err);
  }
}

/**
 * Decide whether a TikTok post is a photo slideshow and return image URLs.
 * Relies on yt-dlp metadata: photo posts have image-only "formats".
 * @param {object} info
 * @returns {string[]} image URLs (empty if it's a normal video)
 */
export function extractSlideshowImages(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];

  const hasVideo = formats.some(
    (f) => f.vcodec && f.vcodec !== 'none' && (f.height || f.width),
  );
  if (hasVideo) return [];

  const images = [];
  for (const f of formats) {
    const ext = (f.ext || '').toLowerCase();
    if (IMAGE_EXTS.has(ext) && f.url) images.push(f.url);
  }

  // Some yt-dlp versions expose slideshow frames as thumbnails instead.
  if (images.length === 0 && Array.isArray(info.thumbnails)) {
    for (const t of info.thumbnails) {
      if (t.url) images.push(t.url);
    }
  }

  return images;
}

/**
 * Build a unique output path template inside the temp dir.
 * yt-dlp fills in the real extension; we resolve it afterwards.
 */
function makeOutputTemplate() {
  const id = randomUUID();
  return {
    id,
    template: path.join(config.tempDir, `${id}.%(ext)s`),
  };
}

/**
 * Find the single file produced for a given UUID prefix.
 * @param {string} id
 * @returns {Promise<string|null>} absolute path or null
 */
async function findOutputFile(id) {
  const entries = await readdir(config.tempDir);
  const match = entries.find((name) => name.startsWith(id));
  return match ? path.join(config.tempDir, match) : null;
}

/**
 * Download a video at a given yt-dlp format string. Merges to mp4 via ffmpeg.
 * @param {string} url
 * @param {string} format yt-dlp -f expression
 * @returns {Promise<{ path: string, size: number, title: string }>}
 */
export async function downloadVideo(url, format) {
  const { id, template } = makeOutputTemplate();

  await runYtDlp(
    [
      '--no-warnings',
      '--no-playlist',
      '-f',
      format,
      '--merge-output-format',
      'mp4',
      '--ffmpeg-location',
      config.ffmpegPath,
      '-o',
      template,
      url,
    ],
    'downloadVideo',
  );

  const file = await findOutputFile(id);
  if (!file) {
    throw new DownloadError('❌ Файл не был создан после загрузки.', new Error('output missing'));
  }
  const { size } = await stat(file);
  return { path: file, size, title: id };
}

/**
 * Download audio only and convert to mp3.
 * @param {string} url
 * @returns {Promise<{ path: string, size: number }>}
 */
export async function downloadAudioMp3(url) {
  const { id, template } = makeOutputTemplate();

  await runYtDlp(
    [
      '--no-warnings',
      '--no-playlist',
      '-f',
      'bestaudio/best',
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '--ffmpeg-location',
      config.ffmpegPath,
      '-o',
      template,
      url,
    ],
    'downloadAudioMp3',
  );

  const file = await findOutputFile(id);
  if (!file) {
    throw new DownloadError('❌ Аудиофайл не был создан.', new Error('output missing'));
  }
  const { size } = await stat(file);
  return { path: file, size };
}

/**
 * Best-effort delete of a temp file. Never throws.
 * @param {string|null|undefined} filePath
 */
export async function cleanup(filePath) {
  if (!filePath) return;
  try {
    await rm(filePath, { force: true });
  } catch (err) {
    console.error('[cleanup] failed to remove', filePath, err);
  }
}
