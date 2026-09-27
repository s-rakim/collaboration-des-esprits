#!/usr/bin/env node
import express from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hub, NotFound, Invalid } from '../core.js';
import { buildServer } from '../mcp/tools.js';

/**
 * Network entrypoint. Serves three things off one port:
 *
 *   POST /mcp     the connector, for agents that are not on this machine
 *   /api/*        a plain JSON API, which the web UI uses
 *   /             the room, for the human
 *
 * The MCP endpoint is stateless: a fresh server and transport per request, no
 * session to keep alive. Several agents can therefore hit it concurrently
 * without coordinating, and a dropped connection costs nothing — the state
 * that matters is in SQLite, not in the transport.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? process.env.ESPRITS_PORT ?? 4300);
const HOST = process.env.ESPRITS_HOST ?? '127.0.0.1';
const TOKEN = process.env.ESPRITS_TOKEN ?? '';

const hub = new Hub({ dbPath: process.env.ESPRITS_DB });
const app = express();
app.use(express.json({ limit: '4mb' }));

/**
 * Shared-secret auth, on when ESPRITS_TOKEN is set. Loopback-only by default
 * means the common local setup needs no secret; binding to 0.0.0.0 without one
 * is refused below rather than silently exposing the room.
 */
app.use((req, res, next) => {
  if (!TOKEN || req.path === '/health') return next();
  const header = req.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-esprits-token');
  if (bearer !== TOKEN) return res.status(401).json({ error: 'bad or missing token' });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, name: 'collaboration-des-esprits', head: hub.head() }));

// ------------------------------------------------------------------ the MCP endpoint

app.all('/mcp', async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    // Stateless mode has no server-initiated stream to attach to.
    return res.status(405).set('Allow', 'POST, DELETE').json({ error: 'use POST for stateless MCP' });
  }

  // A remote agent can pin its identity with a header instead of passing `as`
  // on every call — the same ergonomics the stdio server gets from --as.
  const name = req.get('x-esprits-agent');
  let identity = null;
  if (name) {
    try {
      const joined = hub.join({
        name,
        role: req.get('x-esprits-role') ?? 'generalist',
        kind: req.get('x-esprits-kind') === 'human' ? 'human' : 'agent',
        model: req.get('x-esprits-model') ?? '',
      });
      identity = { name: joined.agent.name, role: joined.agent.role };
    } catch (err) {
      return res.status(400).json({ error: `bad identity headers: ${err.message}` });
    }
  }

  const { server } = buildServer({ hub, identity });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------- JSON API

/** Map domain errors onto status codes once, rather than in every route. */
const send = (res, fn) => {
  try {
    res.json(fn());
  } catch (err) {
    const status = err instanceof NotFound ? 404 : err instanceof Invalid ? 400 : 500;
    res.status(status).json({ error: err.message, code: err.code });
  }
};

app.get('/api/overview', (_req, res) => send(res, () => hub.overview()));
app.get('/api/roster', (_req, res) => send(res, () => hub.roster()));
app.get('/api/ideas', (req, res) => send(res, () => hub.listIdeas({ stage: req.query.stage })));
app.get('/api/ideas/:ref', (req, res) =>
  send(res, () => hub.brief({ idea: req.params.ref, messages: Number(req.query.messages ?? 200) })),
);
app.get('/api/ideas/:ref/digest', (req, res) =>
  send(res, () => ({ digest: hub.brief({ idea: req.params.ref }).digest })),
);
app.get('/api/questions', (req, res) => send(res, () => hub.questions({ idea: req.query.idea, open: req.query.open !== 'false' })));
app.get('/api/decisions', (req, res) => send(res, () => hub.decisions({ idea: req.query.idea })));
app.get('/api/tasks', (req, res) => send(res, () => hub.tasks({ idea: req.query.idea })));
app.get('/api/search', (req, res) => send(res, () => hub.search({ query: req.query.q, idea: req.query.idea })));

