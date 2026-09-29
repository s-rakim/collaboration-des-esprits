#!/usr/bin/env node
import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
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
import { createPlugins, PLUGIN_PRESETS, BUILT_IN } from '../plugins.js';
import { createWebBridge } from '../web.js';
import { readDocument, READABLE } from '../documents.js';
import { createSkills } from '../skills.js';
import { probe as probeEndpoint, tryKey } from '../probe.js';
import {
  TOKENS as THEME_TOKENS, FONTS as THEME_FONTS, PRESETS as THEME_PRESETS,
  DEFAULT_PRESET, DEFAULTS as THEME_DEFAULTS, cleanTheme, resolveTheme, themeCss,
} from '../theme.js';
import { mediaDir, transcribe, speak, generateImage, generateVideo } from '../media.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { createModelParticipant } from '../participants/agent.js';
import { BUILTIN_ROLES } from '../roles.js';
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
const plugins = createPlugins(hub.db, { log: (m) => process.stdout.write(`${m}\n`) });
const web = createWebBridge({ connections, log: (m) => process.stdout.write(`${m}\n`) });
// A skill's binary files are kept next to the generated media, so a skill that
// carries a diagram can still point at it.
const skills = createSkills(hub.db, {
  store: (path, data) => {
    const ext = path.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin';
    const file = `${randomUUID()}.${ext}`;
    writeFileSync(join(MEDIA, file), data);
    return `/media/${file}`;
  },
});

/**
 * Optional in-process participants. Assigned during startup below; the routes
 * close over these bindings, so they must exist before the app is built.
 */
/** Running model participants, keyed by seat name. */
const models = new Map();
let telegram = null;

const app = express();
app.use(express.json({ limit: '4mb' }));
// The sign-in page posts a form, so that one body shape is parsed too.
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

/**
 * Shared-secret auth, on when ESPRITS_TOKEN is set.
 *
 * Loopback-only by default means the common local setup needs no secret.
 * Reaching the room from another machine does, and that has to work in a
 * browser as well as from a script — which is what the cookie is for.
 *
 * A header alone cannot carry a browser: EventSource, <img src>, a plain link
 * and the media files all make requests you cannot attach a header to, so a
 * token-protected room would have had a dead feed and broken images even if
 * every fetch had been wrapped. Signing in once exchanges the token for a
 * cookie the browser then sends on everything by itself.
 */
const COOKIE = 'esprits_token';
const SESSION_DAYS = 30;

/** Constant-time-ish compare, so a wrong token leaks nothing by how long it took. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function cookieToken(req) {
  const raw = req.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function presentedToken(req) {
  const header = req.get('authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.get('x-esprits-token') ?? cookieToken(req);
}

/** A browser asking for a page, as opposed to a script asking for JSON. */
const wantsPage = (req) =>
  req.method === 'GET' && (req.get('accept') ?? '').includes('text/html');

// A shared secret with no rate limit is a secret you can guess at line speed.
const attempts = new Map();
function tooManyTries(ip) {
  const seen = attempts.get(ip) ?? { n: 0, until: 0 };
  if (Date.now() < seen.until) return true;
  if (seen.n >= 8) {
    attempts.set(ip, { n: 0, until: Date.now() + 60_000 });
    return true;
  }
  return false;
}

app.use((req, res, next) => {
  if (!TOKEN || req.path === '/health' || req.path === '/unlock') return next();
  if (sameSecret(presentedToken(req), TOKEN)) return next();
  // A person gets somewhere they can do something about it; a script gets JSON.
  if (wantsPage(req)) return res.redirect(`/unlock?next=${encodeURIComponent(req.originalUrl)}`);
  res.status(401).json({ error: 'bad or missing token' });
});

/**
 * Sign in. The token goes in once and comes back as a cookie, so the browser
 * carries it on the feed, the images and the pages without any of them knowing
 * about it.
 */
app.get('/unlock', (req, res) => {
  if (!TOKEN) return res.redirect('/');
  if (sameSecret(presentedToken(req), TOKEN)) return res.redirect(safeNext(req.query.next));
  res.type('html').send(unlockPage({ next: safeNext(req.query.next) }));
});

