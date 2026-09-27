#!/usr/bin/env node
import { Hub } from '../core.js';
import { createConfig } from '../settings.js';
import { createRouter } from '../bridges/commands.js';
import { createTelegram } from '../bridges/telegram.js';

/**
 * Runs the Telegram bridge against the same SQLite room the agents use.
 * Safe to run alongside serve.js — they are separate processes sharing the file.
 */

const hub = new Hub({ dbPath: process.env.ESPRITS_DB });
const config = createConfig(hub.db);

// Env first, then whatever was saved on the setup page, so either way of
// configuring this works and neither silently loses to the other.
const token = config.secret('telegram_token');
if (!token) {
  process.stderr.write(
    'ESPRITS_TELEGRAM_TOKEN is not set.\n\n' +
      'Set it at http://127.0.0.1:4300/setup, or from a shell:\n\n' +
      'Get one from @BotFather on Telegram (/newbot), then:\n' +
      '  export ESPRITS_TELEGRAM_TOKEN=123456:ABC...\n' +
      '  export ESPRITS_PAIR_CODE=$(openssl rand -hex 8)\n' +
      '  npm run telegram\n\n' +
      'Then message your bot: /pair <that code>\n',
  );
  process.exit(1);
}

const pairCode = config.secret('pair_code') ?? '';
if (!pairCode) {
  // Without a code nothing can pair, so the bridge would run but be inert.
  process.stderr.write(
    'No pairing code set — no chat would be able to pair, so this would run but do nothing.\n' +
      'Set one at /setup, or export ESPRITS_PAIR_CODE. Refusing to start.\n',
  );
  process.exit(1);
}

const router = createRouter({ hub, pairCode, defaultHandle: config.get('human_handle') });
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
