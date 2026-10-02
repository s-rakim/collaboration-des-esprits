"""
One SQLite file is the whole shared memory.

Every process that joins the room — the web server, a stdio connector, the
Telegram bridge — opens the same file in WAL mode, so several can read while one
writes without anybody holding a lock long enough to matter. That is what makes
the local case serverless: no daemon need be running for two sessions to share
context.

The model is organised around the IDEA, not around chat. An idea carries its own
discussion, its open questions, its locked decisions and its build tasks,
because the thing agents need handed to them is all of that at once, not a
transcript they have to re-read.

The schema itself is in ``sql/`` beside this package rather than written out
here. Two runtimes open this database now, and a schema spelled out twice is a
schema that drifts: whoever reads it second gets a table the first does not
have, months later, in a place neither of them is looking. One file, both
readers.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

# python/esprits/db.py -> python/esprits -> python -> the project
SQL_DIR = Path(__file__).resolve().parent.parent.parent / "sql"

DEFAULT_DB = "./data/esprits.sqlite"


def resolve_db_path(explicit: str | os.PathLike[str] | None = None) -> str:
    """Where the room's memory lives, by the same rule the Node side uses."""
    raw = str(explicit or os.environ.get("ESPRITS_DB") or DEFAULT_DB)
    return raw if raw == ":memory:" else str(Path(raw).resolve())


class Database:
    """
    A thin layer over :mod:`sqlite3` with the two things the room needs.

    Rows come back as mappings, because code that reads ``row["author"]`` says
    what it means and survives a column being added in front of it. And
    ``transaction()`` nests: a transaction opened inside another becomes a
    savepoint rather than a second BEGIN, which SQLite rejects. An inner failure
    the caller catches then rolls back only its own level, instead of silently
    discarding the outer transaction's work.
    """

    def __init__(self, conn: sqlite3.Connection, name: str) -> None:
        self._conn = conn
        self.name = name
        self.has_fts = False
        # Nesting depth is per-thread because the connection is shared across
        # request handlers; one thread's savepoint must not be counted by
        # another's.
        self._local = threading.local()
        self._write = threading.RLock()

    # ---------------------------------------------------------------- querying

    def all(self, sql: str, params: Any = ()) -> list[sqlite3.Row]:
        return self._conn.execute(sql, params).fetchall()

    def get(self, sql: str, params: Any = ()) -> sqlite3.Row | None:
        return self._conn.execute(sql, params).fetchone()

    def value(self, sql: str, params: Any = ()) -> Any:
        """The first column of the first row, or None — for counts and ids."""
        row = self.get(sql, params)
        return None if row is None else row[0]

    def run(self, sql: str, params: Any = ()) -> sqlite3.Cursor:
        with self._write:
            cur = self._conn.execute(sql, params)
            if not self._depth:
                self._conn.commit()
            return cur

    def executescript(self, sql: str) -> None:
        with self._write:
            self._conn.executescript(sql)

    def pragma(self, statement: str) -> Any:
        """Set a PRAGMA and read back what actually took effect."""
        name = statement.split("=")[0].strip()
        self._conn.execute(f"PRAGMA {statement}")
        try:
            row = self._conn.execute(f"PRAGMA {name}").fetchone()
        except sqlite3.Error:
            return None
        return None if row is None else row[0]

    # ------------------------------------------------------------ transactions

    @property
    def _depth(self) -> int:
        return getattr(self._local, "depth", 0)

    @_depth.setter
    def _depth(self, value: int) -> None:
        self._local.depth = value

    @contextmanager
    def transaction(self) -> Iterator["Database"]:
        with self._write:
            nested = self._depth > 0
            savepoint = f"sp_{self._depth}"
            self._conn.execute(f"SAVEPOINT {savepoint}" if nested else "BEGIN")
            self._depth += 1
            try:
                yield self
            except BaseException:
                try:
                    if nested:
                        self._conn.execute(f"ROLLBACK TO {savepoint}")
                        self._conn.execute(f"RELEASE {savepoint}")
                    else:
                        self._conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass  # the transaction was already unwound
                raise
            else:
                self._conn.execute(f"RELEASE {savepoint}" if nested else "COMMIT")
            finally:
                self._depth -= 1

    def close(self) -> None:
        self._conn.close()


def _add_column(db: Database, table: str, column: str, decl: str) -> None:
    """
    CREATE TABLE IF NOT EXISTS will not add a column to a table that is already
    there, so columns introduced after the first release are applied here. Each
    is idempotent: added only when table_info lacks it.
    """
    cols = db.all(f"PRAGMA table_info({table})")
    if not cols:
        return  # not created yet; the schema will cover it
    if any(c["name"] == column for c in cols):
        return
    db.executescript(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def _migrate_seats_to_connections(db: Database) -> None:
    """
    Lift the old per-seat endpoint and key into named connections, once.

    Seats configured before connections existed keep working untouched, and the
    two never end up disagreeing about where a model lives.
    """
    orphans = db.all(
        "SELECT * FROM participants WHERE connection IS NULL OR connection = ''"
    )
    if not orphans:
        return

    now = _now()
    for seat in orphans:
        keys = seat.keys()
        name = (seat["provider"] if "provider" in keys else None) or "openai"
        base_url = (seat["base_url"] if "base_url" in keys else None) or ""
        api_key = seat["api_key"] if "api_key" in keys else None

        existing = db.get("SELECT name FROM connections WHERE name = ?", (name,))
        if not existing:
            db.run(
                """INSERT INTO connections (name, kind, base_url, api_key, model, extra, created_at)
                   VALUES (?, 'chat', ?, ?, ?, '{}', ?)""",
                (name, base_url, api_key, seat["model"] or "", now),
            )
        db.run("UPDATE participants SET connection = ? WHERE name = ?", (name, seat["name"]))


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def open_db(path: str | os.PathLike[str] | None = None) -> Database:
    """Open the room's memory, creating and migrating it as needed."""
    file = resolve_db_path(path)
    if file != ":memory:":
        Path(file).parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(
        file,
        # The web server answers requests on a thread pool and the agent loops
        # run beside them; they share one connection, guarded by the write lock
        # above, rather than each holding their own against the same file.
        check_same_thread=False,
        isolation_level=None,
    )
    conn.row_factory = sqlite3.Row
    db = Database(conn, file)

    db.pragma("journal_mode = WAL")
    # Several agents writing at once is the normal case here, not the
    # exception: wait for the writer rather than throwing "database is locked"
    # at an agent mid-turn.
    db.pragma("busy_timeout = 5000")
    db.pragma("foreign_keys = ON")
    db.pragma("synchronous = NORMAL")

    db.executescript((SQL_DIR / "schema.sql").read_text(encoding="utf-8"))

    _add_column(db, "agents", "last_spoke_at", "TEXT")
    _add_column(db, "participants", "provider", "TEXT NOT NULL DEFAULT 'openai'")
    _add_column(db, "participants", "api_key", "TEXT")
    _add_column(db, "participants", "base_url", "TEXT")
    _add_column(db, "participants", "connection", "TEXT")
    _add_column(db, "ideas", "project_id", "INTEGER")

    _migrate_seats_to_connections(db)

    # FTS5 is compiled into most Python builds, but not all. Search falls back
    # to LIKE rather than the whole room refusing to start.
    try:
        db.executescript((SQL_DIR / "fts.sql").read_text(encoding="utf-8"))
        db.has_fts = True
    except sqlite3.Error:
        db.has_fts = False

    return db
