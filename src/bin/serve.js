#!/usr/bin/env node
import express from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hub, NotFound, Invalid } from '../core.js';
import { buildServer } from '../mcp/tools.js';
import { createConfig } from '../settings.js';
import { createSeats } from '../seats.js';
import { describeProviders, providerFor } from '../participants/providers/index.js';
import { createModelParticipant } from '../participants/agent.js';
import { createRouter } from '../bridges/commands.js';
import { createTelegram } from '../bridges/telegram.js';

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

/** Feed page size. The client follows `more` until it catches up. */
const FEED_PAGE = 500;

const hub = new Hub({ dbPath: process.env.ESPRITS_DB });
const config = createConfig(hub.db);
const seats = createSeats(hub.db);
seats.seedIfEmpty();

/**
 * Optional in-process participants. Assigned during startup below; the routes
 * close over these bindings, so they must exist before the app is built.
 */
/** Running model participants, keyed by seat name. */
const models = new Map();
let telegram = null;

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
         ORDER BY m.id LIMIT ?`,
      )
      .all(...(req.query.idea ? [since, req.query.idea, FEED_PAGE] : [since, FEED_PAGE]));
    // Report the last row actually returned, not the true head: a capped page
    // must leave the client's cursor where the next page begins, or everything
    // between here and the head is skipped.
    const capped = rows.length === FEED_PAGE;
    return {
      head: capped ? rows[rows.length - 1].id : hub.head(),
      more: capped,
      messages: rows.map((m) => ({
        id: m.id,
        idea: m.idea_slug,
        author: m.author,
        authorKind: m.author_kind,
        kind: m.kind,
        body: m.body,
        replyTo: m.reply_to ?? null,
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
 * Tag one agent with a question. The question is recorded as addressed to that
 * agent by name, which means only it (or the human) can answer — asking the
 * researcher should get the researcher's answer, not whoever happens to be idle.
 *
 * When the tagged agent is an in-process model participant, it is nudged
 * immediately rather than waiting for its watch loop; the answer arrives over
 * the live feed like any other message.
 */
app.post('/api/ask', (req, res) =>
  send(res, () => {
    const audience = String(req.body?.audience ?? 'agents');
    const q = hub.ask({
      idea: req.body.idea ?? null,
      body: req.body.body,
      by: req.body.as,
      audience,
      blocking: req.body.blocking !== false,
      replyTo: req.body.replyTo ?? null,
    });

    // A running participant already has a usable key for its own provider, so
    // its presence in the map is the only gate needed.
    const tagged = models.get(audience);
    if (tagged) {
      // Deliberately not awaited: a reply can take a while, and the page should
      // not sit on an open request when the feed will deliver the answer.
      tagged
        .askDirect({ body: req.body.body, idea: req.body.idea ?? null, from: req.body.as })
        .catch((err) => process.stderr.write(`${audience}: direct ask failed — ${err.message}\n`));
      return { ...q, nudged: audience };
    }
    return q;
  }),
);

// ------------------------------------------------------------------ setup page

app.get('/api/settings', (_req, res) => send(res, () => config.describe()));

app.post('/api/settings', (req, res) =>
  send(res, () => {
    const { settings = {}, secrets = {} } = req.body ?? {};
    const before = config.describe();
    const applied = [];
    for (const [k, v] of Object.entries(settings)) {
      // An env-locked field is read-only; saving it would appear to work and
      // then have no effect, which is worse than refusing.
      if (before.settings[k]?.locked) continue;
      config.set(k, v);
      applied.push(k);
    }
    for (const [k, v] of Object.entries(secrets)) {
      if (before.secrets[k]?.locked) continue;
      // An empty string means "clear it"; an unchanged masked preview is never
      // sent back by the page, so a blank field cannot wipe a stored key by
      // accident — the page sends only fields the user actually edited.
      config.setSecret(k, v === '' ? null : v);
      applied.push(k);
    }
    return { applied, ...config.describe() };
  }),
);

/**
 * Does this seat's key actually reach its provider? One real call through the
 * same adapter the seat uses, so a bad key or a wrong base URL fails here rather
 * than silently inside a watch loop.
 */
app.post('/api/seats/:name/test', async (req, res) => {
  const seat = seats.get(req.params.name);
  if (!seat) return res.status(404).json({ ok: false, error: `no seat named "${req.params.name}"` });
  if (!seat.keySet) return res.status(400).json({ ok: false, error: `no key set for ${seat.name}` });

  try {
    const provider = providerFor(seat.provider);
    const adapter = provider.adapter({
      apiKey: seats.keyFor(seat.name),
      model: seat.model,
      maxTokens: 1024,
      effort: 'low',
      baseURL: seat.baseURL || provider.baseURL || undefined,
    });
    const turn = adapter.startTurn({
      system: 'Answer in one word.',
      // A tool is declared because that is how the seat will really be used, so
      // a provider that rejects the tool shape fails here too.
      tools: [{
        name: 'noop',
        description: 'Do nothing. Never call this.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      }],
    });
    const step = await turn.send('Reply with the single word: ready');
    if (step.stopReason === 'refusal') {
      return res.status(400).json({ ok: false, error: 'the model declined the test request' });
    }
    res.json({
      ok: true,
      seat: seat.name,
      provider: seat.provider,
      model: seat.model,
      said: step.text || '(no text, but the call succeeded)',
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, status: err.status });
  }
});

// ---------------------------------------------------------- the model roster

app.get('/api/seats', (_req, res) =>
  send(res, () => ({
    // seats.all() already omits every credential, so there is no key to strip here.
    seats: seats.all().map((s) => ({ ...s, running: models.has(s.name) })),
    providers: describeProviders(),
  })),
);

app.post('/api/seats', (req, res) =>
  send(res, () => {
    const saved = seats.save(req.body ?? {});
    // Start or stop it to match, so the roster takes effect without a restart.
    syncSeats();
    return { ...saved, running: models.has(saved.name) };
  }),
);

app.delete('/api/seats/:name', (req, res) =>
  send(res, () => {
    const stopped = models.get(req.params.name);
    if (stopped) {
      stopped.stop();
      models.delete(req.params.name);
    }
    return { removed: seats.remove(req.params.name) };
  }),
);

// ------------------------------------------------------- talking to a model

app.get('/api/floor', (_req, res) => send(res, () => hub.floor()));

/**
 * Ask one model directly and get the answer in this request, rather than waiting
 * for its watch loop to notice. `model` names the seat; it defaults to the first
 * running one so a direct ask works before the user has picked a favourite.
 */
app.post('/api/models/ask', async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  if (!body) return res.status(400).json({ error: 'body is required' });

  // Which model was asked. Defaults to the first running seat, so "ask a model"
  // works before the user has thought about which one.
  const who = req.body.model ?? [...models.keys()][0];
  const participant = models.get(who);
  if (!participant) {
    return res.status(400).json({
      error: models.size
        ? `no model named "${who}" is running — ${[...models.keys()].join(', ')} are`
        : 'no model participants are running — add one at /setup',
    });
  }

  try {
    // Post the question first so the room sees what was asked, then let the
    // model answer into the same thread.
    hub.post({
      idea: req.body.idea ?? null,
      body: `@${participant.name} ${body}`,
      by: req.body.as,
      kind: 'question',
    });
    const r = await participant.askDirect({ body, idea: req.body.idea ?? null, from: req.body.as });
    res.json({ ok: true, model: participant.name, ...r });
  } catch (err) {
    const status = err instanceof NotFound ? 404 : err instanceof Invalid ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
});

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

// /setup is friendlier to type than /setup.html.
app.get('/setup', (_req, res) => res.redirect('/setup.html'));

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

/**
 * The model participants and the Telegram bridge run in this process when they
 * are configured, so `npm start` is the whole system. Each is optional and none
 * can take the server down: a missing key or a bad token leaves that piece idle
 * and logs why.
 */
/**
 * Bring the running participants in line with the saved roster. Called at boot
 * and after every roster edit, so adding a model in the browser puts it in the
 * chat without a restart.
 */
function syncSeats() {
  const wanted = new Map(seats.enabled().map((s) => [s.name, s]));

  for (const [name, running] of models) {
    const seat = wanted.get(name);
    // Stop anything disabled, removed, or reconfigured — the seat spec is
    // captured at construction, so a changed seat needs a fresh participant.
    if (!seat || running.model !== seat.model || running.role !== seat.role || running.provider !== seat.provider) {
      running.stop();
      models.delete(name);
    }
  }

  for (const seat of wanted.values()) {
    if (models.has(seat.name)) continue;
    if (!seat.keySet) {
      process.stdout.write(`${seat.name}: enabled but has no key for ${seat.provider} — add one at /setup\n`);
      continue;
    }
    const p = createModelParticipant({
      hub,
      seat,
      // Read through on every turn rather than captured, so a key replaced on
      // the setup page takes effect without restarting the seat.
      getKey: (n) => seats.keyFor(n),
      log: (m) => process.stdout.write(`${m}\n`),
    });
    models.set(seat.name, p);
    // One model failing must not take the others, or the server, down.
    p.run().catch((err) => {
      process.stderr.write(`${seat.name}: stopped — ${err.message}\n`);
      models.delete(seat.name);
    });
  }
}

function startParticipants() {
  syncSeats();

  const token = config.secret('telegram_token');
  const pairCode = config.secret('pair_code');
  if (config.bool('telegram_enabled')) {
    if (!token || !pairCode) {
      process.stdout.write('telegram: enabled but needs both a bot token and a pairing code — set them at /setup\n');
    } else {
      const router = createRouter({ hub, pairCode, defaultHandle: config.get('human_handle') });
      telegram = createTelegram({ hub, router, token, log: (m) => process.stdout.write(`${m}\n`) });
      telegram.run().catch((err) => process.stderr.write(`telegram: stopped — ${err.message}\n`));
    }
  }
}

app.listen(PORT, HOST, () => {
  process.stdout.write(
    `collaboration-des-esprits\n` +
      `  room       http://${HOST}:${PORT}/\n` +
      `  setup      http://${HOST}:${PORT}/setup\n` +
      `  connector  http://${HOST}:${PORT}/mcp\n` +
      `  database   ${hub.db.name}\n` +
      `  auth       ${TOKEN ? 'bearer token required' : 'none (loopback only)'}\n` +
      `  models     ${seats.enabled().map((s) => `${s.name}=${s.model}${s.keySet ? '' : ' (no key)'}`).join(', ') || 'none — add some at /setup'}\n` +
      `  telegram   ${config.bool('telegram_enabled') ? 'on' : 'off'}\n`,
  );
  startParticipants();
});

const shutdown = () => {
  try {
    for (const p of models.values()) p.stop();
    telegram?.stop();
    hub.close();
  } catch { /* best effort */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
