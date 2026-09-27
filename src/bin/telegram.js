#!/usr/bin/env node
import { Hub } from '../core.js';
import { createRouter } from '../bridges/commands.js';
import { createTelegram } from '../bridges/telegram.js';

/**
 * Runs the Telegram bridge against the same SQLite room the agents use.
 * Safe to run alongside serve.js — they are separate processes sharing the file.
 */

const token = process.env.ESPRITS_TELEGRAM_TOKEN;
if (!token) {
  process.stderr.write(
    'ESPRITS_TELEGRAM_TOKEN is not set.\n\n' +
      'Get one from @BotFather on Telegram (/newbot), then:\n' +
      '  export ESPRITS_TELEGRAM_TOKEN=123456:ABC...\n' +
      '  export ESPRITS_PAIR_CODE=$(openssl rand -hex 8)\n' +
      '  npm run telegram\n\n' +
      'Then message your bot: /pair <that code>\n',
  );
  process.exit(1);
}

const pairCode = process.env.ESPRITS_PAIR_CODE ?? '';
if (!pairCode) {
  // Without a code nothing can pair, so the bridge would run but be inert.
  process.stderr.write('ESPRITS_PAIR_CODE is not set — no chat would be able to pair. Refusing to start.\n');
  process.exit(1);
}

const hub = new Hub({ dbPath: process.env.ESPRITS_DB });
const router = createRouter({ hub, pairCode, defaultHandle: process.env.ESPRITS_HUMAN ?? '' });
const bridge = createTelegram({ hub, router, token });

const shutdown = () => {
  bridge.stop();
  try { hub.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.stdout.write(`esprits telegram bridge — db ${hub.db.name}\nPair with: /pair ${pairCode}\n`);
await bridge.run();
