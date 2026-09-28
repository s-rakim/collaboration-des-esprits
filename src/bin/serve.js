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
import { createConnections, PRESETS, KINDS } from '../connections.js';
import { chatAdapter } from '../participants/chat.js';
import { createSwarmRunner } from '../swarm.js';
import { mediaDir, transcribe, speak, generateImage, generateVideo } from '../media.js';
import { writeFileSync } from 'node:fs';
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
const connections = createConnections(hub.db);
const seats = createSeats(hub.db, connections);
seats.seedIfEmpty();
const MEDIA = mediaDir(hub.db.name);
const swarm = createSwarmRunner({ hub, seats, log: (m) => process.stdout.write(`${m}\n`) });

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

// --------------------------------------------------------------------- swarm

app.get('/api/swarms', (_req, res) =>
  send(res, () => ({
    swarms: hub.swarms().map((s) => ({ ...s, live: swarm.isRunning(s.id) })),
    // Only seats that can actually make a call are offerable as the worker pool.
    seats: seats.all().filter((s) => s.ready).map((s) => ({ name: s.name, model: s.model })),
  })),
);

app.get('/api/swarms/:id', (req, res) =>
  send(res, () => ({ ...hub.getSwarm(req.params.id), live: swarm.isRunning(req.params.id) })),
);

/**
 * Start one. The run is deliberately not awaited: planning, fanning out and
 * merging take minutes, and the page follows progress by polling rather than
 * holding a request open for the duration.
 */
app.post('/api/swarms', (req, res) =>
  send(res, () => {
    const seat = String(req.body?.seat ?? '') || seats.enabled()[0]?.name;
    if (!seat) throw new Invalid('no model is configured to run the workers — add one at /setup');
    const run = hub.createSwarm({
      goal: req.body?.goal,
      seat,
      workers: req.body?.workers ?? 4,
      idea: req.body?.idea ?? null,
      by: req.body?.as,
    });
    swarm.run({ id: run.id }).catch((err) => process.stderr.write(`swarm ${run.id}: ${err.message}\n`));
    return run;
  }),
);

app.post('/api/swarms/:id/cancel', (req, res) => send(res, () => swarm.cancel(Number(req.params.id))));

app.post('/api/swarms/:id/retry', (req, res) =>
  send(res, () => {
    hub.retrySwarmTask({ taskId: req.body?.taskId });
    // Re-enter the loop so the retried piece is actually picked up.
    swarm.run({ id: Number(req.params.id) }).catch(() => {});
    return hub.getSwarm(req.params.id);
  }),
);

// ---------------------------------------------------------------- attachments

/**
 * A file dropped into the chat. Text is extracted on the way in so agents can
 * read it without each of them fetching and parsing the file; anything we
 * cannot read is still kept and linked.
 */
app.post('/api/attach', express.raw({ type: '*/*', limit: '30mb' }), (req, res) =>
  send(res, () => {
    const filename = String(req.query.filename ?? 'file').replace(/[/\\]/g, '_').slice(0, 200);
    const mime = req.get('content-type') ?? '';
    if (!req.body?.length) throw new Invalid('no file received');

    const ext = (filename.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin').toLowerCase();
    const stored = `${randomUUID()}.${ext}`;
    writeFileSync(join(MEDIA, stored), req.body);

    // Extract text where we sensibly can. Deliberately limited to formats that
    // are text underneath — guessing at binary formats produces garbage that is
    // worse than an honest "not readable".
    const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|sql|toml))/;
    const TEXT_EXT = /^(txt|md|markdown|json|csv|tsv|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|sql|toml|ini|env|log)$/;
    let text = '';
    if (TEXTUAL.test(mime) || TEXT_EXT.test(ext)) {
      const decoded = req.body.toString('utf8');
      // A binary file with a text-ish extension decodes to replacement chars;
      // storing that would poison every brief that includes it.
      if (!/\uFFFD/.test(decoded.slice(0, 2000))) text = decoded;
    }

    const url = `/media/${stored}`;
    const readable = req.body.length < 1024
      ? `${req.body.length} bytes`
      : req.body.length < 1024 * 1024
        ? `${(req.body.length / 1024).toFixed(0)} KB`
        : `${(req.body.length / 1024 / 1024).toFixed(1)} MB`;
    const body = `Attached **${filename}** (${readable})` +
      (text ? '' : ' — not a text format, so the agents get the link only') +
      `\n\n[${filename}](${url})`;

    const message = hub.post({ idea: req.query.idea || null, body, by: req.query.as, kind: 'message' });
    const attachment = hub.attach({
      messageId: message.id, idea: req.query.idea || null,
      filename, mime, size: req.body.length, url, text, by: req.query.as,
    });
    return { attachment: { ...attachment, text: undefined }, message };
  }),
);

