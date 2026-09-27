import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * One SQLite file is the whole shared memory. Every agent process — stdio or
 * HTTP — opens the same file in WAL mode, so several can read while one writes
 * without anybody holding a lock long enough to matter. That is what makes the
 * local case serverless: no daemon need be running for two Claude Code
 * sessions to share context.
 *
 * The model is organised around the IDEA, not around chat. An idea carries its
 * own discussion, its open questions, its locked decisions and its build
 * tasks, because the thing agents need handed to them is all of that at once —
 * not a transcript they have to re-read.
 */

const SCHEMA = `
-- ---------------------------------------------------------------- participants

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'generalist',
  kind          TEXT NOT NULL DEFAULT 'agent',      -- agent | human
  model         TEXT NOT NULL DEFAULT '',
  capabilities  TEXT NOT NULL DEFAULT '[]',         -- JSON array
  status        TEXT NOT NULL DEFAULT 'idle',        -- idle | working | blocked | away
  status_note   TEXT NOT NULL DEFAULT '',
  joined_at     TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------- ideas

CREATE TABLE IF NOT EXISTS ideas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  -- The raw dump, exactly as it was given. Never rewritten: refinement lands
  -- in the spec column, so the original intent stays auditable.
  raw         TEXT NOT NULL DEFAULT '',
  spec        TEXT NOT NULL DEFAULT '',
  stage       TEXT NOT NULL DEFAULT 'raw',
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  spec_rev    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ideas_stage ON ideas(stage, updated_at);

-- Every spec edit is kept, so "how did we get here" is answerable and a bad
-- refinement can be rolled back without losing the reasoning.
CREATE TABLE IF NOT EXISTS spec_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  rev         INTEGER NOT NULL,
  spec        TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spec_rev ON spec_revisions(idea_id, rev);

-- --------------------------------------------------------------- conversation

-- idea_id NULL == the lobby: cross-cutting chat that belongs to no one idea.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id     INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  author_id   TEXT,
  author_kind TEXT NOT NULL DEFAULT 'agent',
  -- message | critique | proposal | decision | question | answer | status
  -- | handoff | system
  kind        TEXT NOT NULL DEFAULT 'message',
  body        TEXT NOT NULL,
  reply_to    INTEGER REFERENCES messages(id),
  ref_kind    TEXT,                                  -- task | question | decision
  ref_id      INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_idea ON messages(idea_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_feed ON messages(id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(reply_to);

-- Denormalised so "what is addressed to me" is an index hit, not a JSON scan.
CREATE TABLE IF NOT EXISTS mentions (
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  PRIMARY KEY (message_id, name)
);
CREATE INDEX IF NOT EXISTS idx_mentions_name ON mentions(name, message_id);

-- ------------------------------------------------------- questions & decisions

-- The refinement loop's blocking input. An idea with open questions aimed at
-- the human is not ready to build, and the overview says so out loud.
CREATE TABLE IF NOT EXISTS questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id      INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  asked_by     TEXT NOT NULL,
  audience     TEXT NOT NULL DEFAULT 'human',        -- human | agents | <agent name>
  blocking     INTEGER NOT NULL DEFAULT 1,
  answer       TEXT,
  answered_by  TEXT,
  answered_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_open ON questions(idea_id, answered_at);

-- Locked-in choices. This table exists so a fresh agent cannot reopen a
-- settled argument: brief() hands it every decision plus the rationale.
CREATE TABLE IF NOT EXISTS decisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id      INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
  choice       TEXT NOT NULL,
  rationale    TEXT NOT NULL DEFAULT '',
  alternatives TEXT NOT NULL DEFAULT '',
  decided_by   TEXT NOT NULL,
  -- A later decision can retire an earlier one. The old row stays; it is just
  -- marked, so the history of the reversal survives.
  supersedes   INTEGER REFERENCES decisions(id),
  retired_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_idea ON decisions(idea_id, retired_at);

-- Durable project memory that outlives any one idea: "backend is Node ESM",
-- "never use cookies for mobile auth". Scope NULL == global.
CREATE TABLE IF NOT EXISTS facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id     INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT '',
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_key
  ON facts(IFNULL(idea_id, 0), key);

-- --------------------------------------------------------------------- build

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id     INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  -- Which preset builder this is for. claim_next() matches on it.
  role        TEXT NOT NULL DEFAULT 'any',
  status      TEXT NOT NULL DEFAULT 'todo',  -- todo|claimed|in_progress|blocked|review|done|dropped
  owner       TEXT,
  result      TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_idea ON tasks(idea_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, role);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner, status);

-- The blocker graph. claim_next() walks it so a builder is never handed work
-- whose prerequisites are unfinished.
CREATE TABLE IF NOT EXISTS task_deps (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_deps_reverse ON task_deps(depends_on);

CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, id);

-- A structured context transfer written when an agent stops mid-stream, so the
-- next one picks up from a summary instead of re-deriving from the transcript.
CREATE TABLE IF NOT EXISTS handoffs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id     INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  from_agent  TEXT NOT NULL,
  to_role     TEXT,
  summary     TEXT NOT NULL,
  next_steps  TEXT NOT NULL DEFAULT '',
  watch_out   TEXT NOT NULL DEFAULT '',
  artifacts   TEXT NOT NULL DEFAULT '[]',            -- JSON array of paths/links
  claimed_by  TEXT,
  claimed_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_open ON handoffs(idea_id, claimed_at);

-- ----------------------------------------------------- competing proposals

-- The collaboration primitive. Any agent may propose a way to do the work;
-- every other agent scores it for feasibility and says why. The room converges
-- on the best-supported route instead of deferring to whoever answered first.
CREATE TABLE IF NOT EXISTS proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id       INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  -- Scopes a contest. Proposals sharing a topic are alternatives to each
  -- other; a different topic is a different question being decided.
  topic         TEXT NOT NULL DEFAULT 'approach',
  title         TEXT NOT NULL,
  approach      TEXT NOT NULL,
  -- Self-reported by the proposer, then checked by everyone else.
  effort        TEXT NOT NULL DEFAULT '',
  risks         TEXT NOT NULL DEFAULT '',
  prerequisites TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | chosen | rejected | withdrawn
  chosen_by     TEXT,
  chosen_at     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_idea ON proposals(idea_id, topic, status);

-- One assessment per agent per proposal; re-assessing overwrites, so an agent
-- can change its mind when it is argued out of a position.
CREATE TABLE IF NOT EXISTS assessments (
  proposal_id  INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL,
  stance       TEXT NOT NULL,                  -- endorse | object | neutral
  -- 1 = will not work, 5 = clearly workable now. Averaged into the ranking.
  feasibility  INTEGER,
  reasoning    TEXT NOT NULL DEFAULT '',
  -- An objection that must be answered before this route can be chosen.
  blocking     INTEGER NOT NULL DEFAULT 0,
  resolved_by  TEXT,
  resolved_at  TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (proposal_id, agent)
);
CREATE INDEX IF NOT EXISTS idx_assessments_open ON assessments(proposal_id, stance, resolved_at);

-- ------------------------------------------------------------------- cursors

CREATE TABLE IF NOT EXISTS cursors (
  agent_id         TEXT NOT NULL,
  scope            TEXT NOT NULL,                    -- 'feed' or 'idea:<id>'
  last_message_id  INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (agent_id, scope)
);
`;

const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body, author, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ins AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body, author) VALUES (new.id, new.body, new.author);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_del AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, author)
    VALUES ('delete', old.id, old.body, old.author);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_upd AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, author)
    VALUES ('delete', old.id, old.body, old.author);
  INSERT INTO messages_fts(rowid, body, author) VALUES (new.id, new.body, new.author);
END;
`;

/** Env wins, so every agent's config can point at the one shared file. */
export function resolveDbPath(explicit) {
  const p = explicit || process.env.ESPRITS_DB || './data/esprits.sqlite';
  return p === ':memory:' ? p : resolve(p);
}

export function openDb(path) {
  const file = resolveDbPath(path);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  // Several agents writing at once is the normal case here, not the exception:
  // wait for the writer rather than throwing SQLITE_BUSY at an agent mid-turn.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec(SCHEMA);

  // FTS5 ships in the stock better-sqlite3 build, but a custom or distro
  // SQLite may lack it. Search falls back to LIKE rather than the whole
  // connector refusing to start.
  let fts = true;
  try {
    db.exec(FTS);
  } catch {
    fts = false;
  }
  db.hasFts = fts;

  return db;
}
