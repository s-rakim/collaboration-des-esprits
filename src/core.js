import { randomUUID } from 'node:crypto';
import { openDb } from './db.js';
import { loadRoles, describeRole, HOUSE_RULES } from './roles.js';

/**
 * The Hub is all of the behaviour, and it knows nothing about transports.
 * The MCP server, the REST API and the tests all drive this same object, so
 * there is exactly one implementation of every rule.
 *
 * NOTE: this module never calls a model and holds no API keys. It is the shared
 * memory your agents meet in; the thinking happens in the agents.
 */

const STAGES = ['raw', 'refining', 'proposing', 'spec', 'building', 'review', 'done', 'parked'];
const TASK_STATUSES = ['todo', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'dropped'];
const OPEN_TASK_STATUSES = ['todo', 'claimed', 'in_progress', 'blocked', 'review'];

/**
 * Speaking urgency. Higher wins the floor. These are the only reasons an agent
 * gets to jump the queue, and they are ordered by how much the room loses by
 * waiting: a blocker stops work, a comment does not.
 */
const URGENCY = { blocker: 5, answer: 4, objection: 3, proposal: 2, comment: 1 };

/**
 * How long a granted floor may be held before it is revoked. An agent that
 * crashes mid-turn must not wedge the room forever.
 */
const FLOOR_HOLD_MS = 90_000;

/**
 * How long since an agent was last seen before the room stops waiting on it.
 * Only affects who is *owed* a proposal score — an absent agent's existing
 * scores and objections still stand.
 */
const PRESENCE_WINDOW_MS = 15 * 60_000;

const now = () => new Date().toISOString();

function slugify(text, fallback = 'idea') {
  const base = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || fallback;
}

