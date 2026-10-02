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

-- ------------------------------------------------------------------ projects

-- A container for related ideas, with context every idea inside it inherits.
-- Ideas may sit outside one; project_id NULL is the loose pile.
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  -- Standing context for everything in the project: the stack, the constraints,
  -- who it is for. Handed to agents by brief() alongside the idea's own.
  brief       TEXT NOT NULL DEFAULT '',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ----------------------------------------------------------------- artifacts

-- The things the room actually produces: a spec, a document, a file of code, a
-- page. Kept apart from the conversation because that is the point — work you
-- can open, re-read and hand to somebody should not be buried in a transcript.
CREATE TABLE IF NOT EXISTS artifacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  -- markdown | code | html | text — decides only how it is displayed.
  kind        TEXT NOT NULL DEFAULT 'markdown',
  language    TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1,
  idea_id     INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_idea ON artifacts(idea_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id, updated_at);

-- Every revision kept, so "what changed and who changed it" is answerable and a
-- bad edit can be rolled back without losing the reasoning.
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id  INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  content      TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

-- --------------------------------------------------------------- attachments

-- Files dropped into the chat. Text is extracted on upload so agents can read
-- it without every one of them needing to fetch and parse the file.
CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  idea_id      INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  url          TEXT NOT NULL,
  -- Extracted text, where the file has any. Truncated; the file itself stays.
  text         TEXT NOT NULL DEFAULT '',
  uploaded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);

-- ------------------------------------------------------------------ plugins

-- User-defined HTTP tools the agents can call. A plugin is a name, a request
-- shape and a description; the description is what the model reads to decide
-- whether to reach for it, so it matters as much as the URL.
-- Skills: instructions you have written once and want a model to follow again.
--
-- A skill is not a tool. A tool does something; a skill tells a model how to do
-- something, in your words, and the model reads it and works that way. Which is
-- why the body is stored whole and handed over verbatim: paraphrasing somebody's
-- house style defeats the purpose of having written it down.
CREATE TABLE IF NOT EXISTS skills (
  name        TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  -- The instructions themselves, as written.
  body        TEXT NOT NULL,
  -- Where it came from, so a re-upload can be recognised as the same skill.
  source      TEXT NOT NULL DEFAULT '',
  -- Which roles it applies to, as a JSON array; empty means anyone.
  roles       TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  used        INTEGER NOT NULL DEFAULT 0,
  last_used   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- A skill folder may bring files with it — a checklist, a template, a schema.
CREATE TABLE IF NOT EXISTS skill_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  skill      TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE ON UPDATE CASCADE,
  path       TEXT NOT NULL,
  -- Text where we could read it; a URL under /media either way.
  text       TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  bytes      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (skill, path)
);

CREATE INDEX IF NOT EXISTS skill_files_by_skill ON skill_files (skill);

CREATE TABLE IF NOT EXISTS plugins (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  method      TEXT NOT NULL DEFAULT 'GET',
  url         TEXT NOT NULL,
  -- JSON: extra headers, and a body template where {{field}} is substituted
  -- from the model's arguments.
  headers     TEXT NOT NULL DEFAULT '{}',
  body        TEXT NOT NULL DEFAULT '',
  -- JSON Schema for what the model may pass, so a plugin cannot be called with
  -- arbitrary shapes and the model knows what is expected.
  params      TEXT NOT NULL DEFAULT '{"type":"object","properties":{}}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_used   TEXT,
  created_at  TEXT NOT NULL
);

-- Every call, kept: a plugin reaching the outside world is the part most worth
-- being able to audit after the fact.
CREATE TABLE IF NOT EXISTS plugin_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin      TEXT NOT NULL,
  agent       TEXT NOT NULL,
  args        TEXT NOT NULL DEFAULT '{}',
  status      INTEGER,
  ok          INTEGER NOT NULL DEFAULT 0,
  response    TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  ms          INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_calls ON plugin_calls(plugin, id DESC);

-- ---------------------------------------------------------------- citations

-- What a claim rests on. The prefect writes these when it verifies something,
-- so "this was checked" is a record rather than an assertion.
CREATE TABLE IF NOT EXISTS citations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  claim       TEXT NOT NULL,
  -- supported | unsupported | contradicted | unverifiable
  verdict     TEXT NOT NULL,
  -- Where the support came from: decision#3, artifact:spec, fact:runtime, url
  source      TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  checked_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_citations_msg ON citations(message_id);
CREATE INDEX IF NOT EXISTS idx_citations_verdict ON citations(verdict, id DESC);

-- --------------------------------------------------------------------- swarm

-- A swarm run: one goal, split into many pieces, worked in parallel.
--
-- This is the opposite discipline to the room's floor. In the chat, agents take
-- turns because the human is reading. A swarm is nobody watching and everything
-- at once: dozens of pieces, each small enough to hand to a worker, merged at
-- the end. Kept in its own tables because a swarm task has a lifecycle the
-- board's tasks do not — assigned, running, retried, failed with a reason.
CREATE TABLE IF NOT EXISTS swarm_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  goal         TEXT NOT NULL,
  -- planning | running | merging | done | failed | cancelled
  status       TEXT NOT NULL DEFAULT 'planning',
  -- The seat whose connection the workers run on.
  seat         TEXT NOT NULL DEFAULT '',
  workers      INTEGER NOT NULL DEFAULT 4,
  synthesis    TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  idea_id      INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  artifact_id  INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_swarm_recent ON swarm_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS swarm_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES swarm_runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  prompt       TEXT NOT NULL,
  -- queued | running | done | failed
  status       TEXT NOT NULL DEFAULT 'queued',
  result       TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_swarm_tasks ON swarm_tasks(run_id, seq);