app.post('/unlock', (req, res) => {
  if (!TOKEN) return res.redirect('/');
  const ip = req.ip ?? 'unknown';
  if (tooManyTries(ip)) {
    return res.status(429).type('html').send(unlockPage({ next: '/', error: 'Too many tries. Wait a minute.' }));
  }

  const given = String(req.body?.token ?? '').trim();
  if (!sameSecret(given, TOKEN)) {
    const seen = attempts.get(ip) ?? { n: 0, until: 0 };
    attempts.set(ip, { ...seen, n: seen.n + 1 });
    return res.status(401).type('html').send(unlockPage({ next: safeNext(req.body?.next), error: 'That is not the token.' }));
  }

  attempts.delete(ip);
  // Secure only over HTTPS, or the cookie is dropped on a plain-http tailnet.
  const https = req.secure || (req.get('x-forwarded-proto') ?? '').split(',')[0] === 'https';
  res.cookie(COOKIE, TOKEN, {
    httpOnly: true,
    sameSite: 'strict',
    secure: https,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
  res.redirect(safeNext(req.body?.next));
});

app.post('/lock', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

/** Only ever send somebody back to a path on this server. */
function safeNext(raw) {
  const to = String(raw ?? '/');
  return /^\/(?!\/)/.test(to) ? to : '/';
}

/**
 * The sign-in page.
 *
 * Deliberately standalone: it is the one page served to somebody who has not
 * authenticated, so it borrows nothing from the app it is guarding.
 */
function unlockPage({ next = '/', error = '' } = {}) {
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Collaboration des Esprits</title><link rel="icon" href="data:,">
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e6e8ee;--dim:#98a0b3;--faint:#6b7488;--accent:#7aa2f7;--bad:#f7768e}
  @media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--panel:#fff;--line:#dde1e8;--text:#12151b;--dim:#5b6373;--faint:#8b93a5;--accent:#2d5bd7;--bad:#c3364f}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px;width:min(400px,100%)}
  h1{margin:0 0 4px;font-size:16px;letter-spacing:-.01em}
  p{margin:0 0 18px;color:var(--dim);font-size:13px}
  label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);margin-bottom:6px}
  input{width:100%;font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--line);
    border-radius:8px;padding:10px 12px}
  input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
  button{width:100%;margin-top:14px;font:inherit;cursor:pointer;background:var(--accent);color:#fff;
    border:0;border-radius:8px;padding:10px 14px;font-weight:550}
  .err{color:var(--bad);font-size:12.5px;margin:10px 0 0}
  .hint{color:var(--faint);font-size:11.5px;margin:16px 0 0;line-height:1.5}
</style></head>
<body>
  <form method="post" action="/unlock">
    <h1>Collaboration des Esprits</h1>
    <p>This room is reachable from outside this machine, so it asks for its token.</p>
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" autofocus
      placeholder="the value of ESPRITS_TOKEN">
    <input type="hidden" name="next" value="${esc(next)}">
    <button type="submit">Open the room</button>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <p class="hint">Set on the machine running the room, as <code>ESPRITS_TOKEN</code>.
      Signing in here keeps this browser signed in for 30 days.</p>
  </form>
</body></html>`;
}

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

// ------------------------------------------------------------------- plugins

app.get('/api/plugins', (_req, res) =>
  send(res, () => ({
    plugins: plugins.all(),
    calls: plugins.calls({ limit: 25 }),
    presets: PLUGIN_PRESETS,
    // The capabilities that are not plugins at all, with whether each is
    // actually usable right now — a catalogue that lists things you cannot use
    // without saying so is how a page ends up full of dead entries.
    builtIn: BUILT_IN.map((b) => {
      const kind = b.how.startsWith('connection:') ? b.how.slice('connection:'.length) : null;
      return { ...b, ready: kind ? connections.ofKind(kind).length > 0 : true, needs: kind };
    }),
  })),
);
app.post('/api/plugins', (req, res) => send(res, () => plugins.save(req.body ?? {})));
app.delete('/api/plugins/:name', (req, res) => send(res, () => ({ removed: plugins.remove(req.params.name) })));

/** Call one by hand, which is how you check a plugin before an agent relies on it. */
app.post('/api/plugins/:name/test', async (req, res) => {
  try {
    const out = await plugins.call({ name: req.params.name, args: req.body?.args ?? {}, agent: 'you' });
    res.json({ ok: true, preview: String(out).slice(0, 2000) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// -------------------------------------------------------------------- skills

app.get('/api/skills', (_req, res) =>
  send(res, () => ({ skills: skills.all(), roles: Object.keys(BUILTIN_ROLES).filter((r) => r !== 'human') })),
);

app.get('/api/skills/:name', (req, res) =>
  send(res, () => {
    const skill = skills.get(req.params.name);
    if (!skill) throw new NotFound(`no skill named "${req.params.name}"`);
    return skill;
  }),
);

app.post('/api/skills', (req, res) => send(res, () => skills.save(req.body ?? {})));

/**
 * Upload. A markdown file is one skill; a zip is a folder of them, or several.
 * Raw bytes rather than multipart, because the browser has the file already and
 * a boundary-encoded body would only have to be taken apart again.
 */
app.post('/api/skills/upload', express.raw({ type: '*/*', limit: '10mb' }), (req, res) =>
  send(res, () => {
    const filename = String(req.query.filename ?? 'skill.md').replace(/[/\\]/g, '_').slice(0, 200);
    if (!req.body?.length) throw new Invalid('no file received');
    const saved = skills.upload({ filename, bytes: req.body });

    // Say so in the room. A skill everyone can use is worth announcing, and it
    // puts the list in the transcript where the agents will read it.
    if (req.query.as) {
      const lines = saved.map((k) => `- **${k.name}** — ${k.description || k.title}`).join('\n');
      hub.post({
        idea: req.query.idea || null,
        by: req.query.as,
        kind: 'status',
        body: `Added ${saved.length === 1 ? 'a skill' : `${saved.length} skills`} from ${filename}:\n${lines}`,
      });
    }
    return { skills: saved.map((k) => ({ ...k, body: undefined })) };
  }),
);

app.post('/api/skills/:name/enabled', (req, res) =>
  send(res, () => skills.setEnabled(req.params.name, req.body?.enabled !== false)),
);

app.delete('/api/skills/:name', (req, res) => send(res, () => ({ removed: skills.remove(req.params.name) })));

// ------------------------------------------------------------------ the web

app.get('/api/web/search', async (req, res) => {
  try {
    res.json({ results: await web.search({ query: req.query.q, limit: Number(req.query.limit ?? 6) }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/web/fetch', async (req, res) => {
  try {
    res.json(await web.fetchPage({ url: req.body?.url }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------- what was checked

app.get('/api/checks', (req, res) =>
  send(res, () => ({ checks: hub.checks({ verdict: req.query.verdict, limit: Number(req.query.limit ?? 100) }) })),
);

// ----------------------------------------------------------------- dashboard

/** One call for the overview page, so it is not six round trips. */
app.get('/api/dashboard', (_req, res) =>
  send(res, () => {
    const o = hub.overview();
    const runs = hub.swarms({ limit: 6 });
    const checks = hub.checks({ limit: 40 });
    return {
      totals: o.totals,
      needsAttention: o.needsAttention,
      roster: o.roster,
      ideas: o.ideas.slice(0, 8),
      runs: runs.map((r) => ({ ...r, live: swarm.isRunning(r.id) })),
      artifacts: hub.artifacts({ limit: 6 }),
      generations: hub.generations({ limit: 8 }),
      schedules: hub.schedules().slice(0, 6),
      plugins: plugins.all().map((p) => ({ name: p.name, enabled: p.enabled, lastUsed: p.lastUsed })),
      skills: skills.all().map((k) => ({ name: k.name, title: k.title, enabled: k.enabled, used: k.used })),
      // The prefect's record: what has been checked, and what failed a check.
      checks: {
        total: checks.length,
        problems: checks.filter((c) => c.verdict !== 'supported').slice(0, 10),
      },
      capabilities: {
        chat: connections.ofKind('chat').length,
        search: connections.ofKind('search').length,
        image: connections.ofKind('image').length,
        video: connections.ofKind('video').length,
        transcribe: connections.ofKind('transcribe').length,
        speak: connections.ofKind('speak').length,
      },
      // Whether anybody is actually watching for invention, and who.
      prefect: seats.all()
        .filter((s) => s.role === 'prefect')
        .map((s) => ({ name: s.name, model: s.model, running: models.has(s.name), ready: s.ready })),
    };
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

    // Extract text where we sensibly can. Plain text is itself; PDF and the
    // Office formats are parsed, because a room you cannot hand a contract or a
    // spreadsheet to is a room that only reads what you retype into it. What is
    // never done is guessing at a format: an honest "not readable" beats a page
    // of mojibake for an agent to reason over.
    const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|sql|toml))/;
    const TEXT_EXT = /^(txt|md|markdown|json|csv|tsv|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|sql|toml|ini|env|log)$/;
    let text = '';
    let note = ' — not a format we can read, so the agents get the link only';
    if (TEXTUAL.test(mime) || TEXT_EXT.test(ext)) {
      const decoded = req.body.toString('utf8');
      // A binary file with a text-ish extension decodes to replacement chars;
      // storing that would poison every brief that includes it.
      if (!/\uFFFD/.test(decoded.slice(0, 2000))) text = decoded;
    } else {
      const extracted = readDocument(req.body, filename);
      if (extracted === null) {
        // Not one of ours.
      } else if (extracted) {
        text = extracted;
      } else {
        // We know the format and found nothing: a scanned page, or a file with
        // no text in it. Which of those it is, the room should be told.
        note = ' — we can read this format but found no text in it (scanned, or empty)';
      }
    }
    if (text) note = '';

    const url = `/media/${stored}`;
    const readable = req.body.length < 1024
      ? `${req.body.length} bytes`
      : req.body.length < 1024 * 1024
        ? `${(req.body.length / 1024).toFixed(0)} KB`
        : `${(req.body.length / 1024 / 1024).toFixed(1)} MB`;
    const body = `Attached **${filename}** (${readable})${note}` +
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
    has: {
      image: connections.ofKind('image').length > 0,
      video: connections.ofKind('video').length > 0,
      audio: connections.ofKind('speak').length > 0,
    },
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
    // The roles a seat can be given, from the same table the agents read their
    // charter from — so a role added there appears here without a second edit.
    roles: Object.entries(BUILTIN_ROLES)
      .filter(([id]) => id !== 'human')
      .map(([id, r]) => ({ id, summary: r.summary })),
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

/**
 * Work out what this endpoint wants, rather than making somebody guess it.
 *
 * Two guesses were in every new connection — whether the base URL ends in /v1,
 * and what the model is really called — and getting either wrong produced an
 * error from somebody else's server about somebody else's field names. This
 * asks the endpoint both questions and fixes the URL if one of the obvious
 * repairs is the answer.
 */
app.post('/api/connections/:name/probe', async (req, res) => {
  const conn = connections.resolve(req.params.name);
  if (!conn) return res.status(404).json({ ok: false, error: `no connection named "${req.params.name}"` });

  // The page sends what is typed in the row, which may not be saved yet — the
  // whole point is to check before committing to it.
  const baseURL = String(req.body?.baseURL ?? conn.baseURL ?? '').trim();
  if (!baseURL) return res.status(400).json({ ok: false, error: 'there is no base URL to check' });

  const found = await probeEndpoint({ baseURL, apiKey: conn.apiKey, extra: conn.extra });
  if (!found.ok) {
    return res.status(400).json({
      ...found,
      error: found.unauthorized
        ? `${found.baseURL} is the right address, but the key was refused (${found.error})`
        : `${found.error} — tried ${found.tried.map((t) => t.baseURL).join(', ') || 'nothing'}`,
    });
  }

  // A repaired URL is saved, because leaving the broken one in the box after
  // telling somebody it is broken is a step for nothing. A model this endpoint
  // has never heard of goes the same way: keeping it only means the next call
  // fails for the same reason, and now there is a list to pick from.
  const keepsModel = !conn.model || found.models.includes(conn.model);
  if (found.changed || !keepsModel) {
    connections.save({
      name: conn.name,
      kind: conn.kind,
      baseURL: found.baseURL,
      model: keepsModel ? conn.model : '',
    });
  }

  // Listing models often needs no credential at all, so an endpoint that
  // answered is not yet an endpoint you can use. One tiny call settles it here
  // rather than leaving somebody to find out at the next step.
  const usable = conn.kind === 'chat'
    ? await tryKey({
        baseURL: found.baseURL,
        apiKey: conn.apiKey,
        model: keepsModel && conn.model ? conn.model : found.models[0],
        extra: conn.extra,
      })
    : { ok: null };

  res.json({ ...found, clearedModel: keepsModel ? null : conn.model, key: usable });
});

/** One real call, so a wrong key or base URL fails here and not in a loop. */
app.post('/api/connections/:name/test', async (req, res) => {
  const conn = connections.resolve(req.params.name);
  if (!conn) return res.status(404).json({ ok: false, error: `no connection named "${req.params.name}"` });
  if (!conn.baseURL) return res.status(400).json({ ok: false, error: 'set a base URL on this connection first' });
  if (!conn.model) return res.status(400).json({ ok: false, error: 'set a model on this connection first' });
  // Say the obvious thing before making a call that can only fail. A provider
  // error about an unreachable host is a bad way to learn you left the key box
  // empty — and it is the reason this looks like "keys do not work".
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/.test(conn.baseURL);
  if (!conn.apiKey && !local) {
    return res.status(400).json({
      ok: false,
      error: `${conn.name} has no API key — paste one in the key box on this row (it is only needed for endpoints that are not on this machine)`,
    });
  }

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
      // speak() hands back the voice and format as well as the file, so the
      // test can say which voice you just heard rather than only that it worked.
      const spoken = await speak({ conn, text: 'ready', dir: MEDIA });
      return res.json({
        ok: true, kind: conn.kind, model: conn.model, url: spoken.url,
        said: `said "ready" in ${spoken.voice}`,
      });
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

// -------------------------------------------------------------------- theme

const readTheme = () => {
  try { return JSON.parse(hub.db.prepare("SELECT v FROM settings WHERE k = 'theme'").get()?.v ?? '{}'); }
  catch { return {}; }
};

/**
 * The stylesheet, with whatever colours this room has been given.
 *
 * Served rather than static so the overrides arrive in the same request as the
 * defaults. Applying them afterwards from script would mean every page flashed
 * somebody else's colours first, which is worse than not offering the setting.
 */
app.get('/theme.css', (_req, res) => {
  const base = readFileSync(join(here, '..', 'web', 'theme.css'), 'utf8');
  res.type('css').set('Cache-Control', 'no-cache').send(base + themeCss(readTheme()));
});

app.get('/api/theme', (_req, res) =>
  send(res, () => ({
    saved: readTheme(),
    applied: resolveTheme(readTheme()),
    tokens: THEME_TOKENS,
    fonts: THEME_FONTS,
    presets: THEME_PRESETS,
    defaultPreset: DEFAULT_PRESET,
    defaults: THEME_DEFAULTS,
  })),
);

app.post('/api/theme', (req, res) =>
  send(res, () => {
    const { theme, rejected } = cleanTheme(req.body ?? {});
    const empty = !Object.keys(theme.dark).length && !Object.keys(theme.light).length && !Object.keys(theme.fonts).length;
    if (empty) hub.db.prepare("DELETE FROM settings WHERE k = 'theme'").run();
    else {
      hub.db.prepare(
        `INSERT INTO settings (k, v, updated_at) VALUES ('theme', ?, ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
      ).run(JSON.stringify(theme), new Date().toISOString());
    }
    // What was dropped comes back, because silently discarding somebody's input
    // is how you get a bug report that says "it did not save".
    return { saved: theme, rejected };
  }),
);

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

