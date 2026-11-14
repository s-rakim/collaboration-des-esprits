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

    /**
     * Give every chat key a seat.
     *
     * Adding a key and adding an agent used to be two steps on two parts of a
     * long page, and the second was easy to never find: the keys saved, the
     * tests passed, and the room stayed silent because nothing was sitting on
     * them. A key somebody has added for chat is a model they want in the
     * chat, so it gets a seat, named after the connection — the name they
     * chose, and the one they will type after an @.
     *
     * Once per connection: `done` is the list of those already handled, so a
     * seat somebody then removes stays removed.
     */
    follow(done = []) {
      const handled = new Set(done);
      const made = [];
      const chat = db.prepare(`SELECT name FROM connections WHERE kind = 'chat' ORDER BY created_at, name`).all();
      for (const { name: connection } of chat) {
        if (handled.has(connection)) continue;
        if (!connections.get(connection)?.keySet) continue;      // no key yet: come back when there is one
        handled.add(connection);
        if (db.prepare('SELECT 1 FROM participants WHERE connection = ?').get(connection)) continue;

        const handle = connection.trim().replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
        if (!handle || this.get(handle)) continue;               // that name is somebody else's seat already

        // The seats a new room starts with are roles waiting for a model. The
        // first keys take those roles over, so two keys still give a room that
        // disagrees with itself rather than two generalists.
        const waiting = STARTER_SEATS
          .map((x) => db.prepare('SELECT name, role, effort, connection, enabled FROM participants WHERE name = ?').get(x.name))
          // Waiting means never set up: switched off, and on no connection — or
          // on one with no key, which is where an older version left them.
          .find((row) => row && !row.enabled && !(row.connection && connections.get(row.connection)?.keySet));
        if (waiting) {
          this.remove(waiting.name);
          // And the empty connection that came with it, if nothing else uses it.
          const left = waiting.connection ? connections.get(waiting.connection) : null;
          if (left && !left.keySet && !left.baseURL && !left.model
              && !db.prepare('SELECT 1 FROM participants WHERE connection = ?').get(waiting.connection)) {
            try { connections.remove(waiting.connection); } catch { /* in use after all */ }
          }
        }
        this.save({ name: handle, connection, role: waiting?.role ?? 'generalist', effort: waiting?.effort ?? 'high', enabled: true });
        made.push(handle);
      }
      return { made, done: [...handled] };
    },

    seedIfEmpty() {
      if (db.prepare('SELECT COUNT(*) AS n FROM participants').get().n > 0) return [];
      return STARTER_SEATS.map((s) => this.save({ ...s, enabled: false }));
    },
  };
}