-- ---------------------------------------------------------------- generations

-- Everything the image and video models have made, with the prompt that made
-- it. Kept because the prompt is the valuable half: you iterate on it, and
-- without it a gallery is just a pile of pictures you cannot reproduce.
CREATE TABLE IF NOT EXISTS generations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'image',   -- image | video
  prompt      TEXT NOT NULL,
  url         TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  connection  TEXT NOT NULL DEFAULT '',
  size        TEXT NOT NULL DEFAULT '',
  -- Set when it was generated from within a thread, so it can be traced back.
  idea_id     INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  -- A generation this one was iterated from, so a lineage is walkable.
  parent_id   INTEGER REFERENCES generations(id) ON DELETE SET NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generations_recent ON generations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generations_kind ON generations(kind, created_at DESC);

-- ------------------------------------------------------------------ schedules

-- Standing work: a prompt fired into the room on a repeat, so the room can do
-- something every morning without anybody being there to ask.
CREATE TABLE IF NOT EXISTS schedules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  -- Minutes between runs. Simpler than cron and enough for "every morning".
  every_minutes INTEGER NOT NULL DEFAULT 1440,
  -- Optional wall-clock anchor, "HH:MM" local, for daily-ish schedules.
  at_time       TEXT NOT NULL DEFAULT '',
  idea_id       INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  as_agent      TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   TEXT,
  next_run_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);

-- ---------------------------------------------------------------- connections

-- Every endpoint the room can reach: a name, a URL, a key, and what it is for.
--
-- Deliberately not an enum of blessed providers. Presets exist in the UI to
-- prefill the fields, but any endpoint can be added under any name, so a
-- provider that did not exist when this was written needs no code change.
CREATE TABLE IF NOT EXISTS connections (
  name        TEXT PRIMARY KEY,
  -- chat | transcribe | speak | image | video
  kind        TEXT NOT NULL DEFAULT 'chat',
  base_url    TEXT NOT NULL DEFAULT '',
  -- Never selected by the view that feeds the setup page.
  api_key     TEXT,
  -- Default model for this endpoint; a seat may override it.
  model       TEXT NOT NULL DEFAULT '',
  -- Free-form JSON: extra headers, request-shape overrides, response paths for
  -- endpoints that do not follow the common shape.
  extra       TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connections_kind ON connections(kind);

-- ------------------------------------------------------- model participants

-- The models you want in the chat. One row per seat, so the room can be you
-- plus Opus, Sonnet and Haiku arguing with each other, all on the one API key.
-- Agents you run yourself connect over the connector instead and are not listed
-- here — they need no key from us.
CREATE TABLE IF NOT EXISTS participants (
  name         TEXT PRIMARY KEY,
  provider     TEXT NOT NULL DEFAULT 'openai',
  model        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'generalist',
  effort       TEXT NOT NULL DEFAULT 'high',
  max_tokens   INTEGER NOT NULL DEFAULT 64000,
  -- Each seat carries its own credential, because the seats are on different
  -- providers. Never selected by the view that feeds the setup page.
  api_key      TEXT,
  base_url     TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

-- ------------------------------------------------------------ speaking floor

-- Turn-taking. Agents register an intent to speak with an urgency, and the
-- highest-urgency waiter holds the floor. Without this, every agent answers the
-- same message at once and the human reads six variations of one thought.
--
-- One row per waiting agent; at most one row has granted_at set.
CREATE TABLE IF NOT EXISTS floor_queue (
  agent_name    TEXT PRIMARY KEY,
  -- 5 blocker, 4 answer, 3 objection, 2 proposal, 1 comment
  urgency       INTEGER NOT NULL DEFAULT 1,
  reason        TEXT NOT NULL DEFAULT '',
  idea_id       INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  requested_at  TEXT NOT NULL,
  granted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_floor_order ON floor_queue(urgency DESC, requested_at);

-- --------------------------------------------------------- settings & secrets

-- Non-secret configuration set from the setup page.
CREATE TABLE IF NOT EXISTS settings (
  k           TEXT PRIMARY KEY,
  v           TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- API keys. Kept apart from settings so the read path that serves the setup
-- page can never accidentally select a secret: every read here is explicit, and
-- the HTTP layer only ever returns a masked preview.
CREATE TABLE IF NOT EXISTS secrets (
  k           TEXT PRIMARY KEY,
  v           TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ------------------------------------------------------- messaging bridges

-- A paired chat on Telegram/WhatsApp, so the human can drop ideas and answer
-- blocking questions from their phone. A chat must be paired before it can see
-- or touch anything: without that, anyone who finds the bot gets the room.
CREATE TABLE IF NOT EXISTS bridge_chats (
  platform          TEXT NOT NULL,                   -- telegram | whatsapp
  chat_id           TEXT NOT NULL,
  agent_name        TEXT,                            -- which room identity this chat speaks as
  current_idea      INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  notify            INTEGER NOT NULL DEFAULT 1,
  -- Watermark, so a restart does not re-send everything already delivered.
  last_notified_id  INTEGER NOT NULL DEFAULT 0,
  paired_at         TEXT,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (platform, chat_id)
);

-- Small key/value scratch for bridge bookkeeping (e.g. the Telegram update
-- offset), kept in the same file so a restart resumes exactly where it stopped.
CREATE TABLE IF NOT EXISTS bridge_state (
  k  TEXT PRIMARY KEY,
  v  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cursors (
  agent_id         TEXT NOT NULL,
  scope            TEXT NOT NULL,                    -- 'feed' or 'idea:<id>'
  last_message_id  INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (agent_id, scope)
);