/**
 * Make something and put it in the library.
 *
 * Audio belongs here rather than in a plugin of its own: generating a voice
 * line is the same act as generating a picture, and it runs through the same
 * connection that reads the room aloud, so there is one voice to configure.
 */
const MEDIA_KINDS = new Set(['image', 'video', 'audio']);
const CONNECTION_FOR = { image: 'image', video: 'video', audio: 'speak' };

app.post('/api/generate', async (req, res) => {
  const kind = MEDIA_KINDS.has(req.body?.kind) ? req.body.kind : 'image';
  const needs = CONNECTION_FOR[kind];
  const which = req.body?.connection || connections.ofKind(needs)[0]?.name;
  const conn = which ? connections.resolve(which) : null;
  if (!conn) {
    return res.status(400).json({ error: `no ${KINDS[needs].label.toLowerCase()} connection is configured — add one at /setup` });
  }

  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) return res.status(400).json({ error: 'a prompt is required' });

  try {
    let url;
    let voice;
    if (kind === 'video') {
      url = await generateVideo({ conn, prompt, dir: MEDIA });
    } else if (kind === 'audio') {
      ({ url, voice } = await speak({
        conn, text: prompt, dir: MEDIA,
        voice: req.body?.voice, speed: req.body?.speed, format: req.body?.format,
      }));
    } else {
      url = await generateImage({ conn, prompt, size: req.body?.size, dir: MEDIA });
    }

    let generation = null;
    if (req.body?.as) {
      hub.post({
        idea: req.body.idea ?? null,
        by: req.body.as,
        kind: 'message',
        // An audio file is a link, not an embed: the page turns it into a player.
        body: kind === 'audio' ? `${prompt}\n\n[audio](${url})` : `${prompt}\n\n![${kind}](${url})`,
      });
      generation = hub.recordGeneration({
        kind, prompt, url, model: conn.model, connection: conn.name,
        size: kind === 'audio' ? (voice ?? '') : (req.body?.size ?? ''),
        idea: req.body.idea ?? null,
        parent: req.body?.parent ?? null, by: req.body.as,
      });
    }
    res.json({ url, kind, model: conn.model, voice, generation });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Read a line of text aloud and hand back the file.
 *
 * This is the other half of live voice chat. Deliberately it neither posts nor
 * indexes: it is called once per reply as the room talks back, and a library
 * filling up with every sentence anybody said would be worse than useless.
 * Generating audio to keep goes through /api/generate.
 */
app.post('/api/speak', async (req, res) => {
  const which = req.body?.connection || connections.ofKind('speak')[0]?.name;
  const conn = which ? connections.resolve(which) : null;
  if (!conn) return res.status(400).json({ error: 'no voice is configured — add one at /setup' });

  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });

  try {
    const out = await speak({
      conn, text, dir: MEDIA,
      voice: req.body?.voice, speed: req.body?.speed, format: req.body?.format,
    });
    res.json({ ...out, connection: conn.name, model: conn.model });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Which voices are on offer, so the page can show a list rather than a text box. */
app.get('/api/voices', (_req, res) =>
  send(res, () => ({
    voices: connections.ofKind('speak').map((c) => ({
      connection: c.name,
      model: c.model,
      ready: c.keySet || /^https?:\/\/(127\.|localhost|\[::1\])/.test(c.baseURL),
      selected: c.extra?.voice ?? null,
      // What the preset knew about, plus anything the user added by hand.
      options: [...new Set([
        ...(Array.isArray(c.extra?.voices) ? c.extra.voices : []),
        ...(PRESETS.find((p) => p.kind === 'speak' && p.baseURL === c.baseURL)?.voices ?? []),
        ...(c.extra?.voice ? [c.extra.voice] : []),
      ])],
    })),
  })),
);

// ------------------------------------------------------- talking to a model

app.get('/api/floor', (_req, res) => send(res, () => hub.floor()));

/**
 * Stop whatever is running.
 *
 * Not a disconnect: every seat stays in the room and answers the next thing
 * said to it. This ends the turns in progress — including the request in
 * flight, which is the wait anybody actually wants to end, since a model
 * thinking for thirty seconds is exactly when you realise you asked the wrong
 * thing. Swarm runs are cancelled the same way.
 */
app.post('/api/interrupt', (_req, res) =>
  send(res, () => {
    const seats = [];
    for (const [name, participant] of models) {
      if (!participant.busy) continue;
      participant.interrupt();
      seats.push(name);
    }

    const runs = [];
    for (const run of hub.swarms({ limit: 50 })) {
      if (!swarm.isRunning(run.id)) continue;
      try { swarm.cancel(run.id); runs.push(run.id); } catch { /* finished as we asked */ }
    }
    return { stopped: { seats, runs } };
  }),
);

/** Who is mid-turn right now, which is what the stop button watches. */
app.get('/api/busy', (_req, res) =>
  send(res, () => ({
    seats: [...models.entries()].filter(([, p]) => p.busy).map(([name]) => name),
    runs: hub.swarms({ limit: 50 }).filter((r) => swarm.isRunning(r.id)).map((r) => r.id),
  })),
);

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
/**
 * Tidy URLs for the pages.
 *
 * The query string comes along. A redirect that drops it silently breaks every
 * link that carries one — /work?do=new-task arrives as a plain /work.html and
 * the thing you asked for never happens, with nothing to show you why.
 */
for (const page of ['setup', 'design', 'work', 'dashboard', 'plugins', 'artifacts']) {
  app.get(`/${page}`, (req, res) => {
    const query = req.originalUrl.slice(req.path.length);
    res.redirect(`/${page}.html${query}`);
  });
}

app.use(express.static(join(here, '..', 'web')));

// ------------------------------------------------------------------- listen

/**
 * What kind of address is this, and can it be bound without a secret?
 *
 * Loopback needs nothing. A private address — your LAN, or a Tailscale
 * interface — is already behind something that decides who may reach it, so a
 * token there is defence in depth rather than the only defence, and requiring
 * it would be friction for no gain.
 *
 * Everything else is refused without one. 0.0.0.0 in particular means *every*
 * interface, including whichever one faces the internet, and this database
 * holds every key you have pasted in.
 */
function bindKind(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.')) return 'loopback';
  if (h === '0.0.0.0' || h === '::' || h === '*') return 'everything';

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    // 100.64/10 is the shared-address range Tailscale hands out.
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)) return 'private';
    return 'public';
  }
  // Tailscale's own IPv6 range is inside fd00::/8, with the rest of unique-local.
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return 'private';
  // A hostname could be anything, so it is treated as though it were public.
  return 'public';
}

