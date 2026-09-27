import { chmodSync } from 'node:fs';

/**
 * Configuration and secrets, stored in the room's own database so the setup
 * page can write them without a config file or a restart.
 *
 * Two rules hold everywhere:
 *
 *  - An environment variable always wins over a stored value. Anyone already
 *    running this from a shell or a systemd unit keeps that behaviour, and a
 *    stored key can never silently override the deployment's own config.
 *  - A secret is never returned. Every read path that feeds a browser goes
 *    through `describe()`, which reports only whether a value is set, where it
 *    came from, and its last four characters.
 */

/** Non-secret settings: safe to display in full. */
export const SETTINGS = {
  claude_enabled: { env: 'ESPRITS_CLAUDE_ENABLED', default: 'false', label: 'Talk to Claude in the chat' },
  claude_agent_name: { env: 'ESPRITS_CLAUDE_AGENT', default: 'claude', label: 'Name Claude appears under' },
  claude_role: { env: 'ESPRITS_CLAUDE_ROLE', default: 'architect', label: "Claude's role in the room" },
  claude_model: { env: 'ESPRITS_CLAUDE_MODEL', default: 'claude-opus-5', label: 'Model' },
  claude_effort: { env: 'ESPRITS_CLAUDE_EFFORT', default: 'high', label: 'Effort (low → max)' },
  claude_max_tokens: { env: 'ESPRITS_CLAUDE_MAX_TOKENS', default: '64000', label: 'Max output tokens' },
  telegram_enabled: { env: 'ESPRITS_TELEGRAM_ENABLED', default: 'false', label: 'Telegram bridge' },
  human_handle: { env: 'ESPRITS_HUMAN', default: '', label: 'Your handle' },
};

/** Secrets: write-only from the outside. */
export const SECRETS = {
  anthropic_api_key: {
    env: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    hint: 'From console.anthropic.com. Needed for the Claude participant.',
  },
  telegram_token: {
    env: 'ESPRITS_TELEGRAM_TOKEN',
    label: 'Telegram bot token',
    hint: 'From @BotFather on Telegram (/newbot).',
  },
  pair_code: {
    env: 'ESPRITS_PAIR_CODE',
    label: 'Telegram pairing code',
    hint: 'Your phone sends /pair <this> once. Treat it like a password.',
  },
};

const mask = (v) => (!v ? null : v.length <= 8 ? `${'•'.repeat(v.length)}` : `${'•'.repeat(8)}${v.slice(-4)}`);

export function createConfig(db) {
  const read = (table, k) => db.prepare(`SELECT v FROM ${table} WHERE k = ?`).get(k)?.v ?? null;

  const write = (table, k, v) => {
    const ts = new Date().toISOString();
    if (v === null || v === undefined || v === '') {
      db.prepare(`DELETE FROM ${table} WHERE k = ?`).run(k);
      return null;
    }
    db.prepare(
      `INSERT INTO ${table} (k, v, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    ).run(k, String(v), ts);
    return String(v);
  };

  /**
   * The database now holds API keys, so tighten it to owner-only. Best effort:
   * a filesystem that cannot represent the mode (a Windows volume, a bind
   * mount) must not stop the server booting.
   */
  const protectDb = () => {
    try {
      if (db.name && db.name !== ':memory:') chmodSync(db.name, 0o600);
    } catch {
      /* not fatal — the file may be on a filesystem without POSIX modes */
    }
  };

  return {
    /** A setting's effective value: env first, then stored, then the default. */
    get(key) {
      const def = SETTINGS[key];
      if (!def) throw new Error(`unknown setting ${key}`);
      const fromEnv = process.env[def.env];
      if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
      return read('settings', key) ?? def.default;
    },

    bool(key) {
      return /^(1|true|yes|on)$/i.test(String(this.get(key)));
    },

    int(key) {
      const n = Number.parseInt(this.get(key), 10);
      return Number.isFinite(n) ? n : Number.parseInt(SETTINGS[key].default, 10);
    },

    set(key, value) {
      if (!SETTINGS[key]) throw new Error(`unknown setting ${key}`);
      return write('settings', key, value);
    },

    /**
     * The real secret. Only the server's own code calls this — never a route
     * that returns its result to a client.
     */
    secret(key) {
      const def = SECRETS[key];
      if (!def) throw new Error(`unknown secret ${key}`);
      const fromEnv = process.env[def.env];
      if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
      return read('secrets', key);
    },

    setSecret(key, value) {
      if (!SECRETS[key]) throw new Error(`unknown secret ${key}`);
      const written = write('secrets', key, value === null ? null : String(value).trim());
      protectDb();
      return written;
    },

    /** Everything the setup page is allowed to know. */
    describe() {
      const settings = {};
      for (const [k, def] of Object.entries(SETTINGS)) {
        const fromEnv = process.env[def.env];
        const overridden = fromEnv !== undefined && fromEnv !== '';
        settings[k] = {
          label: def.label,
          value: this.get(k),
          default: def.default,
          env: def.env,
          // A field the environment controls must be shown as read-only, or the
          // setup page would appear to save a value that has no effect.
          source: overridden ? 'env' : read('settings', k) !== null ? 'stored' : 'default',
          locked: overridden,
        };
      }

      const secrets = {};
      for (const [k, def] of Object.entries(SECRETS)) {
        const fromEnv = process.env[def.env];
        const overridden = fromEnv !== undefined && fromEnv !== '';
        const stored = read('secrets', k);
        const effective = overridden ? fromEnv : stored;
        secrets[k] = {
          label: def.label,
          hint: def.hint,
          env: def.env,
          set: Boolean(effective),
          preview: mask(effective),
          source: overridden ? 'env' : stored ? 'stored' : 'unset',
          locked: overridden,
        };
      }
      return { settings, secrets };
    },
  };
}
