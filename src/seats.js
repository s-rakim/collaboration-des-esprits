/**
 * The roster of model seats: which of your models are in the chat.
 *
 * Separate from settings because this is a list the user edits, not a set of
 * fixed keys — the whole point is that the room can be you plus Opus, Sonnet and
 * Haiku, not you plus one assistant.
 */

import { providerFor, PROVIDERS } from './participants/providers/index.js';

/**
 * What a fresh install starts with: a room that already disagrees with itself,
 * switched off until credentials are added. Different providers on purpose —
 * two models from the same family agree too readily to be worth the tokens.
 */
export const STARTER_SEATS = [
  { name: 'opus', provider: 'anthropic', model: 'claude-opus-5', role: 'architect', effort: 'high' },
  { name: 'sonnet', provider: 'anthropic', model: 'claude-sonnet-5', role: 'critic', effort: 'high' },
];

const VALID_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

export function createSeats(db) {
  const mask = (v) => (!v ? null : v.length <= 8 ? '•'.repeat(v.length) : `${'•'.repeat(8)}${v.slice(-4)}`);

  /**
   * The seat as everything except the credential. `api_key` is deliberately not
   * carried through: this is the shape the HTTP layer returns, so the key cannot
   * leak by somebody forgetting to strip it at the route.
   */
  const row = (r) => {
    const provider = providerFor(r.provider);
    const fromEnv = process.env[provider.keyEnv];
    const effective = r.api_key || (fromEnv || null);
    return {
      name: r.name,
      provider: r.provider,
      model: r.model,
      role: r.role,
      effort: r.effort,
      maxTokens: r.max_tokens,
      baseURL: r.base_url || '',
      enabled: Boolean(r.enabled),
      keySet: Boolean(effective) || Boolean(provider.keyOptional),
      keyPreview: mask(r.api_key) ?? (fromEnv ? `from ${provider.keyEnv}` : null),
      keySource: r.api_key ? 'stored' : fromEnv ? 'env' : 'unset',
    };
  };

  return {
    all() {
      return db.prepare('SELECT * FROM participants ORDER BY created_at, name').all().map(row);
    },

    enabled() {
      return this.all().filter((s) => s.enabled);
    },

    get(name) {
      const r = db.prepare('SELECT * FROM participants WHERE name = ?').get(String(name));
      return r ? row(r) : null;
    },

    /**
     * The seat's real credential, for the server's own use only. Falls back to
     * the provider's conventional environment variable, so a shell-configured
     * key keeps working without being re-entered per seat.
     */
    keyFor(name) {
      const r = db.prepare('SELECT provider, api_key FROM participants WHERE name = ?').get(String(name));
      if (!r) return null;
      return r.api_key || process.env[providerFor(r.provider).keyEnv] || null;
    },

    /**
     * Add or update a seat. The name is the room handle, so it has to obey the
     * same rule as any other agent: no spaces, because it is an @mention.
     */
    save({
      name, model, provider = 'anthropic', role = 'generalist', effort = 'high',
      maxTokens = 64000, enabled = true, apiKey = undefined, baseURL = undefined,
    }) {
      const handle = String(name ?? '').trim();
      if (!handle) throw new Error('a seat needs a name');
      if (/\s/.test(handle)) throw new Error('a name cannot contain spaces — it is used for @mentions');
      if (!String(model ?? '').trim()) throw new Error('a seat needs a model');
      if (!PROVIDERS[provider]) throw new Error(`unknown provider "${provider}"`);
      const eff = VALID_EFFORT.includes(String(effort)) ? String(effort) : 'high';
      const tokens = Number.isFinite(Number(maxTokens)) ? Math.max(1024, Number(maxTokens)) : 64000;

      const existing = db.prepare('SELECT api_key, base_url FROM participants WHERE name = ?').get(handle);
      // undefined means "leave the stored key alone" — the setup page sends the
      // field only when it was edited, so re-saving a row cannot wipe its key.
      // An empty string is an explicit clear.
      const key = apiKey === undefined ? (existing?.api_key ?? null) : String(apiKey).trim() || null;
      const url = baseURL === undefined ? (existing?.base_url ?? null) : String(baseURL).trim() || null;

      db.prepare(
        `INSERT INTO participants
           (name, provider, model, role, effort, max_tokens, api_key, base_url, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           provider = excluded.provider, model = excluded.model, role = excluded.role,
           effort = excluded.effort, max_tokens = excluded.max_tokens,
           api_key = excluded.api_key, base_url = excluded.base_url, enabled = excluded.enabled`,
      ).run(handle, provider, String(model).trim(), String(role), eff, tokens, key, url,
            enabled ? 1 : 0, new Date().toISOString());
      return this.get(handle);
    },

    remove(name) {
      // Only the seat is removed. The agent's history, decisions and scores stay
      // in the room — deleting what somebody contributed because they left would
      // lose the reasoning behind decisions that still stand.
      const info = db.prepare('DELETE FROM participants WHERE name = ?').run(String(name));
      return info.changes > 0;
    },

    /**
     * Seed the starter roster, once. Seats arrive switched off, because nothing
     * should try to reach a provider before a key exists for it.
     */
    seedIfEmpty() {
      if (db.prepare('SELECT COUNT(*) AS n FROM participants').get().n > 0) return [];
      return STARTER_SEATS.map((s) => this.save({ ...s, enabled: false }));
    },
  };
}