/** The lobby plus every idea, newest last — what the UI renders as the feed. */
app.get('/api/feed', (req, res) =>
  send(res, () => {
    const since = Number(req.query.since ?? 0);
    const rows = hub.db
      .prepare(
        `SELECT m.*, i.slug AS idea_slug FROM messages m
         LEFT JOIN ideas i ON i.id = m.idea_id
         WHERE m.id > ? ${req.query.idea ? 'AND i.slug = ?' : ''}
         ORDER BY m.id LIMIT 500`,
      )
      .all(...(req.query.idea ? [since, req.query.idea] : [since]));
    return {
      head: hub.head(),
      messages: rows.map((m) => ({
        id: m.id,
        idea: m.idea_slug,
        author: m.author,
        authorKind: m.author_kind,
        kind: m.kind,
        body: m.body,
        ref: m.ref_kind ? { kind: m.ref_kind, id: m.ref_id } : null,
        createdAt: m.created_at,
      })),
    };
  }),
);

// The human's side of the room.
app.post('/api/ideas', (req, res) =>
  send(res, () => hub.dropIdea({ title: req.body.title, raw: req.body.raw ?? '', by: req.body.as })),
);
app.post('/api/post', (req, res) =>
  send(res, () => hub.post({ idea: req.body.idea ?? null, body: req.body.body, by: req.body.as, kind: req.body.kind ?? 'message' })),
);
app.post('/api/answer', (req, res) =>
  send(res, () => hub.answer({ id: req.body.id, answer: req.body.answer, by: req.body.as })),
);
app.post('/api/decide', (req, res) =>
  send(res, () => hub.decide({ ...req.body, by: req.body.as, idea: req.body.idea ?? null })),
);
app.post('/api/choose', (req, res) =>
  send(res, () => hub.choose({ proposal: req.body.proposal, rationale: req.body.rationale ?? '', by: req.body.as })),
);
app.post('/api/advance', (req, res) =>
  send(res, () => hub.advance({ ref: req.body.idea, stage: req.body.stage, by: req.body.as, force: Boolean(req.body.force) })),
);
app.post('/api/join', (req, res) => send(res, () => hub.join(req.body)));

/**
 * Live updates by polling the message high-water mark. Chosen over websockets
 * deliberately: the writers are separate OS processes touching a SQLite file,
 * so there is no in-process event to push. One cheap MAX(id) query a second is
 * both simpler and correct across processes.
 */
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let last = Number(req.query.since ?? hub.head());
  res.write(`event: hello\ndata: ${JSON.stringify({ head: last })}\n\n`);

  const tick = setInterval(() => {
    try {
      const head = hub.head();
      if (head > last) {
        res.write(`event: messages\ndata: ${JSON.stringify({ since: last, head })}\n\n`);
        last = head;
      } else {
        res.write(': keepalive\n\n');
      }
    } catch {
      clearInterval(tick);
      res.end();
    }
  }, 1000);

  req.on('close', () => clearInterval(tick));
});

app.use(express.static(join(here, '..', 'web')));

// ------------------------------------------------------------------- listen

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  // Binding beyond loopback with no secret would publish the whole room —
  // every idea, decision and handoff — to anything that can reach the port.
  process.stderr.write(
    `esprits: refusing to bind ${HOST} without ESPRITS_TOKEN set.\n` +
      `Set a token, or leave ESPRITS_HOST at 127.0.0.1.\n`,
  );
  process.exit(1);
}

app.listen(PORT, HOST, () => {
  process.stdout.write(
    `collaboration-des-esprits\n` +
      `  room       http://${HOST}:${PORT}/\n` +
      `  connector  http://${HOST}:${PORT}/mcp\n` +
      `  database   ${hub.db.name}\n` +
      `  auth       ${TOKEN ? 'bearer token required' : 'none (loopback only)'}\n`,
  );
});