app.get('/api/attachments', (req, res) =>
  send(res, () => ({ attachments: hub.attachments({ idea: req.query.idea }) })),
);
app.get('/api/attachments/:id', (req, res) => send(res, () => hub.getAttachment(req.params.id)));

// ----------------------------------------------------------------- schedules

app.get('/api/schedules', (_req, res) => send(res, () => ({ schedules: hub.schedules() })));
app.post('/api/schedules', (req, res) =>
  send(res, () => (req.body?.id
    ? hub.updateSchedule(req.body)
    : hub.createSchedule({ ...req.body, by: req.body?.as }))),
);
app.delete('/api/schedules/:id', (req, res) => send(res, () => hub.deleteSchedule({ id: req.params.id })));
/** Fire one now, which is how you check a schedule does what you meant. */
app.post('/api/schedules/:id/run', (req, res) => send(res, () => hub.runSchedule({ id: req.params.id })));

// -------------------------------------------------------- the media library

app.get('/api/generations', (req, res) =>
  send(res, () => ({
    generations: hub.generations({
      kind: req.query.kind || undefined,
      idea: req.query.idea || undefined,
      pinned: req.query.pinned === 'true' ? true : undefined,
      before: req.query.before || undefined,
      limit: Math.min(200, Number(req.query.limit ?? 60)),
    }),
    // Which capabilities are actually available, so the page can say so.
    has: { image: connections.ofKind('image').length > 0, video: connections.ofKind('video').length > 0 },
  })),
);

app.post('/api/generations/:id/pin', (req, res) =>
  send(res, () => hub.pinGeneration({ id: req.params.id, pinned: req.body?.pinned !== false })),
);

app.delete('/api/generations/:id', (req, res) => send(res, () => hub.deleteGeneration({ id: req.params.id })));

// ------------------------------------------------------------------ artifacts

app.get('/api/artifacts', (req, res) =>
  send(res, () => ({ artifacts: hub.artifacts({ idea: req.query.idea, project: req.query.project }) })),
);
app.get('/api/artifacts/:slug', (req, res) =>
  send(res, () => (req.query.version
    ? hub.artifactVersion({ ref: req.params.slug, version: req.query.version })
    : { ...hub.getArtifact(req.params.slug), history: hub.artifactHistory(req.params.slug) })),
);
app.post('/api/artifacts', (req, res) => send(res, () => hub.saveArtifact({ ...req.body, by: req.body?.as })));
app.post('/api/artifacts/:slug/restore', (req, res) =>
  send(res, () => hub.restoreArtifact({ ref: req.params.slug, version: req.body?.version, by: req.body?.as })),
);
app.delete('/api/artifacts/:slug', (req, res) =>
  send(res, () => hub.deleteArtifact({ ref: req.params.slug, by: req.query.as })),
);

// ------------------------------------------------------------------- projects

app.get('/api/projects', (_req, res) => send(res, () => ({ projects: hub.projects() })));
app.post('/api/projects', (req, res) =>
  send(res, () => (req.body?.slug
    ? hub.updateProject({ ref: req.body.slug, ...req.body, by: req.body.as })
    : hub.createProject({ name: req.body?.name, brief: req.body?.brief ?? '', by: req.body?.as }))),
);
app.post('/api/ideas/:ref/project', (req, res) =>
  send(res, () => hub.fileIdea({ ref: req.params.ref, project: req.body?.project ?? null, by: req.body?.as })),
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
    // Neither view carries a credential, so there is none to strip at the route.
    seats: seats.all().map((s) => ({ ...s, running: models.has(s.name) })),
    connections: connections.all(),
    kinds: KINDS,
    presets: PRESETS,
  })),
);

app.post('/api/seats', (req, res) =>
  send(res, () => {
    const saved = seats.save(req.body ?? {});
    syncSeats();
    return { ...saved, running: models.has(saved.name) };
  }),
);

app.delete('/api/seats/:name', (req, res) =>
  send(res, () => {
    const running = models.get(req.params.name);
    if (running) {
      running.stop();
      models.delete(req.params.name);
    }
    return { removed: seats.remove(req.params.name) };
  }),
);

// ---------------------------------------------------------------- connections

