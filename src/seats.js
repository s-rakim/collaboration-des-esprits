/**
 * The seats: which models are in the chat.
 *
 * A seat is a name, a role, and a pointer at a connection plus a model string.
 * The model is free text on purpose — provider catalogues change weekly, and a
 * model released tomorrow should need no change here. Whatever the endpoint
 * accepts, you can type.
 */

const VALID_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * What a fresh install starts with: a room that already disagrees with itself,
 * left unconfigured until connections exist to point it at.
 */
export const STARTER_SEATS = [
  { name: 'architect', role: 'architect', effort: 'high' },
  { name: 'critic', role: 'critic', effort: 'high' },
];

export function createSeats(db, connections) {
  const view = (r) => {
    const conn = connections?.get?.(r.connection) ?? null;
    return {
      name: r.name,
      connection: r.connection ?? null,
      model: r.model,
      role: r.role,
      effort: r.effort,
      maxTokens: r.max_tokens,
      enabled: Boolean(r.enabled),
      // A seat is only runnable when its connection exists and has a key.
      ready: Boolean(conn?.keySet),
      connectionMissing: Boolean(r.connection) && !conn,
      baseURL: conn?.baseURL ?? '',
    };
  };

  return {
    all() {
      return db.prepare('SELECT * FROM participants ORDER BY created_at, name').all().map(view);
    },

    /** Seats that are switched on AND actually able to run. */
    enabled() {
      return this.all().filter((s) => s.enabled && s.ready);
    },

    get(name) {
      const r = db.prepare('SELECT * FROM participants WHERE name = ?').get(String(name));
      return r ? view(r) : null;
    },

    /** The credential for this seat, which lives on its connection. */
    keyFor(name) {
      const r = db.prepare('SELECT connection FROM participants WHERE name = ?').get(String(name));
      return r?.connection ? connections.keyFor(r.connection) : null;
    },

    /** Everything the participant needs to make a call. */
    resolve(name) {
      const seat = this.get(name);
      if (!seat?.connection) return null;
      const conn = connections.resolve(seat.connection);
      if (!conn) return null;
      return {
        ...seat,
        // A seat may override the connection's default model, or inherit it.
        model: seat.model || conn.model,
        baseURL: conn.baseURL,
        apiKey: conn.apiKey,
        effortParam: conn.extra?.effortParam ?? null,
        // What this endpoint calls the length limit. Wrong, it is ignored
        // rather than refused, so no cap applies and a reasoning model writes
        // until its own default — which reads as the endpoint hanging.
        tokenParam: conn.extra?.tokenParam ?? null,
        // Which request language this endpoint speaks. Discovered by find/test
        // rather than guessed, because two of the routers listen on the same
        // port as shipped and only one of them has /chat/completions.
        shape: conn.extra?.shape ?? null,
      };
    },

    save({ name, connection = null, model = '', role = 'generalist', effort = 'high', maxTokens = 64000, enabled = true }) {
      const handle = String(name ?? '').trim();
      if (!handle) throw new Error('a seat needs a name');
      if (/\s/.test(handle)) throw new Error('a name cannot contain spaces — it is used for @mentions');
      if (connection && !connections.get(connection)) throw new Error(`no connection named "${connection}"`);

      const eff = VALID_EFFORT.includes(String(effort)) ? String(effort) : 'high';
      const tokens = Number.isFinite(Number(maxTokens)) ? Math.max(1024, Number(maxTokens)) : 64000;

      db.prepare(
        `INSERT INTO participants
           (name, connection, model, role, effort, max_tokens, enabled, created_at, provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
         ON CONFLICT(name) DO UPDATE SET
           connection = excluded.connection, model = excluded.model, role = excluded.role,
           effort = excluded.effort, max_tokens = excluded.max_tokens, enabled = excluded.enabled`,
      ).run(handle, connection, String(model).trim(), String(role), eff, tokens,
            enabled ? 1 : 0, new Date().toISOString());
      return this.get(handle);
    },

    remove(name) {
      // Only the seat goes. Everything that model said, decided or scored stays
      // — deleting the reasoning behind a live decision because its author left
      // would be worse than keeping it.
      return db.prepare('DELETE FROM participants WHERE name = ?').run(String(name)).changes > 0;
    },

    seedIfEmpty() {
      if (db.prepare('SELECT COUNT(*) AS n FROM participants').get().n > 0) return [];
      return STARTER_SEATS.map((s) => this.save({ ...s, enabled: false }));
    },
  };
}
