import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { InputFile, InlineKeyboard, InputMediaBuilder } from 'grammy';
import { config } from './config.js';
import { extractUrl, detectPlatform } from './url.js';
import { enqueue, queuePosition } from './queue.js';
import {
  getInfo,
  downloadVideo,
  downloadAudioMp3,
  extractSlideshowImages,
  cleanup,
  DownloadError,
} from './downloader.js';

/**
 * Pending YouTube requests awaiting a quality choice.
 * token -> { url, ts }. Tokens expire so the map can't grow forever.
 */
const pending = new Map();
const PENDING_TTL_MS = 15 * 60 * 1000;

function rememberUrl(url) {
  const token = randomUUID().slice(0, 8);
  pending.set(token, { url, ts: Date.now() });
  return token;
}

function recallUrl(token) {
  const entry = pending.get(token);
  if (!entry) return null;
  if (Date.now() - entry.ts > PENDING_TTL_MS) {
    pending.delete(token);
    return null;
  }
  return entry.url;
}

// Periodically sweep expired tokens.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (now - entry.ts > PENDING_TTL_MS) pending.delete(token);
  }
}, PENDING_TTL_MS).unref();

const MB = 1024 * 1024;
const fmtMb = (bytes) => (bytes / MB).toFixed(1);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerCommands(bot) {
  bot.command('start', (ctx) =>
    ctx.reply(
      '👋 Привет! Я скачиваю видео с YouTube и TikTok.\n\n' +
        '• Просто пришли мне ссылку.\n' +
        '• Для YouTube я спрошу качество.\n' +
        '• TikTok скачаю сразу и без водяного знака.\n\n' +
        'Подробнее — /help',
    ),
  );

  bot.command('help', (ctx) =>
    ctx.reply(
      'ℹ️ Как пользоваться:\n\n' +
        '1. Пришли ссылку на видео (YouTube или TikTok).\n' +
        '2. Для YouTube выбери качество кнопками: 360p / 720p / 1080p / MP3.\n' +
        '3. TikTok скачается сразу (видео — без водяного знака, слайдшоу — как набор фото).\n\n' +
        `⚠️ Лимит Telegram — 50 МБ. Если файл больше, я попробую качество пониже, ` +
        'а если не помещается совсем — честно скажу об этом.',
    ),
  );
}

// ---------------------------------------------------------------------------
// Incoming text → URL routing
// ---------------------------------------------------------------------------

export function registerMessageHandler(bot) {
  bot.on('message:text', async (ctx) => {
    const url = extractUrl(ctx.message.text);
    if (!url) {
      await ctx.reply('🔗 Пришли, пожалуйста, корректную ссылку (http/https) на видео.');
      return;
    }

    const platform = detectPlatform(url);

    if (platform === 'youtube') {
      const token = rememberUrl(url);
      const keyboard = new InlineKeyboard()
        .text('360p', `yt:360:${token}`)
        .text('720p', `yt:720:${token}`)
        .row()
        .text('1080p', `yt:1080:${token}`)
        .text('🎵 MP3', `yt:mp3:${token}`);

      await ctx.reply('🎬 Выбери качество:', { reply_markup: keyboard });
      return;
    }

    if (platform === 'tiktok') {
      await handleTikTok(ctx, url);
      return;
    }

    await ctx.reply('🤷 Поддерживаются только ссылки на YouTube и TikTok.');
  });
}

// ---------------------------------------------------------------------------
// Inline button → YouTube download
// ---------------------------------------------------------------------------

export function registerCallbackHandler(bot) {
  bot.callbackQuery(/^yt:(360|720|1080|mp3):(.+)$/, async (ctx) => {
    const [, choice, token] = ctx.match;
    const url = recallUrl(token);

    await ctx.answerCallbackQuery();

    if (!url) {
      await ctx.editMessageText('⌛ Эта кнопка устарела. Пришли ссылку заново.').catch(() => {});
      return;
    }

    // Remove the keyboard so it can't be tapped twice.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

    if (choice === 'mp3') {
      await handleYouTubeAudio(ctx, url);
    } else {
      await handleYouTubeVideo(ctx, url, choice);
    }
  });
}

// ---------------------------------------------------------------------------
// Download flows
// ---------------------------------------------------------------------------

async function handleYouTubeVideo(ctx, url, startQuality) {
  const status = await ctx.reply(progressText('🎬 Видео'));

  try {
    const result = await enqueue(() => downloadVideoWithFallback(url, startQuality));

    if (!result) {
      await editStatus(
        ctx,
        status,
        `📦 Видео слишком большое для Telegram (лимит ${fmtMb(config.maxFileSizeBytes)} МБ) ` +
          'даже в минимальном качестве. Попробуй более короткое видео или скачай вручную.',
      );
      return;
    }

    await editStatus(ctx, status, `⬆️ Отправляю (${fmtMb(result.size)} МБ)…`);
    await ctx.replyWithVideo(new InputFile(result.path), {
      caption: config.youtubeQualities[result.quality]?.label ?? '',
    });
    await deleteStatus(ctx, status);
    await cleanup(result.path);
  } catch (err) {
    await reportError(ctx, status, err);
  }
}

/**
 * Try the chosen quality; if too big, step down through the fallback order.
 * Returns null if even the smallest quality exceeds the limit.
 */
