# Where the Python port is

Honest state, so nobody runs it expecting a room.

## Works, and is tested

- **`esprits/db.py`** — opens the same SQLite file the Node app does, same
  schema (from `sql/`), WAL, migrations. A room written by one runtime opens in
  the other with its history intact, both directions, full-text search included.
- **`esprits/router.py`** — the whole connector layer. Speaks both request
  shapes and discovers which a router serves. 16 tests against stand-ins that
  answer the way 9Router, Free Claude Code and My Claude Code answer.
- **`esprits/roles.py`** — charters and house rules, from `roles/builtin.json`.

## Ported, not yet usable

`esprits/core/` has presence, ideas, the speaking floor, messages, questions,
decisions and proposals. `board.py` (tasks and handoffs) is written but not
composed into `Hub` yet.

**`Hub` cannot be used.** `join()` calls `catch_up()`, which needs `brief()`,
which needs projects, artifacts and attachments — none of which are ported. It
will raise `AttributeError` on the first call, and that is the truth rather
than a stub pretending otherwise.

## Not started

Projects, artifacts, attachments, generations, citations, the swarm, the
briefing calls (`brief`, `catch_up`, `overview`, `notifications`, `head`), the
HTTP server, the participant loop, skills, plugins, documents, the theme, the
MCP server, the Telegram bridge.

## To run the room today

Use the Node app. `npm start`, port 4300. It has everything.
