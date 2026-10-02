import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The schema lives in sql/, not in this file, because two runtimes open this
 * database now and a schema written out twice is a schema that drifts. Whoever
 * reads it second gets a table the first does not have, months later, in a
 * place neither of them is looking.
 */
const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const SCHEMA = readFileSync(join(SQL_DIR, 'schema.sql'), 'utf8');
const FTS = readFileSync(join(SQL_DIR, 'fts.sql'), 'utf8');

/**
 * One SQLite file is the whole shared memory. Every agent process — stdio or
 * HTTP — opens the same file in WAL mode, so several can read while one writes
 * without anybody holding a lock long enough to matter. That is what makes the
 * local case serverless: no daemon need be running for two agent sessions to
 * share context.
 *
 * The model is organised around the IDEA, not around chat. An idea carries its
 * own discussion, its open questions, its locked decisions and its build
 * tasks, because the thing agents need handed to them is all of that at once —
 * not a transcript they have to re-read.
 */



/**
 * Lift the old per-seat endpoint/key columns into named connections, once.
 * Seats configured before connections existed keep working untouched.
 */
function migrateSeatsToConnections(db) {
  const orphans = db
    .prepare(`SELECT * FROM participants WHERE connection IS NULL OR connection = ''`)
    .all();
  if (!orphans.length) return;

  const ts = new Date().toISOString();
  for (const seat of orphans) {
    // One connection per distinct provider, reusing it across seats that shared it.
    const name = seat.provider || 'openai';
    const existing = db.prepare('SELECT name FROM connections WHERE name = ?').get(name);
    if (!existing) {
      db.prepare(
        `INSERT INTO connections (name, kind, base_url, api_key, model, extra, created_at)
         VALUES (?, 'chat', ?, ?, '', '{}', ?)`,
      ).run(name, seat.base_url ?? '', seat.api_key ?? null, ts);
    } else if (seat.api_key) {
      // Fill in a key only where the connection has none, so the first seat
      // that carried one wins rather than the last.
      db.prepare(`UPDATE connections SET api_key = COALESCE(api_key, ?) WHERE name = ?`)
        .run(seat.api_key, name);
    }
    db.prepare('UPDATE participants SET connection = ? WHERE name = ?').run(name, seat.name);
  }
}

/** Env wins, so every agent's config can point at the one shared file. */
export function resolveDbPath(explicit) {
  const p = explicit || process.env.ESPRITS_DB || './data/esprits.sqlite';
  return p === ':memory:' ? p : resolve(p);
}

/**
 * A small compatibility layer over node:sqlite.
 *
 * The rest of the project was written against better-sqlite3's surface, and
 * node:sqlite covers nearly all of it already — prepare/get/all/run/exec are
 * the same shapes, and it returns plain numbers rather than BigInt. Only two
 * things are missing, so they are provided here rather than rewriting every
 * call site.
 *
 * The reason for using the built-in module at all: better-sqlite3 is a native
 * addon, and when no prebuilt binary matches the running Node version it falls
 * back to compiling from source — which on Windows means a C++ toolchain and a
 * Python install before the project will even start. The built-in module has no
 * build step and cannot drift out of step with the Node it ships in.
 */
function wrap(db, file) {
  // Nesting depth, so a transaction opened inside another becomes a savepoint
  // rather than a second BEGIN, which SQLite rejects.
  let depth = 0;

  db.pragma = (statement) => {
    const [name] = String(statement).split(/\s*=\s*/);
    db.exec(`PRAGMA ${statement}`);
    // Read the value back so callers can check what actually took effect; a
    // PRAGMA that returns nothing simply yields undefined.
    try {
      return db.prepare(`PRAGMA ${name.trim()}`).get();
    } catch {
      return undefined;
    }
  };

  db.transaction = (fn) =>
    (...args) => {
      const nested = depth > 0;
      const savepoint = `sp_${depth}`;
      db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      depth += 1;
      try {
        const out = fn(...args);
        db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return out;
      } catch (err) {
        // Roll back only as far as this level, so an inner failure the caller
        // catches does not silently discard the outer transaction's work.
        try {
          db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        } catch {
          /* the transaction was already unwound */
        }
        throw err;
      } finally {
        depth -= 1;
      }
    };

  // better-sqlite3 exposed the file path here, and several callers print it or
  // tighten the file's permissions with it.
  db.name = file;
  return db;
}

export function openDb(path) {
  const file = resolveDbPath(path);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = wrap(new DatabaseSync(file), file);

  db.pragma('journal_mode = WAL');
  // Several agents writing at once is the normal case here, not the exception:
  // wait for the writer rather than throwing SQLITE_BUSY at an agent mid-turn.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec(SCHEMA);

  // CREATE TABLE IF NOT EXISTS will not add a column to a table that already
  // exists, so columns introduced after the first release are applied here.
  // Each is idempotent: the column is added only when table_info lacks it.
  const addColumn = (table, column, decl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.length) return; // table not created yet; SCHEMA will cover it
    if (cols.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  };
  addColumn('agents', 'last_spoke_at', 'TEXT');
  addColumn('participants', 'provider', "TEXT NOT NULL DEFAULT 'openai'");
  addColumn('participants', 'api_key', 'TEXT');
  addColumn('participants', 'base_url', 'TEXT');
  addColumn('participants', 'connection', 'TEXT');
  addColumn('ideas', 'project_id', 'INTEGER');

  // Seats used to carry their own endpoint and key. Anything configured that
  // way is lifted into a connection once, so the two never disagree.
  migrateSeatsToConnections(db);

  // FTS5 ships in Node's bundled SQLite, but a future build could drop it.
  // Search falls back to LIKE rather than the whole connector refusing to start.
  let fts = true;
  try {
    db.exec(FTS);
  } catch {
    fts = false;
  }
  db.hasFts = fts;

  return db;
}