async function downloadVideoWithFallback(url, startQuality) {
  const order = config.qualityFallbackOrder.filter(
    (q) => Number(q) <= Number(startQuality),
  );
  // Ensure the chosen quality is included even if not in the list.
  if (!order.includes(startQuality)) order.unshift(startQuality);

  let lastFile = null;
  for (const quality of order) {
    // Clean up the previous oversized attempt before trying a smaller one.
    if (lastFile) await cleanup(lastFile);
    lastFile = null;

    const preset = config.youtubeQualities[quality];
    const { path: file, size } = await downloadVideo(url, preset.format);

    if (size <= config.maxFileSizeBytes) {
      return { path: file, size, quality };
    }
    lastFile = file; // too big; remember to delete, then try lower
  }

  if (lastFile) await cleanup(lastFile);
  return null;
}

async function handleYouTubeAudio(ctx, url) {
  const status = await ctx.reply(progressText('🎵 Аудио'));

  let file = null;
  try {
    const result = await enqueue(() => downloadAudioMp3(url));
    file = result.path;

    if (result.size > config.maxFileSizeBytes) {
      await editStatus(
        ctx,
        status,
        `📦 Аудио слишком большое (${fmtMb(result.size)} МБ, лимит ${fmtMb(
          config.maxFileSizeBytes,
        )} МБ).`,
      );
      return;
    }

    await editStatus(ctx, status, `⬆️ Отправляю (${fmtMb(result.size)} МБ)…`);
    await ctx.replyWithAudio(new InputFile(file));
    await deleteStatus(ctx, status);
  } catch (err) {
    await reportError(ctx, status, err);
  } finally {
    await cleanup(file);
  }
}

async function handleTikTok(ctx, url) {
  const status = await ctx.reply(progressText('📥 TikTok'));

  try {
    const result = await enqueue(async () => {
      const info = await getInfo(url);
      const images = detectPlatformIsTikTokSlideshow(info);

      if (images.length > 0) {
        return { type: 'slideshow', images };
      }

      // Normal TikTok video. yt-dlp downloads the no-watermark version by default.
      const video = await downloadVideo(url, 'best');
      return { type: 'video', ...video };
    });

    if (result.type === 'slideshow') {
      await editStatus(ctx, status, `🖼 Слайдшоу: скачиваю ${result.images.length} фото…`);
      await sendSlideshow(ctx, result.images);
      await deleteStatus(ctx, status);
      return;
    }

    if (result.size > config.maxFileSizeBytes) {
      await editStatus(
        ctx,
        status,
        `📦 Видео слишком большое (${fmtMb(result.size)} МБ, лимит ${fmtMb(
          config.maxFileSizeBytes,
        )} МБ).`,
      );
      await cleanup(result.path);
      return;
    }

    await editStatus(ctx, status, `⬆️ Отправляю (${fmtMb(result.size)} МБ)…`);
    await ctx.replyWithVideo(new InputFile(result.path), { caption: 'TikTok (без водяного знака)' });
    await deleteStatus(ctx, status);
    await cleanup(result.path);
  } catch (err) {
    await reportError(ctx, status, err);
  }
}

/** Thin wrapper for readability. */
function detectPlatformIsTikTokSlideshow(info) {
  return extractSlideshowImages(info);
}

/**
 * Download images to temp files and send them as media group(s) of up to 10.
 * @param {import('grammy').Context} ctx
 * @param {string[]} imageUrls
 */
async function sendSlideshow(ctx, imageUrls) {
  await mkdir(config.tempDir, { recursive: true });
  const files = [];

  try {
    for (const imgUrl of imageUrls) {
      const filePath = path.join(config.tempDir, `${randomUUID()}.jpg`);
      const res = await fetch(imgUrl);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(filePath, buf);
      files.push(filePath);
    }

    if (files.length === 0) {
      throw new DownloadError('🖼 Не удалось скачать фото из слайдшоу.', new Error('no images'));
    }

    // Telegram allows at most 10 items per media group.
    for (let i = 0; i < files.length; i += 10) {
      const chunk = files.slice(i, i + 10);
      const media = chunk.map((f) => InputMediaBuilder.photo(new InputFile(f)));
      await ctx.replyWithMediaGroup(media);
    }
  } finally {
    await Promise.all(files.map((f) => cleanup(f)));
  }
}

// ---------------------------------------------------------------------------
// Status message helpers
// ---------------------------------------------------------------------------

function progressText(what) {
  const ahead = queuePosition();
  const queued = ahead > 0 ? ` (в очереди: ${ahead})` : '';
  return `⏳ ${what}: обрабатываю…${queued}`;
}

async function editStatus(ctx, status, text) {
  await ctx.api.editMessageText(status.chat.id, status.message_id, text).catch(() => {});
}

async function deleteStatus(ctx, status) {
  await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});
}

/**
 * Show the user a friendly message; log the full error to the console.
 */
async function reportError(ctx, status, err) {
  const userMessage =
    err instanceof DownloadError
      ? err.userMessage
      : '❌ Что-то пошло не так. Попробуй ещё раз позже.';

  // Full technical detail goes to the server log only.
  console.error('[download error]', err instanceof DownloadError ? err.cause ?? err : err);

  await editStatus(ctx, status, userMessage);
}
