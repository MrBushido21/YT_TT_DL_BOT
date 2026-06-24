import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { Bot, GrammyError, HttpError } from 'grammy';
import { config } from './src/config.js';
import {
  registerCommands,
  registerMessageHandler,
  registerCallbackHandler,
} from './src/handlers.js';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Make sure the temp/download directory exists before we start.
await mkdir(config.tempDir, { recursive: true });

const bot = new Bot(token);

registerCommands(bot);
registerMessageHandler(bot);
registerCallbackHandler(bot);

// Central error boundary: nothing should crash the bot.
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[bot error] update ${ctx?.update?.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error('Telegram API error:', e.description);
  } else if (e instanceof HttpError) {
    console.error('Could not reach Telegram:', e);
  } else {
    console.error('Unexpected error:', e);
  }
});

// Show command hints in the Telegram UI.
await bot.api.setMyCommands([
  { command: 'start', description: 'Запустить бота' },
  { command: 'help', description: 'Как пользоваться' },
]);

// Graceful shutdown.
const stop = () => bot.stop();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

console.log('🤖 Bot is starting…');
bot.start({
  onStart: (info) => console.log(`✅ Running as @${info.username}`),
});