const BIND = bindKind(HOST);

if (BIND !== 'loopback' && !TOKEN) {
  if (BIND === 'private') {
    process.stdout.write(
      `esprits: binding ${HOST} with no ESPRITS_TOKEN.\n` +
        `  Anything already on that network can open this room and read every key in it.\n` +
        `  On a tailnet that is your own devices. On a shared network it is not.\n` +
        `  Set ESPRITS_TOKEN to ask for a password as well.\n\n`,
    );
  } else {
    // Binding beyond a private network with no secret would publish the whole
    // room — every idea, decision, handoff and API key — to anything that can
    // reach the port.
    process.stderr.write(
      `esprits: refusing to bind ${HOST} without ESPRITS_TOKEN set.\n` +
        `  ${HOST === '0.0.0.0' || HOST === '::' ? 'That is every interface, including any facing the internet.' : 'That address is not a private one.'}\n` +
        `  Set a token, bind a private or tailnet address instead, or leave ESPRITS_HOST at 127.0.0.1.\n`,
    );
    process.exit(1);
  }
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
  const needs = CONNECTION_FOR[kind] ?? kind;
  const conn = connections.resolve(connections.ofKind(needs)[0]?.name);
  if (!conn) throw new Error(`no ${KINDS[needs]?.label.toLowerCase() ?? needs} connection is configured`);
  let url;
  let voice;
  if (kind === 'video') url = await generateVideo({ conn, prompt, dir: MEDIA });
  else if (kind === 'audio') ({ url, voice } = await speak({ conn, text: prompt, dir: MEDIA }));
  else url = await generateImage({ conn, prompt, dir: MEDIA });
  try {
    hub.recordGeneration({ kind, prompt, url, model: conn.model, connection: conn.name, size: voice ?? '', idea, by });
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
        audio: (prompt) => makeMedia('audio', prompt, seat.name),
      },
      web,
      plugins,
      skills,
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
      `  auth       ${TOKEN ? 'token — sign in once per browser at /unlock' : `none (${BIND === 'loopback' ? 'loopback only' : 'anyone on this network'})`}\n` +
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
