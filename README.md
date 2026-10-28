# tgbotdownloader

Telegram-бот на Node.js, который скачивает видео с **YouTube** и **TikTok**
(TikTok — **без водяного знака**) и отправляет их прямо в чат.

Работает только на свободных инструментах — `yt-dlp` + `ffmpeg`. Никаких платных API.

## Возможности

- Принимает ссылку, валидирует её и определяет платформу (YouTube / TikTok).
- **YouTube:** inline-кнопки выбора качества — `360p / 720p / 1080p / MP3`.
- **TikTok:** скачивает сразу, без водяного знака.
- **TikTok-слайдшоу** (фото вместо видео) — присылает картинки как media group.
- Очередь загрузок с ограничением параллелизма (по умолчанию 2), чтобы бот не зависал.
- Учитывает лимит Telegram в 50 МБ: если файл больше — пробует качество пониже,
  а если всё равно не помещается — честно сообщает об этом.
- Временные файлы получают уникальные имена (`randomUUID`) и удаляются после отправки.
- Понятные сообщения об ошибках (приватное видео, гео-блок, throttling YouTube и т.п.);
  полный стек пишется в консоль.

## Требования

1. **Node.js 18+** (нужен встроенный `fetch`).
2. **yt-dlp** — должен быть в `PATH`.
   - Windows (winget): `winget install yt-dlp.yt-dlp`
   - или scoop: `scoop install yt-dlp`
   - macOS: `brew install yt-dlp`
   - Linux / универсально: `pipx install yt-dlp` или [см. инструкцию](https://github.com/yt-dlp/yt-dlp#installation)
   - **Рекомендуется через pip с дополнениями:** `pip install -U "yt-dlp[default,curl-cffi]"`
     — `curl-cffi` нужен TikTok (имитация браузера), `default` ставит `yt-dlp-ejs`
     (решатель JS-челленджей YouTube; также нужен [Deno](https://deno.com): `winget install DenoLand.Deno`).
   - Проверка: `yt-dlp --version`
3. **ffmpeg** — нужен для склейки видео+аудио.
   - Windows: `winget install Gyan.FFmpeg` или `scoop install ffmpeg`
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`
   - Проверка: `ffmpeg -version`

> Если бинарники лежат не в `PATH`, укажи абсолютные пути в `.env`
> (`YTDLP_PATH`, `FFMPEG_PATH`).

## Установка и запуск

```bash
# 1. зависимости
npm install

# 2. конфиг
cp .env.example .env
# впиши BOT_TOKEN, полученный у @BotFather

# 3. запуск
npm start
# или с авто-перезапуском при правках:
npm run dev
```

После запуска напиши боту `/start` и пришли ссылку.

## Настройки

Всё вынесено в `src/config.js`:

| Параметр | По умолчанию | Описание |
|----------|--------------|----------|
| `maxFileSizeBytes` | 49 МБ | Порог размера (с запасом под лимит Telegram 50 МБ) |
| `concurrency` | 2 | Сколько загрузок идёт одновременно |
| `tempDir` | `./downloads` | Папка для временных файлов (env `TEMP_DIR`) |
| `downloadTimeoutMs` | 5 мин | Таймаут одного вызова yt-dlp |
| `youtubeQualities` | 360/720/1080 | Пресеты качества → формат-строки yt-dlp |

## Структура проекта

```
index.js            — точка входа, регистрация бота и хендлеров
src/config.js       — настройки (лимиты, параллелизм, пути)
src/url.js          — валидация URL и определение платформы
src/downloader.js   — обёртка над yt-dlp (видео/аудио/инфо/слайдшоу)
src/queue.js        — очередь загрузок (p-queue)
src/handlers.js     — обработчики сообщений и inline-кнопок
.env.example        — шаблон конфигурации
```

## Заметки

- TikTok без водяного знака работает «из коробки»: yt-dlp скачивает чистый исходник.
- Если YouTube начал троттлить (`nsig` / `Failed to extract`), обнови yt-dlp:
  `yt-dlp -U` (или переустанови через свой пакетный менеджер) — это самая частая причина.
- Если YouTube пишет «принял сервер за бота» (часто на VPS/хостингах), экспортируй
  `cookies.txt` из браузера, где ты залогинен в YouTube (расширение «Get cookies.txt LOCALLY»),
  и укажи путь в `.env`: `YTDLP_COOKIES=./data/cookies.txt`. Это же позволяет качать 18+ видео.
  Лучше использовать отдельный, не основной Google-аккаунт.
- Лимит 50 МБ — ограничение Bot API, а не бота. Для больших файлов потребовался бы
  локальный Bot API сервер; здесь он не используется.
```