app.get('/api/connections', (_req, res) =>
  send(res, () => ({ connections: connections.all(), kinds: KINDS, presets: PRESETS })),
);

app.post('/api/connections', (req, res) =>
  send(res, () => {
    const saved = connections.save(req.body ?? {});
    // A key added here may be exactly what an idle seat was waiting for.
    syncSeats();
    return saved;
  }),
);

app.delete('/api/connections/:name', (req, res) =>
  send(res, () => ({ removed: connections.remove(req.params.name) })),
);

/** One real call, so a wrong key or base URL fails here and not in a loop. */
app.post('/api/connections/:name/test', async (req, res) => {
  const conn = connections.resolve(req.params.name);
  if (!conn) return res.status(404).json({ ok: false, error: `no connection named "${req.params.name}"` });
  if (!conn.model) return res.status(400).json({ ok: false, error: 'set a model on this connection first' });

  try {
    if (conn.kind === 'chat') {
      const adapter = chatAdapter({
        apiKey: conn.apiKey, model: conn.model, maxTokens: 512,
        effort: 'low', effortParam: conn.extra?.effortParam, baseURL: conn.baseURL,
      });
      const turn = adapter.startTurn({ system: 'Answer in one word.', tools: [] });
      const step = await turn.send('Reply with the single word: ready');
      if (step.stopReason === 'refusal') throw new Error('the model declined the test request');
      return res.json({ ok: true, kind: conn.kind, model: conn.model, said: step.text || '(no text, but the call succeeded)' });
    }

    if (conn.kind === 'image') {
      const url = await generateImage({ conn, prompt: 'a single small grey square, plain', dir: MEDIA });
      return res.json({ ok: true, kind: conn.kind, model: conn.model, said: 'generated an image', url });
    }

    if (conn.kind === 'speak') {
      const url = await speak({ conn, text: 'ready', dir: MEDIA });
      return res.json({ ok: true, kind: conn.kind, model: conn.model, said: 'generated audio', url });
    }

    // Transcription needs a clip to send and video costs real money and minutes,
    // so those are proven by using them rather than by a synthetic probe.
    return res.json({
      ok: true,
      kind: conn.kind,
      model: conn.model,
      said: conn.kind === 'transcribe'
        ? 'saved — it is exercised the first time you hold the mic button'
        : 'saved — video is exercised the first time you generate one',
      untested: true,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --------------------------------------------------------------------- media

app.use('/media', express.static(MEDIA, { maxAge: '1h' }));

/**
 * Turn a spoken clip into a message. The browser records, this transcribes and
 * posts, so the room sees speech as ordinary text that every agent can read.
 */
app.post('/api/voice', express.raw({ type: 'audio/*', limit: '25mb' }), async (req, res) => {
  const which = req.query.connection || connections.ofKind('transcribe')[0]?.name;
  const conn = which ? connections.resolve(which) : null;
  if (!conn) {
    return res.status(400).json({ error: 'no speech-to-text connection is configured — add one at /setup' });
  }
  if (!req.body?.length) return res.status(400).json({ error: 'no audio received' });

  try {
    const text = await transcribe({
      conn,
      audio: req.body,
      mimeType: req.get('content-type') ?? 'audio/webm',
      filename: `clip.${(req.get('content-type') ?? 'audio/webm').split('/')[1].split(';')[0]}`,
      // Bias the transcriber toward the names it would otherwise mangle.
      prompt: hub.roster().map((a) => a.name).join(', '),
    });

    const post = req.query.post !== 'false';
    if (!post) return res.json({ text, posted: false });

    const msg = hub.post({
      idea: req.query.idea || null,
      body: text,
      by: req.query.as,
      kind: 'message',
    });
    res.json({ text, posted: true, id: msg.id, mentions: msg.mentions });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  const kind = req.body?.kind === 'video' ? 'video' : 'image';
  const which = req.body?.connection || connections.ofKind(kind)[0]?.name;
  const conn = which ? connections.resolve(which) : null;
  if (!conn) return res.status(400).json({ error: `no ${kind} connection is configured — add one at /setup` });

  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) return res.status(400).json({ error: 'a prompt is required' });

  try {
    const url = kind === 'video'
      ? await generateVideo({ conn, prompt, dir: MEDIA })
      : await generateImage({ conn, prompt, size: req.body?.size, dir: MEDIA });

    let generation = null;
    if (req.body?.as) {
      hub.post({
        idea: req.body.idea ?? null,
        by: req.body.as,
        kind: 'message',
        body: `${prompt}\n\n![${kind}](${url})`,
      });
      generation = hub.recordGeneration({
        kind, prompt, url, model: conn.model, connection: conn.name,
        size: req.body?.size ?? '', idea: req.body.idea ?? null,
        parent: req.body?.parent ?? null, by: req.body.as,
      });
    }
    res.json({ url, kind, model: conn.model, generation });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

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

// Tidier than typing the .html.
app.get('/setup', (_req, res) => res.redirect('/setup.html'));
app.get('/design', (_req, res) => res.redirect('/design.html'));
app.get('/work', (_req, res) => res.redirect('/work.html'));
app.get('/artifacts', (_req, res) => res.redirect('/artifacts.html'));

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
/**
 * Generate and record in one step, so anything an agent makes reaches the
 * library the same way anything the human makes does.
 */
async function makeMedia(kind, prompt, by, idea = null) {
  const conn = connections.resolve(connections.ofKind(kind)[0]?.name);
  if (!conn) throw new Error(`no ${kind} connection is configured`);
  const url = kind === 'video'
    ? await generateVideo({ conn, prompt, dir: MEDIA })
    : await generateImage({ conn, prompt, dir: MEDIA });
  try {
    hub.recordGeneration({ kind, prompt, url, model: conn.model, connection: conn.name, idea, by });
  } catch {
    // Failing to index it must not lose the image itself.
  }
  return url;
}

function syncSeats() {
  const wanted = new Map(seats.enabled().map((s) => [s.name, s]));

  for (const [name, running] of models) {
    const seat = wanted.get(name);
    // Stop anything disabled, removed, or repointed — the seat spec is captured
    // at construction, so a changed seat needs a fresh participant.
    if (!seat || running.connection !== seat.connection || running.role !== seat.role) {
      running.stop();
      models.delete(name);
    }
  }

  for (const seat of wanted.values()) {
    if (models.has(seat.name)) continue;
    const p = createModelParticipant({
      hub,
      seat,
      resolve: (n) => seats.resolve(n),
      log: (m) => process.stdout.write(`${m}\n`),
      custom: () => ({ houseStyle: config.get('house_style'), aboutMe: config.get('about_me') }),
      // Resolved per call, so adding an image connection later lights the tool
      // up without restarting the seat.
      media: {
        image: (prompt) => makeMedia('image', prompt, seat.name),
        video: (prompt) => makeMedia('video', prompt, seat.name),
      },
    });
    models.set(seat.name, p);
    // One model failing must not take the others, or the server, down.
    p.run().catch((err) => {
      process.stderr.write(`${seat.name}: stopped — ${err.message}\n`);
      models.delete(seat.name);
    });
  }

  // Say once which seats are configured but not runnable, so a missing key is
  // visible in the log rather than only on the settings page.
  for (const s of seats.all()) {
    if (s.enabled && !s.ready) {
      process.stdout.write(`${s.name}: enabled but ${s.connectionMissing ? 'its connection is gone' : 'has no key yet'} — see /setup\n`);
    }
  }
}

/**
 * Fire due schedules. Checked once a minute, which is the granularity the
 * schedules themselves are expressed in — anything finer would be precision
 * the feature does not claim.
 */
function startScheduler() {
  const tick = () => {
    let due = [];
    try {
      due = hub.dueSchedules();
    } catch (err) {
      return process.stderr.write(`scheduler: ${err.message}\n`);
    }
    for (const s of due) {
      try {
        hub.runSchedule({ id: s.id });
        process.stdout.write(`scheduler: fired "${s.name}"\n`);
      } catch (err) {
        // One broken schedule must not stop the others, and it must not retry
        // in a tight loop either — push it to its next slot regardless.
        process.stderr.write(`scheduler: "${s.name}" failed — ${err.message}\n`);
        try {
          hub.updateSchedule({ id: s.id, everyMinutes: s.everyMinutes });
        } catch { /* it was deleted mid-tick */ }
      }
    }
  };
  setInterval(tick, 60_000).unref();
  // One pass at boot, so anything that came due while the server was down runs
  // rather than silently waiting for the next minute.
  setTimeout(tick, 2_000).unref();
}

function startParticipants() {
  syncSeats();
  startScheduler();

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
      `  models     ${seats.enabled().map((s) => `${s.name}=${s.model || '?'}`).join(', ') || 'none — add some at /setup'}\n` +
      `  endpoints  ${connections.all().map((c) => `${c.name}(${c.kind})`).join(', ') || 'none'}\n` +
      `  schedules  ${hub.schedules().filter((s) => s.enabled).length} active\n` +
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