/** Pull @mentions out of a body. @all and @human are addresses, not agents. */
function parseMentions(body) {
  const found = new Set();
  for (const m of String(body).matchAll(/(?:^|[\s(<\[",'])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/g)) {
    found.add(m[1].replace(/[.\-_]+$/, ''));
  }
  return [...found].filter(Boolean);
}

export class NotFound extends Error {
  constructor(what) {
    super(what);
    this.code = 'NOT_FOUND';
  }
}
export class Invalid extends Error {
  constructor(what) {
    super(what);
    this.code = 'INVALID';
  }
}

export class Hub {
  constructor({ db, dbPath, roles } = {}) {
    this.db = db ?? openDb(dbPath);
    this.roles = roles ?? loadRoles();
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------------ agents

  /**
   * Identify an agent. Idempotent by name: the same agent reconnecting keeps
   * its id, history and read cursors, which is what makes a resumed session
   * continuous rather than a new participant every time.
   */
  join({ name, role = 'generalist', kind = 'agent', model = '', capabilities = [] }) {
    if (!name || !String(name).trim()) throw new Invalid('name is required');
    // Typing your own handle with the @ on it is the natural thing to do, and
    // storing it that way makes every mention of you read "@@name" and match
    // nothing. Take it off rather than refusing a reasonable thing to type.
    name = String(name).trim().replace(/^@+/, '');
    if (!name) throw new Invalid('name is required');
    if (/\s/.test(name)) throw new Invalid('name cannot contain spaces (it is used for @mentions)');
    // A name nobody can @mention is a name that cannot be addressed, which
    // defeats the point of having one in a room that works by addressing people.
    if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) {
      throw new Invalid('a name has to start with a letter or number, and hold only letters, numbers, dots, dashes or underscores');
    }

    const existing = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
    const ts = now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE agents SET role = ?, kind = ?, model = ?, capabilities = ?, last_seen_at = ?,
                             status = CASE WHEN status = 'away' THEN 'idle' ELSE status END
           WHERE id = ?`,
        )
        .run(role, kind, model, JSON.stringify(capabilities), ts, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO agents (id, name, role, kind, model, capabilities, joined_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), name, role, kind, model, JSON.stringify(capabilities), ts, ts);
      this.#systemPost(null, `${name} joined as ${role}.`);
    }

    const agent = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
    return {
      agent: this.#agentView(agent),
      role: describeRole(this.roles, role),
      rejoined: Boolean(existing),
      waiting: this.catchUp({ name }),
    };
  }

  #agent(name) {
    const a = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(String(name || '').trim());
    if (!a) throw new NotFound(`no agent named "${name}" — call join first`);
    return a;
  }

  #agentView(a) {
    return {
      name: a.name,
      role: a.role,
      kind: a.kind,
      model: a.model || undefined,
      status: a.status,
      statusNote: a.status_note || undefined,
      capabilities: JSON.parse(a.capabilities || '[]'),
      lastSeen: a.last_seen_at,
    };
  }

  touch(name) {
    this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE name = ?').run(now(), name);
  }

  setStatus({ name, status, note = '' }) {
    const agent = this.#agent(name);
    if (!['idle', 'working', 'blocked', 'away'].includes(status)) {
      throw new Invalid(`status must be idle, working, blocked or away`);
    }
    this.db
      .prepare('UPDATE agents SET status = ?, status_note = ?, last_seen_at = ? WHERE id = ?')
      .run(status, note, now(), agent.id);
    return this.#agentView(this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id));
  }

  roster() {
    return this.db
      .prepare('SELECT * FROM agents ORDER BY kind DESC, name')
      .all()
      .map((a) => {
        const view = this.#agentView(a);
        const open = this.db
          .prepare(
            `SELECT id, title, status FROM tasks
             WHERE owner = ? AND status IN ('claimed','in_progress','blocked','review')
             ORDER BY updated_at DESC`,
          )
          .all(a.name);
        return { ...view, workingOn: open };
      });
  }

  // ------------------------------------------------------------------- ideas

  /** Drop a raw idea. This is the human's main entry point. */
  dropIdea({ title, raw = '', by, stage = 'raw' }) {
    if (!title || !String(title).trim()) throw new Invalid('title is required');
    const author = by ? this.#agent(by).name : 'unknown';
    if (!STAGES.includes(stage)) throw new Invalid(`stage must be one of ${STAGES.join(', ')}`);

    // Slugs are stable handles agents can pass around; collisions get -2, -3.
    const base = slugify(title);
    let slug = base;
    for (let n = 2; this.db.prepare('SELECT 1 FROM ideas WHERE slug = ?').get(slug); n++) {
      slug = `${base}-${n}`;
    }

    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO ideas (slug, title, raw, stage, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(slug, String(title).trim(), raw, stage, author, ts, ts);

    const id = Number(info.lastInsertRowid);
    this.#systemPost(id, `${author} dropped a new idea: ${title}`);
    return this.getIdea(id);
  }

  /** Accept either the numeric id or the slug everywhere an idea is named. */
  #ideaRow(ref) {
    if (ref === null || ref === undefined || ref === '') return null;
    const row =
      typeof ref === 'number' || /^\d+$/.test(String(ref))
        ? this.db.prepare('SELECT * FROM ideas WHERE id = ?').get(Number(ref))
        : this.db.prepare('SELECT * FROM ideas WHERE slug = ?').get(String(ref));
    if (!row) throw new NotFound(`no idea "${ref}"`);
    return row;
  }

  #ideaId(ref) {
    const row = this.#ideaRow(ref);
    return row ? row.id : null;
  }

  getIdea(ref) {
    const i = this.#ideaRow(ref);
    return {
      id: i.id,
      slug: i.slug,
      title: i.title,
      raw: i.raw,
      spec: i.spec,
      specRev: i.spec_rev,
      stage: i.stage,
      createdBy: i.created_by,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
    };
  }

  listIdeas({ stage, limit = 50 } = {}) {
    const rows = stage
      ? this.db
          .prepare('SELECT * FROM ideas WHERE stage = ? ORDER BY updated_at DESC LIMIT ?')
          .all(stage, limit)
      : this.db.prepare('SELECT * FROM ideas ORDER BY updated_at DESC LIMIT ?').all(limit);

    return rows.map((i) => {
      const counts = this.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM questions WHERE idea_id = ? AND answered_at IS NULL) AS openQuestions,
             (SELECT COUNT(*) FROM proposals WHERE idea_id = ? AND status = 'open')     AS openProposals,
             (SELECT COUNT(*) FROM tasks WHERE idea_id = ? AND status NOT IN ('done','dropped')) AS openTasks,
             (SELECT COUNT(*) FROM tasks WHERE idea_id = ? AND status = 'done')         AS doneTasks,
             (SELECT COUNT(*) FROM messages WHERE idea_id = ?)                          AS messages`,
        )
        .get(i.id, i.id, i.id, i.id, i.id);
      const project = i.project_id ? this.db.prepare('SELECT slug FROM projects WHERE id = ?').get(i.project_id)?.slug : null;
      return { ...this.getIdea(i.id), project: project ?? null, ...counts };
    });
  }

  /**
   * Move an idea along its lifecycle. Guarded, because the whole value of the
   * refine-then-build split is that it cannot be skipped by accident: you
   * cannot start building over unanswered blocking questions or an empty spec.
   */
  advance({ ref, stage, by, force = false }) {
    const idea = this.#ideaRow(ref);
    const actor = this.#agent(by).name;
    if (!STAGES.includes(stage)) throw new Invalid(`stage must be one of ${STAGES.join(', ')}`);

    const blockers = [];
    if (!force && ['building', 'review', 'done'].includes(stage)) {
      if (!idea.spec.trim()) blockers.push('the spec is still empty — refine it first');
      const openBlocking = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM questions
           WHERE idea_id = ? AND answered_at IS NULL AND blocking = 1`,
        )
        .get(idea.id).n;
      if (openBlocking) blockers.push(`${openBlocking} blocking question(s) still unanswered`);
    }
    if (!force && stage === 'done') {
      const openTasks = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE idea_id = ? AND status NOT IN ('done','dropped')`,
        )
        .get(idea.id).n;
      if (openTasks) blockers.push(`${openTasks} task(s) are not finished`);
    }
    if (blockers.length) {
      throw new Invalid(
        `cannot move "${idea.slug}" to ${stage}: ${blockers.join('; ')}. Pass force to override.`,
      );
    }

    this.db
      .prepare('UPDATE ideas SET stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, now(), idea.id);
    this.#systemPost(idea.id, `${actor} moved this from ${idea.stage} to ${stage}.`);
    return this.getIdea(idea.id);
  }

  /** Refine the spec. Every revision is kept; the raw dump is never touched. */
  refine({ ref, spec, summary = '', by }) {
    const idea = this.#ideaRow(ref);
    const author = this.#agent(by).name;
    if (!spec || !String(spec).trim()) throw new Invalid('spec text is required');

    const rev = idea.spec_rev + 1;
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE ideas SET spec = ?, spec_rev = ?, updated_at = ?, stage = ? WHERE id = ?')
        .run(spec, rev, ts, idea.stage === 'raw' ? 'refining' : idea.stage, idea.id);
      this.db
        .prepare(
          `INSERT INTO spec_revisions (idea_id, rev, spec, summary, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(idea.id, rev, spec, summary, author, ts);
    });
    tx();

    this.#systemPost(idea.id, `${author} revised the spec (rev ${rev})${summary ? `: ${summary}` : ''}`);
    return { ...this.getIdea(idea.id), rev };
  }

  specHistory(ref) {
    const idea = this.#ideaRow(ref);
    return this.db
      .prepare(
        `SELECT rev, summary, author, created_at AS createdAt, LENGTH(spec) AS chars
         FROM spec_revisions WHERE idea_id = ? ORDER BY rev DESC`,
      )
      .all(idea.id);
  }

  // --------------------------------------------------------- speaking floor

  /**
   * Ask for the floor. Idempotent per agent: asking again updates your urgency
   * and reason rather than queueing you twice.
   *
   * The human never queues — they are not competing with the agents for the
   * room's attention, they own it.
   */
  requestFloor({ by, urgency = 'comment', reason = '', idea = null }) {
    const agent = this.#agent(by);
    if (agent.kind === 'human') {
      return { holder: null, position: 0, yours: true, note: 'humans never wait for the floor' };
    }
    const level = typeof urgency === 'number' ? urgency : URGENCY[urgency];
    if (!level) throw new Invalid(`urgency must be one of ${Object.keys(URGENCY).join(', ')}`);

    const ideaId = idea === null || idea === undefined ? null : this.#ideaId(idea);
    const existing = this.db.prepare('SELECT * FROM floor_queue WHERE agent_name = ?').get(agent.name);
    if (existing?.granted_at) {
      // Already holding it; just let them get on with it.
      return this.floor({ by: agent.name });
    }

    this.db
      .prepare(
        `INSERT INTO floor_queue (agent_name, urgency, reason, idea_id, requested_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_name) DO UPDATE SET
           urgency = excluded.urgency, reason = excluded.reason, idea_id = excluded.idea_id`,
      )
      .run(agent.name, level, String(reason), ideaId, now());

    this.#grantFloor();
    return this.floor({ by: agent.name });
  }

  /**
   * Hand the floor to whoever deserves it next, if it is vacant.
   *
   * Order: urgency, then who has been waiting longest, then who spoke least
   * recently. That last term is what stops a chatty agent monopolising a
   * shared urgency level.
   */
  #grantFloor() {
    const ts = now();

    // Reclaim a floor held past the limit — the holder has presumably died.
    const holder = this.db.prepare('SELECT * FROM floor_queue WHERE granted_at IS NOT NULL').get();
    if (holder) {
      if (Date.now() - new Date(holder.granted_at).getTime() < FLOOR_HOLD_MS) return holder;
      this.db.prepare('DELETE FROM floor_queue WHERE agent_name = ?').run(holder.agent_name);
      this.#systemPost(
        holder.idea_id,
        `${holder.agent_name} held the floor without speaking and lost it.`,
      );
    }

    const next = this.db
      .prepare(
        `SELECT q.* FROM floor_queue q
         LEFT JOIN agents a ON a.name = q.agent_name
         WHERE q.granted_at IS NULL
         ORDER BY q.urgency DESC, q.requested_at, IFNULL(a.last_spoke_at, '') LIMIT 1`,
      )
      .get();
    if (!next) return null;

    this.db.prepare('UPDATE floor_queue SET granted_at = ? WHERE agent_name = ?').run(ts, next.agent_name);
    return { ...next, granted_at: ts };
  }

  /** Who is speaking, who is waiting, and why. */
  floor({ by = null } = {}) {
    this.#grantFloor();
    const rows = this.db
      .prepare(
        `SELECT q.*, i.slug AS idea_slug FROM floor_queue q
         LEFT JOIN ideas i ON i.id = q.idea_id
         ORDER BY q.granted_at IS NULL, q.urgency DESC, q.requested_at`,
      )
      .all();
    const name = Object.fromEntries(Object.entries(URGENCY).map(([k, v]) => [v, k]));
    const view = (r) => ({
      agent: r.agent_name,
      urgency: name[r.urgency] ?? r.urgency,
      reason: r.reason || undefined,
      idea: r.idea_slug ?? undefined,
      requestedAt: r.requested_at,
      holding: Boolean(r.granted_at),
    });
    const holder = rows.find((r) => r.granted_at);
    const waiting = rows.filter((r) => !r.granted_at);
    return {
      holder: holder ? view(holder) : null,
      queue: waiting.map(view),
      yours: Boolean(by && holder && holder.agent_name === by),
      position: by ? waiting.findIndex((r) => r.agent_name === by) + 1 || 0 : 0,
    };
  }

  /** Give up the floor. Called for you when you post while holding it. */
  yieldFloor({ by, spoke = false }) {
    const agent = this.#agent(by);
    const row = this.db.prepare('SELECT * FROM floor_queue WHERE agent_name = ?').get(agent.name);
    this.db.prepare('DELETE FROM floor_queue WHERE agent_name = ?').run(agent.name);
    if (spoke) {
      this.db.prepare('UPDATE agents SET last_spoke_at = ? WHERE id = ?').run(now(), agent.id);
    }
    const next = this.#grantFloor();
    return { yielded: Boolean(row), nextSpeaker: next?.agent_name ?? null, floor: this.floor({ by: agent.name }) };
  }

  /**
   * Block until it is your turn. An agent's loop is request_floor →
   * wait_for_turn → post, which is what makes the room read as a conversation
   * rather than six agents talking over each other.
   */
  async waitForTurn({ by, timeoutMs = 25000, pollMs = 300 }) {
    const agent = this.#agent(by);
    if (agent.kind === 'human') return { yours: true, holder: null, queue: [] };
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const f = this.floor({ by: agent.name });
      if (f.yours) return { ...f, timedOut: false };
      if (!this.db.prepare('SELECT 1 FROM floor_queue WHERE agent_name = ?').get(agent.name)) {
        // Not queued at all — waiting would block forever.
        throw new Invalid('you are not in the queue — call request_floor first');
      }
      if (Date.now() >= deadline) return { ...f, timedOut: true };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // ------------------------------------------------------------- the chat

  #systemPost(ideaId, body) {
    this.db
      .prepare(
        `INSERT INTO messages (idea_id, author, author_kind, kind, body, created_at)
         VALUES (?, 'esprits', 'system', 'system', ?, ?)`,
      )
      .run(ideaId, body, now());
  }

  /** Post into an idea's thread, or into the lobby when idea is omitted. */
  post({ idea = null, body, by, kind = 'message', replyTo = null, refKind = null, refId = null }) {
    if (!body || !String(body).trim()) throw new Invalid('body is required');
    const agent = this.#agent(by);
    const ideaId = idea === null || idea === undefined ? null : this.#ideaId(idea);

    /**
     * Turn-taking, applied only to free-form talk. The structured calls
     * (propose, weigh_in, decide, claim_next, …) post as a side effect and are
     * never gated: those are actions, not speaking, and blocking them would
     * deadlock the board.
     *
     * The rule is the social one rather than a hard permission: you may speak
     * into silence, but once somebody is waiting for the floor, everybody
     * queues. That way the discipline engages the moment one agent opts in,
     * and a room where nobody uses it is not broken — just informal.
     */
    let holdsFloor = false;
    if (agent.kind !== 'human' && kind === 'message') {
      const f = this.floor({ by: agent.name });
      holdsFloor = f.yours;
      if ((f.holder || f.queue.length) && !f.yours) {
        const who = f.holder ? `${f.holder.agent} has the floor` : 'others are waiting';
        throw new Invalid(
          `not your turn — ${who}` +
            (f.queue.length ? ` and ${f.queue.length} agent(s) are queued` : '') +
            `. Call request_floor(urgency) then wait_for_turn().`,
        );
      }
    }

    if (replyTo !== null && replyTo !== undefined) {
      const parent = this.db.prepare('SELECT id FROM messages WHERE id = ?').get(Number(replyTo));
      if (!parent) throw new NotFound(`no message #${replyTo} to reply to`);
    }

    const ts = now();
    const mentions = parseMentions(body);
    let id;
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO messages
             (idea_id, author, author_id, author_kind, kind, body, reply_to, ref_kind, ref_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ideaId,
          agent.name,
          agent.id,
          agent.kind,
          kind,
          String(body),
          replyTo ?? null,
          refKind,
          refId,
          ts,
        );
      id = Number(info.lastInsertRowid);
      const ins = this.db.prepare('INSERT OR IGNORE INTO mentions (message_id, name) VALUES (?, ?)');
      for (const m of mentions) ins.run(id, m);
      this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(ts, agent.id);
      if (ideaId) this.db.prepare('UPDATE ideas SET updated_at = ? WHERE id = ?').run(ts, ideaId);
    });
    tx();

    // The author has by definition read their own message.
    this.#advanceCursor(agent.id, ideaId === null ? 'feed' : `idea:${ideaId}`, id);

    // Speaking is what the floor was for, so it is released automatically. An
    // agent that had to remember to yield would eventually forget and stall
    // everyone behind it.
    if (agent.kind !== 'human') {
      this.db.prepare('UPDATE agents SET last_spoke_at = ? WHERE id = ?').run(ts, agent.id);
      if (holdsFloor) this.yieldFloor({ by: agent.name, spoke: true });
    }

    return { id, idea: ideaId, author: agent.name, kind, mentions, createdAt: ts };
  }

  #advanceCursor(agentId, scope, messageId) {
    this.db
      .prepare(
        `INSERT INTO cursors (agent_id, scope, last_message_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, scope) DO UPDATE SET
           last_message_id = MAX(last_message_id, excluded.last_message_id),
           updated_at = excluded.updated_at`,
      )
      .run(agentId, scope, messageId, now());
  }

  #messageView(m) {
    const mentions = this.db
      .prepare('SELECT name FROM mentions WHERE message_id = ?')
      .all(m.id)
      .map((r) => r.name);
    return {
      id: m.id,
      idea: m.idea_slug ?? m.idea_id ?? null,
      author: m.author,
      authorKind: m.author_kind,
      kind: m.kind,
      body: m.body,
      replyTo: m.reply_to ?? undefined,
      ref: m.ref_kind ? { kind: m.ref_kind, id: m.ref_id } : undefined,
      mentions: mentions.length ? mentions : undefined,
      createdAt: m.created_at,
    };
  }

  /**
   * Read new messages. Default is "everything new for me since last time",
   * which is the call an agent makes in a loop; cursor advance is opt-out so a
   * peek can avoid marking things read.
   */
  read({ by, idea = undefined, since = null, limit = 50, advance = true, mentioningMe = false }) {
    const agent = this.#agent(by);
    const scoped = idea !== undefined && idea !== null;
    const ideaId = scoped ? this.#ideaId(idea) : null;
    // A mention-filtered read keeps its own cursor. Sharing one with the
    // unfiltered read would advance past everything between two mentions, and
    // those messages would never be returned again.
    const scope = (scoped ? `idea:${ideaId}` : 'feed') + (mentioningMe ? ':mentions' : '');

    let after = since;
    if (after === null || after === undefined) {
      after =
        this.db
          .prepare('SELECT last_message_id FROM cursors WHERE agent_id = ? AND scope = ?')
          .get(agent.id, scope)?.last_message_id ?? 0;
    }

    const where = ['m.id > ?'];
    const params = [after];
    if (scoped) {
      where.push('m.idea_id = ?');
      params.push(ideaId);
    }
    if (mentioningMe) {
      where.push(`EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = m.id AND x.name IN (?, 'all'))`);
      params.push(agent.name);
    }

    const rows = this.db
      .prepare(
        `SELECT m.*, i.slug AS idea_slug FROM messages m
         LEFT JOIN ideas i ON i.id = m.idea_id
         WHERE ${where.join(' AND ')}
         ORDER BY m.id LIMIT ?`,
      )
      .all(...params, limit);

    if (advance && rows.length) {
      this.#advanceCursor(agent.id, scope, rows[rows.length - 1].id);
    }
    this.touch(agent.name);

    const lastId = this.db.prepare('SELECT MAX(id) AS m FROM messages').get().m ?? 0;
    const cursor = rows.length ? rows[rows.length - 1].id : after;
    return {
      messages: rows.map((m) => this.#messageView(m)),
      cursor,
      more: cursor < lastId && rows.length === limit,
    };
  }

  /**
   * Block until something new arrives, or the timeout expires. This is what
   * makes an agent conversational rather than a poller: its loop is
   * wait() → think → post(), and it costs one query every pollMs while idle.
   *
   * SQLite is polled rather than pushed because the writers are separate OS
   * processes — there is no in-process event to listen for.
   */
  async waitFor({ by, idea = undefined, timeoutMs = 25000, pollMs = 500, mentioningMe = false, limit = 50 }) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const r = this.read({ by, idea, limit, advance: true, mentioningMe });
      if (r.messages.length) return { ...r, timedOut: false };
      if (Date.now() >= deadline) return { ...r, timedOut: true };
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** How many unread, and how many of those are aimed at me. */
  unread({ by, idea = undefined, mentioningMe = false }) {
    const agent = this.#agent(by);
    const scoped = idea !== undefined && idea !== null;
    const ideaId = scoped ? this.#ideaId(idea) : null;
    const scope = (scoped ? `idea:${ideaId}` : 'feed') + (mentioningMe ? ':mentions' : '');
    const after =
      this.db
        .prepare('SELECT last_message_id FROM cursors WHERE agent_id = ? AND scope = ?')
        .get(agent.id, scope)?.last_message_id ?? 0;

    const clause = scoped ? 'AND m.idea_id = ?' : '';
    const params = scoped ? [after, ideaId] : [after];
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.id > ? ${clause}`)
      .get(...params).n;
    const mine = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m WHERE m.id > ? ${clause}
         AND EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = m.id AND x.name IN (?, 'all'))`,
      )
      .get(...params, agent.name).n;
    return { total, mentioningMe: mine, cursor: after };
  }

  thread(messageId) {
    const root = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
    if (!root) throw new NotFound(`no message #${messageId}`);
    const replies = this.db
      .prepare('SELECT * FROM messages WHERE reply_to = ? ORDER BY id')
      .all(root.id);
    return { root: this.#messageView(root), replies: replies.map((m) => this.#messageView(m)) };
  }

  /** FTS5 when available, LIKE when the build lacks it. */
  search({ query, idea = undefined, limit = 25 }) {
    if (!query || !String(query).trim()) throw new Invalid('query is required');
    const scoped = idea !== undefined && idea !== null;
    const ideaId = scoped ? this.#ideaId(idea) : null;

    if (this.db.hasFts) {
      // Quote each term so user punctuation cannot become FTS syntax.
      const safe = String(query)
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(' ');
      try {
        const rows = this.db
          .prepare(
            `SELECT m.*, i.slug AS idea_slug FROM messages_fts f
             JOIN messages m ON m.id = f.rowid
             LEFT JOIN ideas i ON i.id = m.idea_id
             WHERE messages_fts MATCH ? ${scoped ? 'AND m.idea_id = ?' : ''}
             ORDER BY rank LIMIT ?`,
          )
          .all(...(scoped ? [safe, ideaId, limit] : [safe, limit]));
        return rows.map((m) => this.#messageView(m));
      } catch {
        // fall through to LIKE
      }
    }
    const rows = this.db
      .prepare(
        `SELECT m.*, i.slug AS idea_slug FROM messages m
         LEFT JOIN ideas i ON i.id = m.idea_id
         WHERE m.body LIKE ? ${scoped ? 'AND m.idea_id = ?' : ''}
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(...(scoped ? [`%${query}%`, ideaId, limit] : [`%${query}%`, limit]));
    return rows.map((m) => this.#messageView(m));
  }

  // ------------------------------------------------------- open questions

  ask({ idea = null, body, by, audience = 'human', blocking = true, replyTo = null }) {
    if (!body || !String(body).trim()) throw new Invalid('question body is required');
    const agent = this.#agent(by);
    const ideaId = idea === null || idea === undefined ? null : this.#ideaId(idea);
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO questions (idea_id, body, asked_by, audience, blocking, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ideaId, String(body).trim(), agent.name, audience, blocking ? 1 : 0, ts);
    const id = Number(info.lastInsertRowid);
    this.post({
      idea,
      by: agent.name,
      kind: 'question',
      refKind: 'question',
      refId: id,
      replyTo,
      body: `${audience === 'human' ? '@human ' : audience === 'agents' ? '@all ' : `@${audience} `}${body}`,
    });
    return { id, idea: ideaId, body, audience, blocking: Boolean(blocking), askedBy: agent.name };
  }

  /**
   * Answer a question. An agent may not answer on the human's behalf — that
   * would let the room invent a requirement and then build on it as if it had
   * been confirmed.
   */
  answer({ id, answer, by }) {
    const q = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(id));
    if (!q) throw new NotFound(`no question #${id}`);
    if (q.answered_at) throw new Invalid(`question #${id} is already answered`);
    const agent = this.#agent(by);
    if (q.audience === 'human' && agent.kind !== 'human') {
      throw new Invalid(
        `question #${id} is addressed to the human — an agent cannot answer it. ` +
          `If you have information that makes it moot, post it and let them close the question.`,
      );
    }
    // A question aimed at one agent by name is that agent's to answer. Letting
    // any agent field it defeats the point of tagging somebody: you asked the
    // researcher because you wanted the researcher's answer.
    if (q.audience !== 'human' && q.audience !== 'agents' && q.audience !== agent.name && agent.kind !== 'human') {
      throw new Invalid(
        `question #${id} is addressed to @${q.audience}, not you. ` +
          `Post your view instead, or let ${q.audience} answer.`,
      );
    }
    const ts = now();
    this.db
      .prepare('UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?')
      .run(String(answer), agent.name, ts, q.id);

    // Thread the answer under the question's own message, so the room can see
    // which reply answers which tag rather than having to match them by eye.
    const asked = this.db
      .prepare(`SELECT id FROM messages WHERE ref_kind = 'question' AND ref_id = ? ORDER BY id LIMIT 1`)
      .get(q.id);

    this.post({
      idea: q.idea_id ?? null,
      by: agent.name,
      kind: 'answer',
      refKind: 'question',
      refId: q.id,
      replyTo: asked?.id ?? null,
      body: `Answering Q#${q.id} ("${q.body.slice(0, 80)}"): ${answer}`,
    });
    return { id: q.id, answer, answeredBy: agent.name, answeredAt: ts };
  }

  questions({ idea = undefined, open = true } = {}) {
    const scoped = idea !== undefined && idea !== null;
    const ideaId = scoped ? this.#ideaId(idea) : null;
    const where = [];
    const params = [];
    if (scoped) {
      where.push('q.idea_id = ?');
      params.push(ideaId);
    }
    if (open) where.push('q.answered_at IS NULL');
    return this.db
      .prepare(
        `SELECT q.id, i.slug AS idea, q.body, q.asked_by AS askedBy, q.audience,
                q.blocking, q.answer, q.answered_by AS answeredBy, q.answered_at AS answeredAt,
                q.created_at AS createdAt
         FROM questions q LEFT JOIN ideas i ON i.id = q.idea_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY q.blocking DESC, q.id`,
      )
      .all(...params)
      .map((q) => ({ ...q, blocking: Boolean(q.blocking) }));
  }

  // ------------------------------------------------------------- decisions

  /** Lock a choice in, with the reasoning, so nobody re-argues it blind. */
  decide({ idea = null, choice, rationale = '', alternatives = '', by, supersedes = null }) {
    if (!choice || !String(choice).trim()) throw new Invalid('choice is required');
    const agent = this.#agent(by);
    const ideaId = idea === null || idea === undefined ? null : this.#ideaId(idea);
    const ts = now();

    let id;
    const tx = this.db.transaction(() => {
      if (supersedes) {
        const old = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(Number(supersedes));
        if (!old) throw new NotFound(`no decision #${supersedes} to supersede`);
        this.db.prepare('UPDATE decisions SET retired_at = ? WHERE id = ?').run(ts, old.id);
      }
      const info = this.db
        .prepare(
          `INSERT INTO decisions
             (idea_id, choice, rationale, alternatives, decided_by, supersedes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ideaId, String(choice).trim(), rationale, alternatives, agent.name, supersedes ?? null, ts);
      id = Number(info.lastInsertRowid);
    });
    tx();

    this.post({
      idea,
      by: agent.name,
      kind: 'decision',
      refKind: 'decision',
      refId: id,
      body:
        `Decided: ${choice}` +
        (rationale ? `\nWhy: ${rationale}` : '') +
        (supersedes ? `\nThis replaces decision #${supersedes}.` : ''),
    });
    return { id, choice, rationale, decidedBy: agent.name, createdAt: ts };
  }

  decisions({ idea = undefined, includeRetired = false } = {}) {
    const scoped = idea !== undefined && idea !== null;
    const ideaId = scoped ? this.#ideaId(idea) : null;
    const where = [];
    const params = [];
    if (scoped) {
      // Global decisions bind every idea, so an idea's view includes them.
      where.push('(d.idea_id = ? OR d.idea_id IS NULL)');
      params.push(ideaId);
    }
    if (!includeRetired) where.push('d.retired_at IS NULL');
    return this.db
      .prepare(
        `SELECT d.id, i.slug AS idea, d.choice, d.rationale, d.alternatives,
                d.decided_by AS decidedBy, d.supersedes, d.retired_at AS retiredAt,
                d.created_at AS createdAt
         FROM decisions d LEFT JOIN ideas i ON i.id = d.idea_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY d.id`,
      )
      .all(...params);
  }

  // ------------------------------------------------------ durable facts

  /** Upsert by key. Facts are what stops the room re-researching the obvious. */
  remember({ idea = null, key, value, source = '', by }) {
    if (!key || !String(key).trim()) throw new Invalid('key is required');
    const agent = this.#agent(by);
    const ideaId = idea === null || idea === undefined ? null : this.#ideaId(idea);
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO facts (idea_id, key, value, source, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(IFNULL(idea_id, 0), key) DO UPDATE SET
           value = excluded.value, source = excluded.source,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(ideaId, String(key).trim(), String(value), source, agent.name, ts);
    return { key, value, scope: ideaId ? this.getIdea(ideaId).slug : 'global', updatedBy: agent.name };
  }

  recall({ idea = undefined, key = undefined } = {}) {
    const scoped = idea !== undefined && idea !== null;
    const ideaId = scoped ? this.#ideaId(idea) : null;
    const where = [];
    const params = [];
    if (scoped) {
      where.push('(f.idea_id = ? OR f.idea_id IS NULL)');
      params.push(ideaId);
    }
    if (key) {
      where.push('f.key = ?');
      params.push(String(key));
    }
    return this.db
      .prepare(
        `SELECT f.key, f.value, f.source, i.slug AS idea, f.updated_by AS updatedBy,
                f.updated_at AS updatedAt
         FROM facts f LEFT JOIN ideas i ON i.id = f.idea_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY f.idea_id IS NOT NULL, f.key`,
      )
      .all(...params);
  }

  forget({ idea = null, key, by }) {
    this.#agent(by);
    const ideaId = idea === null || idea === undefined ? null : this.#ideaId(idea);
    const info = this.db
      .prepare('DELETE FROM facts WHERE IFNULL(idea_id, 0) = IFNULL(?, 0) AND key = ?')
      .run(ideaId, String(key));
    if (!info.changes) throw new NotFound(`no fact "${key}" in that scope`);
    return { forgotten: key };
  }

  // --------------------------------------------------- competing proposals

  /**
   * Put a way of doing the work on the table. Several agents proposing under
   * the same topic are competing alternatives; the room scores them and the
   * best-supported one wins on recorded reasoning.
   */
  propose({ idea, topic = 'approach', title, approach, effort = '', risks = '', prerequisites = '', by }) {
    const ideaId = this.#ideaId(idea);
    if (ideaId === null) throw new Invalid('a proposal must belong to an idea');
    if (!title || !String(title).trim()) throw new Invalid('title is required');
    if (!approach || !String(approach).trim()) throw new Invalid('approach is required');
    const agent = this.#agent(by);
    const ts = now();

    const info = this.db
      .prepare(
        `INSERT INTO proposals
           (idea_id, topic, title, approach, effort, risks, prerequisites, author, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ideaId, topic, String(title).trim(), approach, effort, risks, prerequisites, agent.name, ts, ts);
    const id = Number(info.lastInsertRowid);

    // Proposing is what the 'proposing' stage is for; nudge the idea into it so
    // the overview shows the room is deliberating rather than stalled.
    const cur = this.db.prepare('SELECT stage FROM ideas WHERE id = ?').get(ideaId).stage;
    if (cur === 'raw' || cur === 'refining') {
      this.db.prepare('UPDATE ideas SET stage = ?, updated_at = ? WHERE id = ?').run('proposing', ts, ideaId);
    }

    this.post({
      idea,
      by: agent.name,
      kind: 'proposal',
      refKind: 'proposal',
      refId: id,
      body:
        `@all Proposal P#${id} on "${topic}" — ${title}\n\n${approach}` +
        (effort ? `\n\nEffort: ${effort}` : '') +
        (risks ? `\nRisks: ${risks}` : '') +
        (prerequisites ? `\nNeeds first: ${prerequisites}` : '') +
        `\n\nScore it with weigh_in(proposal: ${id}, ...).`,
    });
    return this.getProposal(id);
  }

  getProposal(id) {
    const p = this.db
      .prepare(
        `SELECT p.*, i.slug AS idea_slug FROM proposals p JOIN ideas i ON i.id = p.idea_id
         WHERE p.id = ?`,
      )
      .get(Number(id));
    if (!p) throw new NotFound(`no proposal #${id}`);
    const assessments = this.db
      .prepare(
        `SELECT agent, stance, feasibility, reasoning, blocking,
                resolved_by AS resolvedBy, resolved_at AS resolvedAt, updated_at AS updatedAt
         FROM assessments WHERE proposal_id = ? ORDER BY updated_at`,
      )
      .all(p.id)
      .map((a) => ({ ...a, blocking: Boolean(a.blocking) }));
    return {
      id: p.id,
      idea: p.idea_slug,
      topic: p.topic,
      title: p.title,
      approach: p.approach,
      effort: p.effort || undefined,
      risks: p.risks || undefined,
      prerequisites: p.prerequisites || undefined,
      author: p.author,
      status: p.status,
      chosenBy: p.chosen_by ?? undefined,
      createdAt: p.created_at,
      assessments,
      ...this.#score(assessments),
    };
  }

  /**
   * The ranking. Deliberately simple and explainable: agents should be able to
   * see why a route is ahead, and a single unanswered blocking objection is
   * enough to hold a route back no matter how popular it is.
   */
  #score(assessments) {
    const endorse = assessments.filter((a) => a.stance === 'endorse').length;
    const object = assessments.filter((a) => a.stance === 'object').length;
    const scores = assessments.map((a) => a.feasibility).filter((n) => typeof n === 'number');
    const feasibility = scores.length
      ? Math.round((scores.reduce((s, n) => s + n, 0) / scores.length) * 100) / 100
      : null;
    const openBlocking = assessments.filter((a) => a.blocking && !a.resolvedAt);
    return {
      support: endorse - object,
      endorsements: endorse,
      objections: object,
      voters: assessments.length,
      feasibility,
      blockingObjections: openBlocking.map((a) => ({ agent: a.agent, reasoning: a.reasoning })),
      choosable: openBlocking.length === 0 && assessments.length > 0,
    };
  }

  /**
   * Score somebody else's proposal. Upsert by agent, because being argued out
   * of a position and updating your score is the mechanism working, not a
   * failure of it.
   */
  weighIn({ proposal, stance, feasibility = null, reasoning = '', blocking = false, by }) {
    const p = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(Number(proposal));
    if (!p) throw new NotFound(`no proposal #${proposal}`);
    if (p.status !== 'open') throw new Invalid(`proposal #${p.id} is ${p.status}, not open`);
    const agent = this.#agent(by);
    if (!['endorse', 'object', 'neutral'].includes(stance)) {
      throw new Invalid('stance must be endorse, object or neutral');
    }
    if (feasibility !== null && feasibility !== undefined) {
      const n = Number(feasibility);
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new Invalid('feasibility must be an integer 1-5');
    }
    if (stance === 'object' && !String(reasoning).trim()) {
      // An objection with no argument cannot be answered, so it would stall the
      // room forever. Refuse it rather than let it land.
      throw new Invalid('an objection must say what breaks — reasoning is required');
    }
    if (blocking && stance !== 'object') throw new Invalid('only an objection can be blocking');

    const ts = now();
    this.db
      .prepare(
        `INSERT INTO assessments
           (proposal_id, agent, stance, feasibility, reasoning, blocking, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(proposal_id, agent) DO UPDATE SET
           stance = excluded.stance, feasibility = excluded.feasibility,
           reasoning = excluded.reasoning, blocking = excluded.blocking,
           resolved_by = NULL, resolved_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(
        p.id,
        agent.name,
        stance,
        feasibility ?? null,
        String(reasoning),
        blocking ? 1 : 0,
        ts,
      );
    this.db.prepare('UPDATE proposals SET updated_at = ? WHERE id = ?').run(ts, p.id);

    this.post({
      idea: p.idea_id,
      by: agent.name,
      kind: 'critique',
      refKind: 'proposal',
      refId: p.id,
      body:
        `On P#${p.id} (${p.title}): ${stance}` +
        (feasibility ? `, feasibility ${feasibility}/5` : '') +
        (blocking ? ' — BLOCKING' : '') +
        (reasoning ? `\n${reasoning}` : ''),
    });
    return this.getProposal(p.id);
  }

  /** Answer a blocking objection so the route can be considered again. */
  resolveObjection({ proposal, agent: objector, how, by }) {
    const p = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(Number(proposal));
    if (!p) throw new NotFound(`no proposal #${proposal}`);
    const actor = this.#agent(by);
    const row = this.db
      .prepare('SELECT * FROM assessments WHERE proposal_id = ? AND agent = ?')
      .get(p.id, objector);
    if (!row) throw new NotFound(`${objector} has not assessed proposal #${p.id}`);
    if (!row.blocking) throw new Invalid(`${objector}'s assessment is not a blocking objection`);
    if (row.resolved_at) throw new Invalid(`already resolved by ${row.resolved_by}`);

    const ts = now();
    this.db
      .prepare('UPDATE assessments SET resolved_by = ?, resolved_at = ? WHERE proposal_id = ? AND agent = ?')
      .run(actor.name, ts, p.id, objector);
    this.post({
      idea: p.idea_id,
      by: actor.name,
      kind: 'critique',
      refKind: 'proposal',
      refId: p.id,
      body: `@${objector} your blocking objection on P#${p.id} is addressed: ${how}\nRe-score it if you disagree.`,
    });
    return this.getProposal(p.id);
  }

  /**
   * The standing of a contest: every route, ranked, and an explicit statement
   * of what is stopping a winner being picked. This is the call that turns a
   * pile of opinions into a next action.
   */
  standing({ idea, topic = undefined }) {
    const ideaId = this.#ideaId(idea);
    const rows = this.db
      .prepare(
        `SELECT id, topic FROM proposals WHERE idea_id = ? ${topic ? 'AND topic = ?' : ''}
         ORDER BY topic, id`,
      )
      .all(...(topic ? [ideaId, topic] : [ideaId]));

    const byTopic = new Map();
    for (const { id, topic: t } of rows) {
      if (!byTopic.has(t)) byTopic.set(t, []);
      byTopic.get(t).push(this.getProposal(id));
    }

    // Only agents that are actually around can be waited on. An agent that
    // joined once and never returned must not hold a decision open forever.
    const roster = this.roster().filter((a) => a.kind === 'agent' && this.#present(a));
    const contests = [];
    for (const [t, proposals] of byTopic) {
      const chosen = proposals.find((p) => p.status === 'chosen');
      const open = proposals.filter((p) => p.status === 'open');
      // Most support first, then feasibility, then earliest — so a tie breaks
      // toward whoever did the work of proposing first.
      const ranked = [...open].sort(
        (a, b) =>
          b.support - a.support ||
          (b.feasibility ?? 0) - (a.feasibility ?? 0) ||
          a.id - b.id,
      );

      const notYetScored = [];
      for (const p of open) {
        const scored = new Set(p.assessments.map((a) => a.agent));
        const missing = roster.map((a) => a.name).filter((n) => n !== p.author && !scored.has(n));
        if (missing.length) notYetScored.push({ proposal: p.id, awaiting: missing });
      }

      let verdict;
      if (chosen) verdict = `settled: P#${chosen.id} (${chosen.title})`;
      else if (!open.length) verdict = 'nothing on the table — somebody propose()';
      else if (notYetScored.length)
        verdict = 'still gathering scores — every agent should weigh_in before a route is chosen';
      else if (!ranked.some((p) => p.choosable))
        verdict = 'every route has an unanswered blocking objection — resolve one or propose another';
      else if (ranked.length > 1 && ranked[0].support === ranked[1].support && ranked[0].choosable)
        verdict = `tied on support between P#${ranked[0].id} and P#${ranked[1].id} — argue it out or let the human choose`;
      else verdict = `ready: choose P#${ranked.find((p) => p.choosable)?.id}`;

      contests.push({
        topic: t,
        chosen: chosen ? { id: chosen.id, title: chosen.title, by: chosen.chosenBy } : null,
        leader: ranked[0] ? { id: ranked[0].id, title: ranked[0].title, support: ranked[0].support } : null,
        ranked: ranked.map((p) => ({
          id: p.id,
          title: p.title,
          author: p.author,
          support: p.support,
          feasibility: p.feasibility,
          voters: p.voters,
          choosable: p.choosable,
          blockingObjections: p.blockingObjections,
        })),
        awaitingScores: notYetScored,
        verdict,
      });
    }
    return { idea: this.getIdea(ideaId).slug, contests };
  }

  /**
   * Pick a route. Records a decision automatically — the point of the contest
   * is that the outcome becomes binding memory, not just a popular message.
   */
  choose({ proposal, rationale = '', by, force = false }) {
    const p = this.getProposal(proposal);
    const agent = this.#agent(by);
    if (p.status !== 'open') throw new Invalid(`proposal #${p.id} is already ${p.status}`);

    // The human can overrule the room; an agent may not steamroll a live
    // blocking objection, because that is the one guard on the whole process.
    if (!p.choosable && !force && agent.kind !== 'human') {
      const why = p.voters === 0
        ? 'nobody has scored it yet'
        : `unanswered blocking objection(s) from ${p.blockingObjections.map((o) => o.agent).join(', ')}`;
      throw new Invalid(
        `cannot choose P#${p.id}: ${why}. Resolve it, or have the human choose.`,
      );
    }

    const ts = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE proposals SET status = 'chosen', chosen_by = ?, chosen_at = ?, updated_at = ? WHERE id = ?`)
        .run(agent.name, ts, ts, p.id);
      // Everything else under this topic is now off the table.
      this.db
        .prepare(
          `UPDATE proposals SET status = 'rejected', updated_at = ?
           WHERE idea_id = (SELECT idea_id FROM proposals WHERE id = ?)
             AND topic = ? AND id != ? AND status = 'open'`,
        )
        .run(ts, p.id, p.topic, p.id);
    });
    tx();

    const decision = this.decide({
      idea: p.idea,
      by: agent.name,
      choice: `${p.topic}: ${p.title} (P#${p.id})`,
      rationale:
        (rationale ? `${rationale}\n\n` : '') +
        `Chosen over ${p.assessments.length} assessment(s); support ${p.support}` +
        (p.feasibility ? `, mean feasibility ${p.feasibility}/5` : '') +
        `.\n\n${p.approach}`,
      alternatives: this.db
        .prepare(`SELECT id, title FROM proposals WHERE idea_id = (SELECT idea_id FROM proposals WHERE id = ?) AND topic = ? AND id != ?`)
        .all(p.id, p.topic, p.id)
        .map((r) => `P#${r.id} ${r.title}`)
        .join('; '),
    });

    return { proposal: this.getProposal(p.id), decision };
  }

  withdraw({ proposal, by, why = '' }) {
    const p = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(Number(proposal));
    if (!p) throw new NotFound(`no proposal #${proposal}`);
    const agent = this.#agent(by);
    if (p.author !== agent.name && agent.kind !== 'human') {
      throw new Invalid(`only ${p.author} or the human can withdraw P#${p.id}`);
    }
    this.db
      .prepare(`UPDATE proposals SET status = 'withdrawn', updated_at = ? WHERE id = ?`)
      .run(now(), p.id);
    this.post({
      idea: p.idea_id,
      by: agent.name,
      kind: 'proposal',
      refKind: 'proposal',
      refId: p.id,
      body: `Withdrew P#${p.id} (${p.title})${why ? `: ${why}` : ''}`,
    });
    return this.getProposal(p.id);
  }

  // ------------------------------------------------------------ build board

  createTask({ idea = null, title, detail = '', role = 'any', dependsOn = [], by, owner = null }) {
    if (!title || !String(title).trim()) throw new Invalid('title is required');
    const agent = this.#agent(by);
    const ideaId = idea === null || idea === undefined ? null : this.#ideaId(idea);
    const ts = now();

    let id;
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO tasks (idea_id, title, detail, role, owner, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ideaId, String(title).trim(), detail, role, owner, owner ? 'claimed' : 'todo', agent.name, ts, ts);
      id = Number(info.lastInsertRowid);
      const ins = this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)');
      for (const dep of dependsOn) {
        const d = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(Number(dep));
        if (!d) throw new NotFound(`cannot depend on missing task #${dep}`);
        if (Number(dep) === id) throw new Invalid('a task cannot depend on itself');
        ins.run(id, Number(dep));
      }
    });
    tx();
    return this.getTask(id);
  }

  /** Create a batch of tasks in one go, resolving intra-batch dependencies by index. */
  plan({ idea, tasks, by }) {
    const ideaId = this.#ideaId(idea);
    if (ideaId === null) throw new Invalid('plan needs an idea');
    if (!Array.isArray(tasks) || !tasks.length) throw new Invalid('tasks must be a non-empty array');
    const agent = this.#agent(by);

    // "dependsOn: [0, 2]" inside a batch refers to positions in this batch,
    // so a planner can lay out an ordered plan in a single call.
    const created = [];
    const tx = this.db.transaction(() => {
      for (const t of tasks) {
        const deps = (t.dependsOn ?? []).map((d) => {
          if (typeof d === 'number' && d < created.length && d >= 0 && !t.absoluteDeps) {
            return created[d].id;
          }
          return Number(d);
        });
        created.push(
          this.createTask({
            idea: ideaId,
            title: t.title,
            detail: t.detail ?? '',
            role: t.role ?? 'any',
            dependsOn: deps,
            by: agent.name,
          }),
        );
      }
      this.db
        .prepare(`UPDATE ideas SET stage = 'building', updated_at = ? WHERE id = ? AND stage IN ('spec','proposing','refining')`)
        .run(now(), ideaId);
    });
    tx();

    this.post({
      idea: ideaId,
      by: agent.name,
      kind: 'status',
      body:
        `@all Planned ${created.length} task(s):\n` +
        created.map((t) => `- #${t.id} [${t.role}] ${t.title}`).join('\n') +
        `\n\nBuilders: claim_next() to pick up work.`,
    });
    return created;
  }

  getTask(id) {
    const t = this.db
      .prepare('SELECT t.*, i.slug AS idea_slug FROM tasks t LEFT JOIN ideas i ON i.id = t.idea_id WHERE t.id = ?')
      .get(Number(id));
    if (!t) throw new NotFound(`no task #${id}`);
    const deps = this.db
      .prepare(
        `SELECT d.depends_on AS id, x.title, x.status FROM task_deps d
         JOIN tasks x ON x.id = d.depends_on WHERE d.task_id = ?`,
      )
      .all(t.id);
    const blockedBy = deps.filter((d) => d.status !== 'done' && d.status !== 'dropped');
    return {
      id: t.id,
      idea: t.idea_slug ?? null,
      title: t.title,
      detail: t.detail,
      role: t.role,
      status: t.status,
      owner: t.owner ?? undefined,
      result: t.result || undefined,
      createdBy: t.created_by,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      dependsOn: deps,
      blockedBy,
      runnable: t.status === 'todo' && blockedBy.length === 0,
    };
  }

  tasks({ idea = undefined, status = undefined, owner = undefined, role = undefined } = {}) {
    const where = [];
    const params = [];
    if (idea !== undefined && idea !== null) {
      where.push('t.idea_id = ?');
      params.push(this.#ideaId(idea));
    }
    if (status) {
      const list = Array.isArray(status) ? status : [status];
      where.push(`t.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (owner) {
      where.push('t.owner = ?');
      params.push(owner);
    }
    if (role) {
      where.push('t.role = ?');
      params.push(role);
    }
    return this.db
      .prepare(`SELECT t.id FROM tasks t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.id`)
      .all(...params)
      .map((r) => this.getTask(r.id));
  }

  /**
   * A builder pulls its next piece of work. The blocker graph is respected, so
   * an agent is never handed something whose prerequisites are unfinished — that
   * is what lets several builders run at once without coordinating by hand.
   *
   * When nothing is available it says why, rather than returning an empty
   * result an agent would read as "the project is finished".
   */
  claimNext({ by, idea = undefined, role = undefined }) {
    const agent = this.#agent(by);
    const wantRole = role ?? agent.role;
    const ideaId = idea !== undefined && idea !== null ? this.#ideaId(idea) : null;

    // A reviewer's queue is work awaiting its gate, not fresh work.
    const targetStatus = wantRole === 'reviewer' ? 'review' : 'todo';
    const where = ['t.status = ?'];
    const params = [targetStatus];
    if (ideaId !== null) {
      where.push('t.idea_id = ?');
      params.push(ideaId);
    }
    if (targetStatus === 'todo') {
      where.push("(t.role = ? OR t.role = 'any')");
      params.push(wantRole);
    } else {
      // Don't let an agent review its own work.
      where.push('(t.owner IS NULL OR t.owner != ?)');
      params.push(agent.name);
    }

    const candidates = this.db
      .prepare(`SELECT t.id FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.id`)
      .all(...params)
      .map((r) => this.getTask(r.id));

    const ready = candidates.find((t) => (targetStatus === 'review' ? true : t.blockedBy.length === 0));
    if (!ready) {
      const waiting = candidates.length;
      const anyOpen = this.tasks({ idea, status: OPEN_TASK_STATUSES }).length;
      return {
        task: null,
        why: waiting
          ? `${waiting} ${wantRole} task(s) exist but every one is waiting on unfinished dependencies`
          : anyOpen
            ? `nothing for role "${wantRole}" right now; ${anyOpen} open task(s) belong to other roles`
            : 'the board is empty — nothing is planned yet',
        openTasks: anyOpen,
      };
    }

    const ts = now();
    const tx = this.db.transaction(() => {
      // Guard the claim on the status we read, so two builders racing for the
      // same task cannot both win it.
      const info = this.db
        .prepare(`UPDATE tasks SET status = 'claimed', owner = ?, updated_at = ? WHERE id = ? AND status = ?`)
        .run(agent.name, ts, ready.id, targetStatus);
      if (!info.changes) throw new Invalid(`task #${ready.id} was taken by someone else — call claim_next again`);
      this.db
        .prepare(`INSERT INTO task_events (task_id, actor, field, old_value, new_value, created_at) VALUES (?, ?, 'status', ?, 'claimed', ?)`)
        .run(ready.id, agent.name, targetStatus, ts);
      this.db.prepare(`UPDATE agents SET status = 'working', status_note = ?, last_seen_at = ? WHERE id = ?`)
        .run(`#${ready.id} ${ready.title}`.slice(0, 120), ts, agent.id);
    });
    tx();

    this.post({
      idea: ready.idea,
      by: agent.name,
      kind: 'status',
      refKind: 'task',
      refId: ready.id,
      body: `Claimed #${ready.id} — ${ready.title}`,
    });

    return { task: this.getTask(ready.id), brief: ready.idea ? this.brief({ idea: ready.idea }) : null };
  }

  updateTask({ id, status = undefined, result = undefined, detail = undefined, note = '', owner = undefined, by }) {
    const task = this.getTask(id);
    const agent = this.#agent(by);
    const ts = now();

    if (status !== undefined && !TASK_STATUSES.includes(status)) {
      throw new Invalid(`status must be one of ${TASK_STATUSES.join(', ')}`);
    }

    const tx = this.db.transaction(() => {
      if (status !== undefined && status !== task.status) {
        this.db
          .prepare(`INSERT INTO task_events (task_id, actor, field, old_value, new_value, note, created_at) VALUES (?, ?, 'status', ?, ?, ?, ?)`)
          .run(task.id, agent.name, task.status, status, note, ts);
        this.db
          .prepare(`UPDATE tasks SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?`)
          .run(status, ['done', 'dropped'].includes(status) ? ts : null, ts, task.id);
      }
      if (result !== undefined) this.db.prepare('UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?').run(result, ts, task.id);
      if (detail !== undefined) this.db.prepare('UPDATE tasks SET detail = ?, updated_at = ? WHERE id = ?').run(detail, ts, task.id);
      if (owner !== undefined) {
        this.db
          .prepare(`INSERT INTO task_events (task_id, actor, field, old_value, new_value, created_at) VALUES (?, ?, 'owner', ?, ?, ?)`)
          .run(task.id, agent.name, task.owner ?? null, owner, ts);
        this.db.prepare('UPDATE tasks SET owner = ?, updated_at = ? WHERE id = ?').run(owner, ts, task.id);
      }
    });
    tx();

    const updated = this.getTask(task.id);

    // Finishing a task can unblock others. Say so in the room, because that is
    // the signal other builders are waiting on.
    let unblocked = [];
    if (status === 'done') {
      unblocked = this.db
        .prepare(
          `SELECT t.id, t.title, t.role FROM task_deps d JOIN tasks t ON t.id = d.task_id
           WHERE d.depends_on = ? AND t.status = 'todo'`,
        )
        .all(task.id)
        .map((t) => this.getTask(t.id))
        .filter((t) => t.blockedBy.length === 0);

      this.db.prepare(`UPDATE agents SET status = 'idle', status_note = '' WHERE id = ?`).run(agent.id);
    }

    if (status !== undefined) {
      this.post({
        idea: task.idea,
        by: agent.name,
        kind: 'status',
        refKind: 'task',
        refId: task.id,
        body:
          `#${task.id} ${task.title}: ${task.status} → ${status}` +
          (note ? `\n${note}` : '') +
          (result ? `\nResult: ${result}` : '') +
          (unblocked.length
            ? `\n\nThis unblocks: ${unblocked.map((t) => `#${t.id} [${t.role}] ${t.title}`).join(', ')} — @all`
            : ''),
      });
    }
    return { task: updated, unblocked };
  }

  // -------------------------------------------------------------- handoffs

  /** Structured context transfer: the thing that replaces re-explaining. */
  handoff({ idea = null, task = null, summary, nextSteps = '', watchOut = '', artifacts = [], toRole = null, by }) {
    if (!summary || !String(summary).trim()) throw new Invalid('summary is required');
    const agent = this.#agent(by);
    const ideaId = idea === null || idea === undefined ? null : this.#ideaId(idea);
    const ts = now();

    const info = this.db
      .prepare(
        `INSERT INTO handoffs (idea_id, task_id, from_agent, to_role, summary, next_steps, watch_out, artifacts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ideaId, task ? Number(task) : null, agent.name, toRole, summary, nextSteps, watchOut, JSON.stringify(artifacts), ts);
    const id = Number(info.lastInsertRowid);

    // The work goes back on the board, or it silently belongs to an agent that
    // has stopped.
    if (task) {
      const t = this.getTask(task);
      if (['claimed', 'in_progress'].includes(t.status)) {
        this.db.prepare(`UPDATE tasks SET status = 'todo', owner = NULL, updated_at = ? WHERE id = ?`).run(ts, t.id);
        this.db
          .prepare(`INSERT INTO task_events (task_id, actor, field, old_value, new_value, note, created_at) VALUES (?, ?, 'status', ?, 'todo', 'handed off', ?)`)
          .run(t.id, agent.name, t.status, ts);
      }
    }
    this.db.prepare(`UPDATE agents SET status = 'idle', status_note = '' WHERE id = ?`).run(agent.id);

    this.post({
      idea,
      by: agent.name,
      kind: 'handoff',
      refKind: 'task',
      refId: task ? Number(task) : null,
      body:
        `${toRole ? `@${toRole} ` : '@all '}Handoff H#${id}${task ? ` on task #${task}` : ''}\n\n` +
        `Where it stands: ${summary}` +
        (nextSteps ? `\n\nNext: ${nextSteps}` : '') +
        (watchOut ? `\n\nWatch out: ${watchOut}` : '') +
        (artifacts.length ? `\n\nTouched: ${artifacts.join(', ')}` : ''),
    });
    return this.getHandoff(id);
  }

  getHandoff(id) {
    const h = this.db
      .prepare('SELECT h.*, i.slug AS idea_slug FROM handoffs h LEFT JOIN ideas i ON i.id = h.idea_id WHERE h.id = ?')
      .get(Number(id));
    if (!h) throw new NotFound(`no handoff #${id}`);
    return {
      id: h.id,
      idea: h.idea_slug ?? null,
      task: h.task_id ?? undefined,
      from: h.from_agent,
      toRole: h.to_role ?? undefined,
      summary: h.summary,
      nextSteps: h.next_steps || undefined,
      watchOut: h.watch_out || undefined,
      artifacts: JSON.parse(h.artifacts || '[]'),
      claimedBy: h.claimed_by ?? undefined,
      createdAt: h.created_at,
    };
  }

  handoffs({ idea = undefined, open = true, role = undefined } = {}) {
    const where = [];
    const params = [];
    if (idea !== undefined && idea !== null) {
      where.push('h.idea_id = ?');
      params.push(this.#ideaId(idea));
    }
    if (open) where.push('h.claimed_at IS NULL');
    if (role) {
      where.push('(h.to_role IS NULL OR h.to_role = ?)');
      params.push(role);
    }
    return this.db
      .prepare(`SELECT h.id FROM handoffs h ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY h.id DESC`)
      .all(...params)
      .map((r) => this.getHandoff(r.id));
  }

  takeHandoff({ id, by }) {
    const agent = this.#agent(by);
    const h = this.getHandoff(id);
    if (h.claimedBy) throw new Invalid(`handoff #${id} was already picked up by ${h.claimedBy}`);
    this.db.prepare('UPDATE handoffs SET claimed_by = ?, claimed_at = ? WHERE id = ?').run(agent.name, now(), h.id);
    this.post({
      idea: h.idea,
      by: agent.name,
      kind: 'status',
      body: `Picked up handoff H#${h.id} from @${h.from}.`,
    });
    return { handoff: this.getHandoff(h.id), brief: h.idea ? this.brief({ idea: h.idea }) : null };
  }

  // ------------------------------------------------------------- projects

  /** A container for related ideas, with context they all inherit. */
  createProject({ name, brief = '', by }) {
    if (!name || !String(name).trim()) throw new Invalid('a project needs a name');
    this.#agent(by);
    const base = slugify(name, 'project');
    let slug = base;
    for (let n = 2; this.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug); n++) {
      slug = `${base}-${n}`;
    }
    const ts = now();
    const info = this.db
      .prepare('INSERT INTO projects (slug, name, brief, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(slug, String(name).trim(), brief, ts, ts);
    return this.getProject(Number(info.lastInsertRowid));
  }

  #projectRow(ref) {
    if (ref === null || ref === undefined || ref === '') return null;
    const row =
      typeof ref === 'number' || /^\d+$/.test(String(ref))
        ? this.db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(ref))
        : this.db.prepare('SELECT * FROM projects WHERE slug = ?').get(String(ref));
    if (!row) throw new NotFound(`no project "${ref}"`);
    return row;
  }

  getProject(ref) {
    const p = this.#projectRow(ref);
    const counts = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM ideas WHERE project_id = ?) AS ideas,
                (SELECT COUNT(*) FROM artifacts WHERE project_id = ?) AS artifacts`,
      )
      .get(p.id, p.id);
    return {
      id: p.id, slug: p.slug, name: p.name, brief: p.brief,
      archived: Boolean(p.archived), createdAt: p.created_at, updatedAt: p.updated_at, ...counts,
    };
  }

  projects({ includeArchived = false } = {}) {
    return this.db
      .prepare(`SELECT id FROM projects ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC`)
      .all()
      .map((r) => this.getProject(r.id));
  }

  updateProject({ ref, name, brief, archived, by }) {
    const p = this.#projectRow(ref);
    this.#agent(by);
    const ts = now();
    if (name !== undefined) this.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(String(name), ts, p.id);
    if (brief !== undefined) this.db.prepare('UPDATE projects SET brief = ?, updated_at = ? WHERE id = ?').run(String(brief), ts, p.id);
    if (archived !== undefined) this.db.prepare('UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, ts, p.id);
    return this.getProject(p.id);
  }

  /** Move an idea into a project, or out of one with null. */
  fileIdea({ ref, project, by }) {
    const idea = this.#ideaRow(ref);
    const actor = this.#agent(by).name;
    const pid = project === null || project === undefined || project === '' ? null : this.#projectRow(project).id;
    this.db.prepare('UPDATE ideas SET project_id = ?, updated_at = ? WHERE id = ?').run(pid, now(), idea.id);
    this.#systemPost(idea.id, pid
      ? `${actor} filed this under ${this.getProject(pid).name}.`
      : `${actor} took this out of its project.`);
    return this.getIdea(idea.id);
  }

  // ------------------------------------------------------------- artifacts

  /**
   * The things the room produces, kept apart from the conversation.
   *
   * An artifact is addressed by slug and versioned on every write, so agents
   * can hand work back and forth without re-pasting it into chat and without
   * anybody losing what the previous version said.
   */
  saveArtifact({ slug, title, content, kind = 'markdown', language = '', idea = null, project = null, summary = '', by }) {
    const author = this.#agent(by).name;
    if (!content && content !== '') throw new Invalid('content is required');

    const existing = slug ? this.db.prepare('SELECT * FROM artifacts WHERE slug = ?').get(String(slug)) : null;
    const ts = now();

    if (existing) {
      const version = existing.version + 1;
      const tx = this.db.transaction(() => {
        this.db
          .prepare(`UPDATE artifacts SET title = ?, content = ?, kind = ?, language = ?, version = ?, updated_at = ? WHERE id = ?`)
          .run(title ?? existing.title, content, kind ?? existing.kind, language ?? existing.language, version, ts, existing.id);
        this.db
          .prepare(`INSERT INTO artifact_versions (artifact_id, version, content, summary, author, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(existing.id, version, content, summary, author, ts);
      });
      tx();
      this.#artifactPost(existing.idea_id, author, this.getArtifact(existing.id), summary, false);
      return this.getArtifact(existing.id);
    }

    if (!title || !String(title).trim()) throw new Invalid('a new artifact needs a title');
    const ideaId = idea === null || idea === undefined ? null : this.#ideaId(idea);
    const projectId = project === null || project === undefined || project === ''
      ? (ideaId ? this.db.prepare('SELECT project_id FROM ideas WHERE id = ?').get(ideaId)?.project_id ?? null : null)
      : this.#projectRow(project).id;

    const base = slugify(slug || title, 'artifact');
    let handle = base;
    for (let n = 2; this.db.prepare('SELECT 1 FROM artifacts WHERE slug = ?').get(handle); n++) handle = `${base}-${n}`;

    let id;
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO artifacts (slug, title, kind, language, content, version, idea_id, project_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(handle, String(title).trim(), kind, language, content, ideaId, projectId, author, ts, ts);
      id = Number(info.lastInsertRowid);
      this.db
        .prepare(`INSERT INTO artifact_versions (artifact_id, version, content, summary, author, created_at) VALUES (?, 1, ?, ?, ?, ?)`)
        .run(id, content, summary || 'created', author, ts);
    });
    tx();
    this.#artifactPost(ideaId, author, this.getArtifact(id), summary, true);
    return this.getArtifact(id);
  }

  /** Announce it in the thread, so the room knows work landed. */
  #artifactPost(ideaId, author, artifact, summary, isNew) {
    this.post({
      idea: ideaId,
      by: author,
      kind: 'status',
      body:
        `${isNew ? 'Created' : `Updated to v${artifact.version}`}: **${artifact.title}** ` +
        `(artifact \`${artifact.slug}\`, ${artifact.kind})` +
        (summary ? `\n${summary}` : ''),
    });
  }

  getArtifact(ref) {
    const a =
      typeof ref === 'number' || /^\d+$/.test(String(ref))
        ? this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(Number(ref))
        : this.db.prepare('SELECT * FROM artifacts WHERE slug = ?').get(String(ref));
    if (!a) throw new NotFound(`no artifact "${ref}"`);
    return {
      id: a.id, slug: a.slug, title: a.title, kind: a.kind, language: a.language,
      content: a.content, version: a.version,
      idea: a.idea_id ? this.getIdea(a.idea_id).slug : null,
      project: a.project_id ? this.getProject(a.project_id).slug : null,
      createdBy: a.created_by, createdAt: a.created_at, updatedAt: a.updated_at,
    };
  }

  artifacts({ idea = undefined, project = undefined, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (idea !== undefined && idea !== null) { where.push('idea_id = ?'); params.push(this.#ideaId(idea)); }
    if (project !== undefined && project !== null && project !== '') { where.push('project_id = ?'); params.push(this.#projectRow(project).id); }
    return this.db
      .prepare(`SELECT id FROM artifacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit)
      .map((r) => {
        // The list view omits content: an index of thirty documents should not
        // carry thirty documents' worth of text.
        const { content, ...rest } = this.getArtifact(r.id);
        return { ...rest, chars: content.length };
      });
  }

  artifactHistory(ref) {
    const a = this.getArtifact(ref);
    return this.db
      .prepare(`SELECT version, summary, author, created_at AS createdAt, LENGTH(content) AS chars
                FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`)
      .all(a.id);
  }

  /** Read an older version, or restore it as a new one. */
  artifactVersion({ ref, version }) {
    const a = this.getArtifact(ref);
    const v = this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?').get(a.id, Number(version));
    if (!v) throw new NotFound(`artifact "${a.slug}" has no version ${version}`);
    return { ...a, content: v.content, version: v.version, summary: v.summary, author: v.author };
  }

  restoreArtifact({ ref, version, by }) {
    const old = this.artifactVersion({ ref, version });
    return this.saveArtifact({
      slug: old.slug, content: old.content, by,
      summary: `restored version ${version}`,
    });
  }

  deleteArtifact({ ref, by }) {
    const a = this.getArtifact(ref);
    this.#agent(by);
    this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(a.id);
    return { deleted: a.slug };
  }

  // ---------------------------------------------------------- attachments

  /**
   * Record a file dropped into the chat.
   *
   * The extracted text is stored alongside it so agents can read a file without
   * each of them fetching and parsing it — and so brief() can carry it. Files we
   * cannot read are still kept; they just arrive as a name and a link.
   */
  attach({ messageId = null, idea = null, filename, mime = '', size = 0, url, text = '', by }) {
    const author = this.#agent(by).name;
    if (!filename || !url) throw new Invalid('an attachment needs a filename and a url');
    const ideaId = idea === null || idea === undefined || idea === '' ? null : this.#ideaId(idea);
    const info = this.db
      .prepare(
        `INSERT INTO attachments (message_id, idea_id, filename, mime, size, url, text, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(messageId, ideaId, String(filename), mime, Number(size) || 0, url,
           String(text).slice(0, 200_000), author, now());
    return this.getAttachment(Number(info.lastInsertRowid));
  }

  getAttachment(id) {
    const a = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id));
    if (!a) throw new NotFound(`no attachment #${id}`);
    return {
      id: a.id, message: a.message_id ?? null, filename: a.filename, mime: a.mime,
      size: a.size, url: a.url, text: a.text, hasText: Boolean(a.text),
      uploadedBy: a.uploaded_by, createdAt: a.created_at,
    };
  }

  attachments({ idea = undefined, message = undefined, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (idea !== undefined && idea !== null && idea !== '') { where.push('idea_id = ?'); params.push(this.#ideaId(idea)); }
    if (message !== undefined && message !== null) { where.push('message_id = ?'); params.push(Number(message)); }
    return this.db
      .prepare(`SELECT id FROM attachments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit)
      .map((r) => {
        // The list omits the extracted text; an index of files should not carry
        // every file's contents.
        const { text, ...rest } = this.getAttachment(r.id);
        return rest;
      });
  }

  // ------------------------------------------------------------ schedules

  /**
   * Standing work: a prompt fired into the room on a repeat, so something can
   * happen every morning without anybody being there to ask for it.
   */
  createSchedule({ name, prompt, everyMinutes = 1440, atTime = '', idea = null, asAgent = '', enabled = true, by }) {
    this.#agent(by);
    if (!name || !String(name).trim()) throw new Invalid('a schedule needs a name');
    if (!prompt || !String(prompt).trim()) throw new Invalid('a schedule needs something to say');
    const every = Math.max(1, Number(everyMinutes) || 1440);
    if (atTime && !/^\d{1,2}:\d{2}$/.test(atTime)) throw new Invalid('time must look like 08:30');
    const ideaId = idea === null || idea === undefined || idea === '' ? null : this.#ideaId(idea);
    if (asAgent) this.#agent(asAgent);

    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO schedules (name, prompt, every_minutes, at_time, idea_id, as_agent, enabled, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(String(name).trim(), String(prompt), every, atTime, ideaId, asAgent,
           enabled ? 1 : 0, this.#nextRun({ every, atTime }), ts);
    return this.getSchedule(Number(info.lastInsertRowid));
  }

  /** When should this run next: the next wall-clock time, or now plus the interval. */
  #nextRun({ every, atTime, from = new Date() }) {
    if (atTime) {
      const [h, m] = atTime.split(':').map(Number);
      const next = new Date(from);
      next.setSeconds(0, 0);
      next.setHours(h, m);
      // Already past today, so it is tomorrow.
      if (next <= from) next.setDate(next.getDate() + 1);
      return next.toISOString();
    }
    return new Date(from.getTime() + every * 60_000).toISOString();
  }

  getSchedule(id) {
    const r = this.db
      .prepare('SELECT s.*, i.slug AS idea_slug FROM schedules s LEFT JOIN ideas i ON i.id = s.idea_id WHERE s.id = ?')
      .get(Number(id));
    if (!r) throw new NotFound(`no schedule #${id}`);
    return {
      id: r.id, name: r.name, prompt: r.prompt, everyMinutes: r.every_minutes,
      atTime: r.at_time || '', idea: r.idea_slug ?? null, asAgent: r.as_agent || '',
      enabled: Boolean(r.enabled), lastRunAt: r.last_run_at ?? null,
      nextRunAt: r.next_run_at ?? null, createdAt: r.created_at,
    };
  }

  schedules() {
    return this.db.prepare('SELECT id FROM schedules ORDER BY enabled DESC, next_run_at').all().map((r) => this.getSchedule(r.id));
  }

  updateSchedule({ id, name, prompt, everyMinutes, atTime, idea, asAgent, enabled }) {
    const s = this.getSchedule(id);
    const set = [];
    const params = [];
    if (name !== undefined) { set.push('name = ?'); params.push(String(name)); }
    if (prompt !== undefined) { set.push('prompt = ?'); params.push(String(prompt)); }
    if (everyMinutes !== undefined) { set.push('every_minutes = ?'); params.push(Math.max(1, Number(everyMinutes) || 1440)); }
    if (atTime !== undefined) { set.push('at_time = ?'); params.push(String(atTime)); }
    if (asAgent !== undefined) { set.push('as_agent = ?'); params.push(String(asAgent)); }
    if (enabled !== undefined) { set.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (idea !== undefined) {
      set.push('idea_id = ?');
      params.push(idea === null || idea === '' ? null : this.#ideaId(idea));
    }
    if (set.length) this.db.prepare(`UPDATE schedules SET ${set.join(', ')} WHERE id = ?`).run(...params, s.id);

    // Timing changed, so the next run has to be recomputed rather than left
    // pointing at a slot that no longer means anything.
    if (everyMinutes !== undefined || atTime !== undefined || enabled === true) {
      const fresh = this.getSchedule(s.id);
      this.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
        .run(this.#nextRun({ every: fresh.everyMinutes, atTime: fresh.atTime }), s.id);
    }
    return this.getSchedule(s.id);
  }

  deleteSchedule({ id }) {
    const s = this.getSchedule(id);
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(s.id);
    return { deleted: s.id };
  }

  /** Everything due to run now. The caller fires them and reports back. */
  dueSchedules({ at = new Date() } = {}) {
    return this.db
      .prepare(`SELECT id FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`)
      .all(at.toISOString())
      .map((r) => this.getSchedule(r.id));
  }

  /**
   * Fire one: post its prompt into the room, which is what wakes the agents.
   * Runs as the named agent, or as whoever created the room's human side.
   */
  runSchedule({ id, at = new Date() }) {
    const s = this.getSchedule(id);
    const speaker =
      s.asAgent ||
      this.db.prepare(`SELECT name FROM agents WHERE kind = 'human' ORDER BY joined_at LIMIT 1`).get()?.name;
    if (!speaker) throw new Invalid('nobody has joined the room yet, so there is no one to speak as');

    const message = this.post({
      idea: s.idea,
      by: speaker,
      kind: 'message',
      // @all so every listening agent wakes for it, which is the point of a
      // schedule firing at all.
      body: `@all ${s.prompt}`,
    });

    this.db
      .prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?')
      .run(at.toISOString(), this.#nextRun({ every: s.everyMinutes, atTime: s.atTime, from: at }), s.id);
    return { schedule: this.getSchedule(s.id), message };
  }

  // -------------------------------------------------------------- checking

  /**
   * Record that a claim was checked, and what it rests on.
   *
   * The source is required for a supported verdict. "I verified it" with
   * nothing behind it is the same failure the checking exists to catch, so the
   * record refuses to hold one.
   */
  recordCheck({ messageId = null, claim, verdict, source = '', detail = '', by }) {
    const checker = this.#agent(by).name;
    if (!claim || !String(claim).trim()) throw new Invalid('a check needs the claim it is about');
    const allowed = ['supported', 'unsupported', 'contradicted', 'unverifiable'];
    if (!allowed.includes(verdict)) throw new Invalid(`verdict must be one of ${allowed.join(', ')}`);
    if (verdict === 'supported' && !String(source).trim()) {
      throw new Invalid('a supported verdict needs a source — where did you check it?');
    }
    if (verdict === 'contradicted' && !String(source).trim()) {
      throw new Invalid('a contradicted verdict needs a source — what contradicts it?');
    }

    const info = this.db
      .prepare(
        `INSERT INTO citations (message_id, claim, verdict, source, detail, checked_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(messageId ?? null, String(claim).slice(0, 2000), verdict,
           String(source).slice(0, 500), String(detail).slice(0, 4000), checker, now());
    return this.getCheck(Number(info.lastInsertRowid));
  }

  getCheck(id) {
    const c = this.db.prepare('SELECT * FROM citations WHERE id = ?').get(Number(id));
    if (!c) throw new NotFound(`no check #${id}`);
    return {
      id: c.id, message: c.message_id ?? null, claim: c.claim, verdict: c.verdict,
      source: c.source || undefined, detail: c.detail || undefined,
      checkedBy: c.checked_by, createdAt: c.created_at,
    };
  }

  checks({ messageId = undefined, verdict = undefined, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (messageId !== undefined && messageId !== null) { where.push('message_id = ?'); params.push(Number(messageId)); }
    if (verdict) { where.push('verdict = ?'); params.push(verdict); }
    return this.db
      .prepare(`SELECT id FROM citations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit)
      .map((r) => this.getCheck(r.id));
  }

  /**
   * Everything the room has recorded that bears on a claim. This is what the
   * prefect checks against before it goes looking outside: if the room already
   * settled something, that is the answer.
   */
  lookUp({ claim, idea = undefined, limit = 8 }) {
    const q = String(claim ?? '').trim();
    if (!q) throw new Invalid('nothing to look up');
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const like = `%${q.slice(0, 60)}%`;

    const decisions = this.decisions({ idea, includeRetired: false })
      .filter((d) => words.some((w) => `${d.choice} ${d.rationale}`.toLowerCase().includes(w)))
      .slice(0, limit);
    const facts = this.recall({ idea })
      .filter((f) => words.some((w) => `${f.key} ${f.value}`.toLowerCase().includes(w)))
      .slice(0, limit);
    const artifacts = this.db
      .prepare(`SELECT slug, title FROM artifacts WHERE content LIKE ? OR title LIKE ? ORDER BY updated_at DESC LIMIT ?`)
      .all(like, like, limit);
    const said = this.search({ query: q, idea, limit });

    return {
      claim: q,
      decisions: decisions.map((d) => ({ ref: `decision#${d.id}`, choice: d.choice, rationale: d.rationale })),
      facts: facts.map((f) => ({ ref: `fact:${f.key}`, value: f.value, source: f.source })),
      artifacts: artifacts.map((a) => ({ ref: `artifact:${a.slug}`, title: a.title })),
      said: said.map((m) => ({ ref: `message#${m.id}`, author: m.author, body: m.body.slice(0, 300) })),
      // Said plainly, so a model does not read an empty result as a refutation.
      note: (decisions.length || facts.length || artifacts.length || said.length)
        ? 'The room has something on this. Read it before looking outside.'
        : 'The room has nothing on this. That is not evidence either way — check outside or mark it unverifiable.',
    };
  }

  // ---------------------------------------------------------------- swarm

  /**
   * Start a swarm run. The pieces are supplied by whoever planned them — the
   * runner asks a model to split the goal, but a caller can hand in its own
   * split, which is what makes the mechanism testable without a model.
   */
  createSwarm({ goal, seat = '', workers = 4, idea = null, tasks = [], by }) {
    const author = this.#agent(by).name;
    if (!goal || !String(goal).trim()) throw new Invalid('a swarm needs a goal');
    const ideaId = idea === null || idea === undefined || idea === '' ? null : this.#ideaId(idea);
    const ts = now();

    let id;
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO swarm_runs (goal, status, seat, workers, idea_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(String(goal).trim(), tasks.length ? 'running' : 'planning',
             seat, Math.max(1, Math.min(32, Number(workers) || 4)), ideaId, author, ts);
      id = Number(info.lastInsertRowid);
      tasks.forEach((t, i) => this.#addSwarmTask(id, i, t));
    });
    tx();
    return this.getSwarm(id);
  }

  #addSwarmTask(runId, seq, t) {
    this.db
      .prepare('INSERT INTO swarm_tasks (run_id, seq, title, prompt) VALUES (?, ?, ?, ?)')
      .run(runId, seq, String(t.title ?? '').slice(0, 200), String(t.prompt ?? t));
  }

  /** Attach the plan once a planner has produced it. */
  planSwarm({ id, tasks }) {
    const run = this.getSwarm(id);
    if (!Array.isArray(tasks) || !tasks.length) throw new Invalid('a swarm needs at least one piece of work');
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM swarm_tasks WHERE run_id = ?').run(run.id);
      tasks.forEach((t, i) => this.#addSwarmTask(run.id, i, t));
      this.db.prepare(`UPDATE swarm_runs SET status = 'running' WHERE id = ?`).run(run.id);
    });
    tx();
    return this.getSwarm(run.id);
  }

  getSwarm(id) {
    const r = this.db
      .prepare('SELECT s.*, i.slug AS idea_slug, a.slug AS artifact_slug FROM swarm_runs s LEFT JOIN ideas i ON i.id = s.idea_id LEFT JOIN artifacts a ON a.id = s.artifact_id WHERE s.id = ?')
      .get(Number(id));
    if (!r) throw new NotFound(`no swarm run #${id}`);
    const tasks = this.db
      .prepare(`SELECT id, seq, title, prompt, status, result, error, attempts, started_at AS startedAt, finished_at AS finishedAt
                FROM swarm_tasks WHERE run_id = ? ORDER BY seq`)
      .all(r.id);
    const counts = tasks.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {});
    return {
      id: r.id, goal: r.goal, status: r.status, seat: r.seat, workers: r.workers,
      synthesis: r.synthesis, error: r.error || undefined,
      idea: r.idea_slug ?? null, artifact: r.artifact_slug ?? null,
      createdBy: r.created_by, createdAt: r.created_at, finishedAt: r.finished_at ?? null,
      tasks, counts,
      // Progress is worth precomputing: it is what the page polls for.
      done: (counts.done ?? 0) + (counts.failed ?? 0),
      total: tasks.length,
    };
  }

  swarms({ limit = 30 } = {}) {
    return this.db
      .prepare('SELECT id FROM swarm_runs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => {
        // The list omits per-task prompts and results, which are the bulk.
        const { tasks, ...rest } = this.getSwarm(r.id);
        return rest;
      });
  }

  /** Claim the next queued piece, atomically, so two workers cannot take one. */
  claimSwarmTask({ runId }) {
    const ts = now();
    const tx = this.db.transaction(() => {
      const next = this.db
        .prepare(`SELECT id FROM swarm_tasks WHERE run_id = ? AND status = 'queued' ORDER BY seq LIMIT 1`)
        .get(runId);
      if (!next) return null;
      const info = this.db
        .prepare(`UPDATE swarm_tasks SET status = 'running', started_at = ?, attempts = attempts + 1
                  WHERE id = ? AND status = 'queued'`)
        .run(ts, next.id);
      return info.changes ? next.id : null;
    });
    const id = tx();
    if (!id) return null;
    return this.db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(id);
  }

  finishSwarmTask({ taskId, result = '', error = '' }) {
    this.db
      .prepare(`UPDATE swarm_tasks SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?`)
      .run(error ? 'failed' : 'done', String(result).slice(0, 100_000), String(error).slice(0, 2000), now(), Number(taskId));
    return this.db.prepare('SELECT run_id FROM swarm_tasks WHERE id = ?').get(Number(taskId))?.run_id;
  }

  /** Put a failed piece back in the queue, for a retry. */
  retrySwarmTask({ taskId }) {
    const info = this.db
      .prepare(`UPDATE swarm_tasks SET status = 'queued', error = '', finished_at = NULL WHERE id = ? AND status = 'failed'`)
      .run(Number(taskId));
    if (!info.changes) throw new Invalid('only a failed piece can be retried');
    const runId = this.db.prepare('SELECT run_id FROM swarm_tasks WHERE id = ?').get(Number(taskId)).run_id;
    this.db.prepare(`UPDATE swarm_runs SET status = 'running', finished_at = NULL WHERE id = ?`).run(runId);
    return this.getSwarm(runId);
  }

  finishSwarm({ id, synthesis = '', error = '', artifactSlug = null, status = null }) {
    const run = this.getSwarm(id);
    const failed = run.tasks.filter((t) => t.status === 'failed').length;
    const finalStatus = status ?? (error ? 'failed' : 'done');
    const artifactId = artifactSlug
      ? this.db.prepare('SELECT id FROM artifacts WHERE slug = ?').get(artifactSlug)?.id ?? null
      : null;
    this.db
      .prepare(`UPDATE swarm_runs SET status = ?, synthesis = ?, error = ?, artifact_id = ?, finished_at = ? WHERE id = ?`)
      .run(finalStatus, String(synthesis), String(error), artifactId, now(), run.id);

    if (run.idea) {
      this.#systemPost(
        this.#ideaId(run.idea),
        `Swarm "${run.goal.slice(0, 80)}" ${finalStatus}: ${run.total - failed}/${run.total} pieces finished` +
          (artifactSlug ? `, written up as artifact \`${artifactSlug}\`` : ''),
      );
    }
    return this.getSwarm(run.id);
  }

  cancelSwarm({ id }) {
    const run = this.getSwarm(id);
    this.db.prepare(`UPDATE swarm_tasks SET status = 'failed', error = 'cancelled' WHERE run_id = ? AND status IN ('queued','running')`).run(run.id);
    this.db.prepare(`UPDATE swarm_runs SET status = 'cancelled', finished_at = ? WHERE id = ?`).run(now(), run.id);
    return this.getSwarm(run.id);
  }

  // ----------------------------------------------------------- generations

  /**
   * Record something an image or video model made.
   *
   * The prompt is stored with it because the prompt is the valuable half — you
   * iterate on it, and a gallery without prompts is a pile of pictures you
   * cannot reproduce or refine.
   */
  recordGeneration({ kind = 'image', prompt, url, model = '', connection = '', size = '', idea = null, parent = null, by }) {
    const author = this.#agent(by).name;
    if (!url) throw new Invalid('a generation needs a url');
    const ideaId = idea === null || idea === undefined || idea === '' ? null : this.#ideaId(idea);
    const info = this.db
      .prepare(
        `INSERT INTO generations (kind, prompt, url, model, connection, size, idea_id, parent_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, String(prompt ?? ''), url, model, connection, size, ideaId, parent ?? null, author, now());
    return this.getGeneration(Number(info.lastInsertRowid));
  }

  getGeneration(id) {
    const g = this.db
      .prepare(`SELECT g.*, i.slug AS idea_slug FROM generations g LEFT JOIN ideas i ON i.id = g.idea_id WHERE g.id = ?`)
      .get(Number(id));
    if (!g) throw new NotFound(`no generation #${id}`);
    return {
      id: g.id, kind: g.kind, prompt: g.prompt, url: g.url, model: g.model,
      connection: g.connection, size: g.size || undefined,
      idea: g.idea_slug ?? null, parent: g.parent_id ?? null,
      pinned: Boolean(g.pinned), createdBy: g.created_by, createdAt: g.created_at,
    };
  }

  generations({ kind = undefined, idea = undefined, pinned = undefined, limit = 60, before = undefined } = {}) {
    const where = [];
    const params = [];
    if (kind) { where.push('g.kind = ?'); params.push(kind); }
    if (idea !== undefined && idea !== null && idea !== '') { where.push('g.idea_id = ?'); params.push(this.#ideaId(idea)); }
    if (pinned !== undefined) { where.push('g.pinned = ?'); params.push(pinned ? 1 : 0); }
    if (before) { where.push('g.id < ?'); params.push(Number(before)); }
    return this.db
      .prepare(`SELECT g.id FROM generations g ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.id DESC LIMIT ?`)
      .all(...params, limit)
      .map((r) => this.getGeneration(r.id));
  }

  pinGeneration({ id, pinned = true }) {
    const g = this.getGeneration(id);
    this.db.prepare('UPDATE generations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, g.id);
    return this.getGeneration(g.id);
  }

  deleteGeneration({ id }) {
    const g = this.getGeneration(id);
    // The row goes; the file stays on disk, because a message in the room may
    // still point at it and a broken image is worse than an orphaned file.
    this.db.prepare('DELETE FROM generations WHERE id = ?').run(g.id);
    return { deleted: g.id };
  }

  // ------------------------------------------------- context, in one call

  /**
   * THE memory-transfer primitive, and the reason this project exists.
   *
   * One call hands a cold agent everything the room already knows about an
   * idea: the original dump, the current spec, every binding decision with its
   * reasoning, what is still open, where the proposals stand, the board, the
   * latest handoff and the tail of the conversation. An agent that calls this
   * does not need anybody to re-explain the project, and does not re-litigate
   * what was settled before it arrived.
   */
  brief({ idea, messages = 25, by = null }) {
    const i = this.getIdea(idea);
    if (by) this.touch(by);

    const decisions = this.decisions({ idea: i.id });
    const open = this.questions({ idea: i.id, open: true });
    const answered = this.questions({ idea: i.id, open: false }).filter((q) => q.answeredAt);
    const facts = this.recall({ idea: i.id });
    const allTasks = this.tasks({ idea: i.id });
    const standing = this.standing({ idea: i.id });
    const recent = this.db
      .prepare(
        `SELECT m.*, ? AS idea_slug FROM messages m WHERE m.idea_id = ?
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(i.slug, i.id, messages)
      .reverse()
      .map((m) => this.#messageView(m));

    const byStatus = {};
    for (const s of TASK_STATUSES) {
      const list = allTasks.filter((t) => t.status === s);
      if (list.length) byStatus[s] = list;
    }

    const projectRow = this.db.prepare('SELECT project_id FROM ideas WHERE id = ?').get(i.id)?.project_id;
    const pack = {
      idea: i,
      project: projectRow ? this.getProject(projectRow) : null,
      artifacts: this.artifacts({ idea: i.id }),
      attachments: this.attachments({ idea: i.id }),
      facts,
      decisions,
      questions: { open, answered: answered.slice(-10) },
      proposals: standing.contests,
      board: {
        counts: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v.length])),
        runnable: allTasks.filter((t) => t.runnable),
        blocked: allTasks.filter((t) => t.status !== 'done' && t.blockedBy.length > 0),
        inFlight: allTasks.filter((t) => ['claimed', 'in_progress', 'review'].includes(t.status)),
        tasks: allTasks,
      },
      handoffs: this.handoffs({ idea: i.id, open: true }),
      specHistory: this.specHistory(i.id).slice(0, 5),
      recentMessages: recent,
      roster: this.roster(),
    };
    pack.digest = this.#digest(pack);
    return pack;
  }

  /**
   * A flat Markdown rendering of the pack. Structured JSON is right for code,
   * but an agent reads prose better than it reads a nested object — and this is
   * the form that pastes cleanly into another tool's context.
   */
  #digest(p) {
    const L = [];
    const i = p.idea;
    L.push(`# ${i.title}`, '');
    L.push(`Stage: **${i.stage}** · idea \`${i.slug}\` · raised by ${i.createdBy} on ${i.createdAt.slice(0, 10)}`, '');

    if (p.project) {
      L.push(`## Project: ${p.project.name}`, '');
      if (p.project.brief.trim()) L.push(p.project.brief.trim(), '');
      L.push('_This binds every idea in the project, not just this one._', '');
    }

    L.push('## The original idea, as dropped', '', i.raw.trim() || '_(nothing beyond the title)_', '');

    if (i.spec.trim()) L.push(`## Current spec (rev ${i.specRev})`, '', i.spec.trim(), '');
    else L.push('## Current spec', '', '_Not written yet. This is what the refine stage is for._', '');

    if (p.facts.length) {
      L.push('## Established facts', '');
      for (const f of p.facts) {
        L.push(`- **${f.key}**: ${f.value}${f.source ? ` _(${f.source})_` : ''}${f.idea ? '' : ' · global'}`);
      }
      L.push('');
    }

    if (p.decisions.length) {
      L.push('## Decisions already made — do not re-open these without new information', '');
      for (const d of p.decisions) {
        L.push(`- **#${d.id} ${d.choice}** — ${d.decidedBy}`);
        if (d.rationale) {
          for (const line of d.rationale.split('\n').filter(Boolean)) L.push(`  ${line}`);
        }
        if (d.alternatives) L.push(`  _Rejected: ${d.alternatives}_`);
      }
      L.push('');
    }

    if (p.questions.open.length) {
      L.push('## Open questions', '');
      for (const q of p.questions.open) {
        L.push(`- **Q#${q.id}** (${q.audience}${q.blocking ? ', blocking' : ''}): ${q.body} — asked by ${q.askedBy}`);
      }
      L.push('');
    }
    if (p.questions.answered.length) {
      L.push('## Recently answered', '');
      for (const q of p.questions.answered) L.push(`- Q#${q.id} ${q.body} → **${q.answer}** (${q.answeredBy})`);
      L.push('');
    }

    for (const c of p.proposals) {
      L.push(`## Proposals on "${c.topic}"`, '', `_${c.verdict}_`, '');
      for (const r of c.ranked) {
        L.push(
          `- **P#${r.id} ${r.title}** by ${r.author} — support ${r.support}, ` +
            `feasibility ${r.feasibility ?? 'unscored'}${r.feasibility ? '/5' : ''}, ${r.voters} voter(s)` +
            (r.choosable ? '' : ' · **held**'),
        );
        for (const o of r.blockingObjections) L.push(`  - blocking, ${o.agent}: ${o.reasoning}`);
      }
      if (c.chosen) L.push(`- ✅ chosen: **P#${c.chosen.id} ${c.chosen.title}** by ${c.chosen.by}`);
      if (c.awaitingScores.length) {
        L.push('', 'Still owed scores:');
        for (const a of c.awaitingScores) L.push(`- P#${a.proposal}: ${a.awaiting.join(', ')}`);
      }
      L.push('');
    }

    if (p.board.tasks.length) {
      L.push('## Board', '');
      L.push(
        Object.entries(p.board.counts)
          .map(([k, v]) => `${v} ${k}`)
          .join(' · '),
        '',
      );
      if (p.board.runnable.length) {
        L.push('**Claimable now:**');
        for (const t of p.board.runnable) L.push(`- #${t.id} [${t.role}] ${t.title}`);
        L.push('');
      }
      if (p.board.inFlight.length) {
        L.push('**In flight:**');
        for (const t of p.board.inFlight) L.push(`- #${t.id} [${t.role}] ${t.title} — ${t.owner ?? 'unowned'} (${t.status})`);
        L.push('');
      }
      if (p.board.blocked.length) {
        L.push('**Waiting on dependencies:**');
        for (const t of p.board.blocked) {
          L.push(`- #${t.id} [${t.role}] ${t.title} — needs ${t.blockedBy.map((b) => `#${b.id}`).join(', ')}`);
        }
        L.push('');
      }
    }

    if (p.attachments?.length) {
      L.push('## Files attached to this idea', '');
      for (const f of p.attachments) {
        L.push(`- **${f.filename}** (${f.mime || 'unknown type'}, ${f.size} bytes) — ${f.uploadedBy}` +
          (f.hasText ? ' · text readable with read_file' : ' · not text, so only the link'));
      }
      L.push('');
    }

    if (p.artifacts.length) {
      L.push('## Work produced so far', '');
      for (const a of p.artifacts) {
        L.push(`- **${a.title}** — artifact \`${a.slug}\` (${a.kind}, v${a.version}, ${a.chars} chars, last touched by ${a.createdBy})`);
      }
      L.push('', '_Read one with read_artifact, and revise it with save_artifact rather than pasting a new copy into the chat._', '');
    }

    if (p.handoffs.length) {
      L.push('## Unclaimed handoffs', '');
      for (const h of p.handoffs) {
        L.push(`- **H#${h.id}** from ${h.from}${h.toRole ? ` → ${h.toRole}` : ''}: ${h.summary}`);
        if (h.nextSteps) L.push(`  Next: ${h.nextSteps}`);
        if (h.watchOut) L.push(`  Watch out: ${h.watchOut}`);
      }
      L.push('');
    }

    if (p.recentMessages.length) {
      L.push('## Tail of the conversation', '');
      for (const m of p.recentMessages) {
        const head = `**${m.author}**${m.kind !== 'message' ? ` (${m.kind})` : ''}`;
        L.push(`- ${head}: ${m.body.replace(/\n+/g, ' ').slice(0, 280)}`);
      }
      L.push('');
    }

    L.push('## Who is in the room', '');
    for (const a of p.roster) {
      L.push(`- **${a.name}** — ${a.role} (${a.status})${a.workingOn.length ? `, on ${a.workingOn.map((t) => `#${t.id}`).join(', ')}` : ''}`);
    }

    return L.join('\n');
  }

  /**
   * What should I do next. Answers for one agent across every idea: what is
   * aimed at me, what I owe the room, and what I can pick up.
   */
  catchUp({ name }) {
    const agent = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(String(name));
    if (!agent) return null;

    const unread = this.unread({ by: agent.name });
    const mine = this.tasks({ owner: agent.name, status: ['claimed', 'in_progress', 'blocked', 'review'] });

    const questionsForMe = this.questions({ open: true }).filter(
      (q) => q.audience === agent.name || (agent.kind === 'human' && q.audience === 'human') || (agent.kind === 'agent' && q.audience === 'agents'),
    );

    // Proposals this agent has not scored yet: the room is waiting on it.
    const owed = this.db
      .prepare(
        `SELECT p.id, p.title, i.slug AS idea, p.topic, p.author FROM proposals p
         JOIN ideas i ON i.id = p.idea_id
         WHERE p.status = 'open' AND p.author != ?
           AND NOT EXISTS (SELECT 1 FROM assessments a WHERE a.proposal_id = p.id AND a.agent = ?)
         ORDER BY p.id`,
      )
      .all(agent.name, agent.name);

    const claimable =
      agent.kind === 'human'
        ? []
        : this.db
            .prepare(
              `SELECT t.id FROM tasks t
               WHERE t.status = ? AND (t.role = ? OR t.role = 'any')
               ORDER BY t.id`,
            )
            .all(agent.role === 'reviewer' ? 'review' : 'todo', agent.role)
            .map((r) => this.getTask(r.id))
            .filter((t) => (agent.role === 'reviewer' ? t.owner !== agent.name : t.blockedBy.length === 0));

    const handoffsForMe = this.handoffs({ open: true, role: agent.role });

    // overview() is the expensive call here, so it is made once and shared
    // between the nudges and the returned attention list.
    const attention = this.overview().needsAttention;

    const nudges = [];
    if (unread.mentioningMe) nudges.push(`${unread.mentioningMe} message(s) mention you — read(mentioning_me: true)`);
    if (owed.length) nudges.push(`${owed.length} proposal(s) are waiting on your score — weigh_in()`);
    if (questionsForMe.length) nudges.push(`${questionsForMe.length} open question(s) are addressed to you — answer()`);
    if (handoffsForMe.length) nudges.push(`${handoffsForMe.length} unclaimed handoff(s) match your role — take_handoff()`);
    if (mine.length) nudges.push(`you already own ${mine.length} task(s) — finish those before claiming more`);
    else if (claimable.length) nudges.push(`${claimable.length} task(s) are claimable — claim_next()`);

    // An agent arriving cold has read nothing. Point it at the context pack
    // rather than at the raw backlog: brief() is one call, the transcript is not.
    const active = this.listIdeas({ limit: 5 }).filter((i) => !['done', 'parked'].includes(i.stage));
    if (unread.cursor === 0 && active.length) {
      nudges.push(
        `you have not read anything yet — brief(idea: "${active[0].slug}") to load the full context ` +
          `on the most recently active idea` +
          (active.length > 1 ? `, or list_ideas() for the other ${active.length - 1}` : ''),
      );
    } else if (unread.total) {
      nudges.push(`${unread.total} unread message(s) — read()`);
    }

    if (!nudges.length) {
      nudges.push(
        attention.length
          ? `nothing is addressed to you, but ${attention.length} idea(s) need attention — overview()`
          : 'nothing is waiting on you right now',
      );
    }

    return {
      me: this.#agentView(agent),
      unread,
      myTasks: mine,
      claimableTasks: claimable.slice(0, 10),
      questionsForMe,
      proposalsAwaitingMyScore: owed,
      handoffsForMe,
      ideasNeedingAttention: attention,
      nudges,
    };
  }

  /**
   * Project-wide overview: the picture across every idea, plus an explicit
   * list of what is stuck and why. This is the human's dashboard call.
   */
  overview() {
    const ideas = this.listIdeas({ limit: 200 });
    const byStage = {};
    for (const s of STAGES) {
      const n = ideas.filter((i) => i.stage === s).length;
      if (n) byStage[s] = n;
    }

    const needsAttention = [];
    for (const i of ideas) {
      if (i.stage === 'done' || i.stage === 'parked') continue;
      const reasons = [];

      const blocking = this.questions({ idea: i.id, open: true }).filter((q) => q.blocking);
      const forHuman = blocking.filter((q) => q.audience === 'human');
      if (forHuman.length) reasons.push(`${forHuman.length} blocking question(s) waiting on you`);
      const forAgents = blocking.filter((q) => q.audience !== 'human');
      if (forAgents.length) reasons.push(`${forAgents.length} blocking question(s) waiting on an agent`);

      for (const c of this.standing({ idea: i.id }).contests) {
        if (c.chosen) continue;
        if (c.awaitingScores.length) reasons.push(`proposals on "${c.topic}" need scores from ${[...new Set(c.awaitingScores.flatMap((a) => a.awaiting))].join(', ')}`);
        else if (c.ranked.length && !c.ranked.some((r) => r.choosable)) reasons.push(`every route on "${c.topic}" has an unanswered blocking objection`);
        // The verdict is already a sentence ("ready: choose P#2"), so it is
        // quoted rather than wrapped in a second lead-in.
        else if (c.ranked.length) reasons.push(`"${c.topic}" — ${c.verdict}`);
      }

      const tasks = this.tasks({ idea: i.id });
      const stuck = tasks.filter((t) => t.status === 'blocked');
      if (stuck.length) reasons.push(`${stuck.length} task(s) marked blocked`);
      const open = tasks.filter((t) => !['done', 'dropped'].includes(t.status));
      if (i.stage === 'building' && open.length && !open.some((t) => t.runnable || ['claimed', 'in_progress', 'review'].includes(t.status))) {
        reasons.push('building, but nothing is runnable — the dependency graph is deadlocked');
      }
      if (['raw', 'refining'].includes(i.stage) && !this.db.prepare(`SELECT COUNT(*) n FROM proposals WHERE idea_id = ?`).get(i.id).n) {
        reasons.push('no approach has been proposed yet');
      }
      const unclaimed = this.handoffs({ idea: i.id, open: true });
      if (unclaimed.length) reasons.push(`${unclaimed.length} unclaimed handoff(s)`);

      if (reasons.length) needsAttention.push({ idea: i.slug, title: i.title, stage: i.stage, reasons });
    }

    return {
      ideas,
      byStage,
      needsAttention,
      roster: this.roster(),
      totals: this.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM ideas)                                          AS ideas,
             (SELECT COUNT(*) FROM messages)                                       AS messages,
             (SELECT COUNT(*) FROM proposals WHERE status = 'open')                AS openProposals,
             (SELECT COUNT(*) FROM questions WHERE answered_at IS NULL)            AS openQuestions,
             (SELECT COUNT(*) FROM decisions WHERE retired_at IS NULL)             AS decisions,
             (SELECT COUNT(*) FROM tasks WHERE status NOT IN ('done','dropped'))   AS openTasks,
             (SELECT COUNT(*) FROM tasks WHERE status = 'done')                    AS doneTasks,
             (SELECT COUNT(*) FROM facts)                                          AS facts`,
        )
        .get(),
      houseRules: HOUSE_RULES,
    };
  }

  /**
   * Everything addressed to one participant since a watermark. The messaging
   * bridges use this to push only what actually needs the person, rather than
   * relaying the whole room to their phone.
   *
   * A human is also addressed by @human, which is what ask() uses when a
   * question is aimed at them.
   */
  notifications({ name, since = 0 }) {
    const agent = this.#agent(name);
    const targets = agent.kind === 'human' ? [agent.name, 'all', 'human'] : [agent.name, 'all'];
    const rows = this.db
      .prepare(
        `SELECT m.*, i.slug AS idea_slug FROM messages m
         LEFT JOIN ideas i ON i.id = m.idea_id
         WHERE m.id > ? AND m.author != ?
           AND EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = m.id
                       AND x.name IN (${targets.map(() => '?').join(',')}))
         ORDER BY m.id LIMIT 50`,
      )
      .all(since, agent.name, ...targets);
    return { messages: rows.map((m) => this.#messageView(m)), head: this.head() };
  }

  /**
   * Is this agent still participating? Used to decide who a decision may
   * legitimately wait on. Generous on purpose: a slow agent should not be
   * written off mid-discussion, but one that left days ago must not deadlock
   * the room.
   */
  #present(agent) {
    if (agent.status === 'away') return false;
    const seen = Date.parse(agent.lastSeen ?? agent.last_seen_at ?? '');
    if (!Number.isFinite(seen)) return false;
    return Date.now() - seen < PRESENCE_WINDOW_MS;
  }

  /** Newest message id — the HTTP layer polls this to drive live updates. */
  head() {
    return this.db.prepare('SELECT IFNULL(MAX(id), 0) AS id FROM messages').get().id;
  }
}

export { STAGES, TASK_STATUSES, URGENCY, FLOOR_HOLD_MS, PRESENCE_WINDOW_MS, parseMentions, slugify };
