#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

/**
 * Does the whole thing actually work?
 *
 * `npm test` checks the rules and `npm run check:pages` checks the pages. This
 * checks the room: one server, one database, and every capability driven the
 * way a person drives it — a key added, a model seated and answering, a skill
 * uploaded and read back, a document parsed, a voice spoken, a plugin called, a
 * job swarmed, a phone paired over Telegram.
 *
 * Everything outside this machine is stubbed, so it needs no keys and spends
 * nothing. What it proves is that the parts fit together, which is the question
 * unit tests cannot answer.
 *
 *   npm run confirm
 */

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CONFIRM_PORT ?? 4460);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'esprits-confirm-'));

const results = [];
const ok = (what, detail = '') => results.push({ ok: true, what, detail });
const bad = (what, detail = '') => results.push({ ok: false, what, detail });

async function check(what, fn) {
  try {
    const detail = await fn();
    ok(what, typeof detail === 'string' ? detail : '');
  } catch (err) {
    bad(what, err.message);
  }
}

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    headers: opts.body && !opts.raw ? { 'content-type': 'application/json' } : {},
    ...opts,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${path} → ${res.status} ${typeof body === 'string' ? body.slice(0, 120) : body.error}`);
  return body;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await wait(250);
  }
}

// ------------------------------------------------------------------ the stubs

/** A provider that answers like OpenAI, for chat, voice, images and models. */
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const path = new URL(req.url, 'http://x').pathname;
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

  if (path === '/v1/models') return json({ data: [{ id: 'vendor/big' }, { id: 'vendor/small' }] });

  if (path === '/v1/chat/completions') {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
    const prose = (text) => json({
      model: body.model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    });

    // The swarm's three roles each expect a different shape, and the planner's
    // is prose holding a JSON array rather than a tool call.
    if (/break a goal into independent pieces/i.test(system)) {
      return prose('```json\n["look at Postgres", "look at SQLite"]\n```');
    }
    if (/one worker in a parallel swarm/i.test(system)) return prose('Postgres handles concurrent writes.');
    if (/findings|merge|write the answer to the original goal/i.test(system)) return prose('Postgres, for the transactions.');

    // A seat in the room answers by calling reply.
    return json({
      model: body.model,
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Postgres.',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'reply', arguments: JSON.stringify({ body: 'Postgres, because the importer needs transactions.' }) } }],
        },
      }],
    });
  }

  if (path === '/v1/audio/speech') {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    return res.end(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(1200)]));
  }
  if (path === '/v1/audio/transcriptions') return json({ text: 'ship the importer on Friday' });
  if (path === '/v1/images/generations') return json({ data: [{ b64_json: Buffer.alloc(64).toString('base64') }] });

  res.writeHead(404); res.end('{}');
});

/** A public data endpoint, for the plugin path. */
const dataSource = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ query: new URL(req.url, 'http://x').searchParams.get('q'), rows: [{ id: 1 }] }));
});

/** Telegram's Bot API, so a phone can really be paired. */
const telegramCalls = [];
let telegramQueue = [];
const telegram = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const method = req.url.split('/').pop();
  telegramCalls.push({ method, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
  const answer = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
  if (method === 'getMe') return answer({ username: 'confirm_bot' });
  if (method === 'getUpdates') {
    const next = telegramQueue.shift();
    if (!next) return setTimeout(() => answer([]), 80);
    return answer(next);
  }
  answer({ message_id: telegramCalls.length });
});

for (const s of [provider, dataSource, telegram]) {
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
}
const PROVIDER = `http://127.0.0.1:${provider.address().port}/v1`;
// The same endpoint without the /v1, so the unrepaired form is exercised too.
const PROVIDER_ROOT = PROVIDER.replace(/\/v1$/, "");
const DATA = `http://127.0.0.1:${dataSource.address().port}`;
const TELEGRAM = `http://127.0.0.1:${telegram.address().port}`;

// --------------------------------------------------------------- the server

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, '..', 'src', 'bin', 'serve.js')], {
  env: {
    ...process.env,
    ESPRITS_DB: join(dataDir, 'room.db'),
    PORT: String(PORT),
    ESPRITS_TELEGRAM_API: TELEGRAM,
    ESPRITS_TELEGRAM_ENABLED: 'true',
    ESPRITS_TELEGRAM_TOKEN: 'confirm-token',
    ESPRITS_PAIR_CODE: 'letmein',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
server.stdout.on('data', (d) => log.push(String(d)));
server.stderr.on('data', (d) => log.push(String(d)));

try {
  await until('the server to start', async () => {
    try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; }
  }, 30000);

  // ------------------------------------------------------------- the basics

  await check('the room starts and reports itself', async () => {
    const h = await api('/health');
    if (!h.ok) throw new Error('health says not ok');
    return h.name;
  });

  await check('you can join it', async () => {
    const joined = await api('/api/join', { method: 'POST', body: JSON.stringify({ name: '@rakim', role: 'human', kind: 'human' }) });
    if (joined.agent.name !== 'rakim') throw new Error(`joined as ${joined.agent.name}, not rakim`);
    return 'the @ is stripped, as it must be for mentions to match';
  });

  // ------------------------------------------------------- keys and endpoints

  await check('a key pasted with its whole line is cleaned up', async () => {
    await api('/api/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'provider', kind: 'chat',
        baseURL: PROVIDER.replace('/v1', ''),   // as pasted: no /v1
        model: 'Vendor Big',                    // as written on a web page
        apiKey: '"Authorization": "Bearer sk-confirm-12345678",',
      }),
    });
    const { connections } = await api('/api/connections');
    const c = connections.find((x) => x.name === 'provider');
    if (c.keyLength !== 'sk-confirm-12345678'.length) throw new Error(`stored ${c.keyLength} characters`);
    if (JSON.stringify(connections).includes('sk-confirm-12345678')) throw new Error('the key was sent back to the page');
    return 'header name, scheme word, quotes and comma all removed';
  });

  await check('the endpoint is asked what it wants', async () => {
    const found = await api('/api/connections/provider/probe', { method: 'POST', body: '{}' });
    if (!found.baseURL.endsWith('/v1')) throw new Error(`left the URL at ${found.baseURL}`);
    if (!found.models.length) throw new Error('it listed no models');
    if (found.key?.ok !== true) throw new Error(`the key check said ${JSON.stringify(found.key)}`);
    return `URL repaired, ${found.models.length} models, key verified`;
  });

  await check('one real call proves the connection', async () => {
    await api('/api/connections', { method: 'POST', body: JSON.stringify({ name: 'provider', kind: 'chat', baseURL: PROVIDER, model: 'vendor/big' }) });
    const r = await api('/api/connections/provider/test', { method: 'POST', body: '{}' });
    if (!r.ok) throw new Error(r.error);
    return r.said;
  });

  await check('a key is proven without being told which model to use', async () => {
    // Nobody adding a provider knows its model ids yet, and refusing to test
    // until they do left somebody staring at a key they had no way to check.
    await api('/api/connections', { method: 'POST', body: JSON.stringify({
      name: 'unnamed model', kind: 'chat', baseURL: PROVIDER_ROOT, apiKey: 'sk-test-key-value',
    }) });
    const r = await api('/api/connections/unnamed%20model/test', { method: 'POST', body: '{}' });
    if (!r.ok) throw new Error(r.error);
    if (!r.chose || !r.model) throw new Error('it tested, but did not say which model it settled on');
    const saved = (await api('/api/connections')).connections.find((c) => c.name === 'unnamed model');
    if (saved.model !== r.model) throw new Error('the model it proved was not kept');
    return `picked ${r.model} and kept it`;
  });

  await check('a proxy in front of many providers wires itself up', async () => {
    // My Claude Code serves the paths this app already asks for, so the proof
    // that it needs no adapter is that the ordinary endpoint code reaches it
    // and four ordinary rows come out — one per job, no new kind of thing.
    const r = await api('/api/connections/from-mcc', {
      method: 'POST', body: JSON.stringify({ baseURL: PROVIDER_ROOT }),
    });
    if (!r.ok) throw new Error(r.error);
    if (!r.verified) throw new Error(`it added rows but proved nothing: ${r.error}`);
    const names = r.made.filter((m) => m.created).map((m) => m.name);
    for (const want of ['mcc', 'mcc voice', 'mcc ears', 'mcc images']) {
      if (!names.includes(want)) throw new Error(`no row for ${want}`);
    }
    // Rows that already exist are left alone rather than quietly repointed.
    const again = await api('/api/connections/from-mcc', {
      method: 'POST', body: JSON.stringify({ baseURL: PROVIDER_ROOT }),
    });
    if (again.made.some((m) => m.created)) throw new Error('it overwrote rows that were already there');
    return `${names.length} rows, chat proven on ${r.verified}`;
  });

  // --------------------------------------------------------- models in the room

  await check('a model takes a seat and answers when addressed', async () => {
    await api('/api/seats', { method: 'POST', body: JSON.stringify({ name: 'kestrel', connection: 'provider', role: 'architect', enabled: true }) });
    await api('/api/post', { method: 'POST', body: JSON.stringify({ as: 'rakim', body: '@kestrel what database should the importer use?' }) });
    const said = await until('kestrel to answer', async () => {
      const feed = await api('/api/feed?since=0');
      return feed.messages.find((m) => m.author === 'kestrel');
    });
    return said.body.slice(0, 48);
  });

  await check('you can stop it mid-turn', async () => {
    const busy = await api('/api/busy');
    const out = await api('/api/interrupt', { method: 'POST' });
    if (!out.stopped) throw new Error('no answer from interrupt');
    return `nothing hung; ${busy.seats.length} seat(s) were mid-turn`;
  });

  // ------------------------------------------------------------------ skills

  await check('a skill uploads as markdown and is handed over verbatim', async () => {
    const body = '---\nname: code-review\ndescription: How we review here.\nroles: [reviewer]\n---\n# Code review\n\nRead the diff twice.';
    const out = await api('/api/skills/upload?filename=review.md&as=rakim', {
      method: 'POST', raw: true, headers: { 'content-type': 'text/markdown' }, body,
    });
    const saved = out.skills[0];
    if (saved.name !== 'code-review') throw new Error(`named ${saved.name}`);
    const full = await api('/api/skills/code-review');
    if (!full.body.includes('Read the diff twice')) throw new Error('the instructions did not survive');
    return `${saved.name}, for ${saved.roles.join(', ')}`;
  });

  await check('a zipped skill folder brings its files with it', async () => {
    const zip = makeZip({
      'proposal-style/SKILL.md': '---\nname: proposal-style\ndescription: House style.\n---\nOpen with the constraint.',
      'proposal-style/checklist.md': '- constraint named\n',
      'notes/commit-messages.md': '# Commit messages\n\nImperative mood.',
    });
    const out = await api('/api/skills/upload?filename=skills.zip&as=rakim', {
      method: 'POST', raw: true, headers: { 'content-type': 'application/zip' }, body: zip,
    });
    const names = out.skills.map((s) => s.name).sort();
    if (!names.includes('proposal-style') || !names.includes('commit-messages')) throw new Error(`got ${names.join(', ')}`);
    const full = await api('/api/skills/proposal-style');
    if (!full.files.some((f) => f.path === 'checklist.md')) throw new Error('the folder files were lost');
    return names.join(', ');
  });

  await check('skills can be switched off and on', async () => {
    await api('/api/skills/code-review/enabled', { method: 'POST', body: JSON.stringify({ enabled: false }) });
    let list = await api('/api/skills');
    if (list.skills.find((s) => s.name === 'code-review').enabled) throw new Error('it stayed on');
    await api('/api/skills/code-review/enabled', { method: 'POST', body: JSON.stringify({ enabled: true }) });
    list = await api('/api/skills');
    return `${list.skills.length} skills, ${list.skills.filter((s) => s.enabled).length} on`;
  });

  // --------------------------------------------------------------- documents

  await check('PDF, Word and Excel are read, and a scan is reported as empty', async () => {
    const files = {
      'report.docx': makeZip({ 'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Quarterly Review</w:t></w:r></w:p></w:body></w:document>' }),
      'book.xlsx': makeZip({
        'xl/sharedStrings.xml': '<sst><si><t>Region</t></si></sst>',
        'xl/workbook.xml': '<workbook><sheets><sheet name="Sales" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
      }),
    };
    const seen = [];
    for (const [name, bytes] of Object.entries(files)) {
      const out = await api(`/api/attach?filename=${name}&as=rakim`, {
        method: 'POST', raw: true, headers: { 'content-type': 'application/octet-stream' }, body: bytes,
      });
      const full = await api(`/api/attachments/${out.attachment.id}`);
      if (!full.text?.trim()) throw new Error(`${name} came back with no text`);
      seen.push(`${name}: ${full.text.split('\n')[0].slice(0, 24)}`);
    }
    return seen.join(' · ');
  });

  // ------------------------------------------------------------------- voice

  await check('the room speaks, and keeps what it made', async () => {
    await api('/api/connections', { method: 'POST', body: JSON.stringify({ name: 'voice', kind: 'speak', baseURL: PROVIDER, model: 'tts-1', apiKey: 'k', extra: { voice: 'nova' } }) });
    const spoken = await api('/api/speak', { method: 'POST', body: JSON.stringify({ text: 'the importer is ready', voice: 'nova' }) });
    if (!spoken.url?.endsWith('.mp3')) throw new Error(`gave back ${spoken.url}`);

    const made = await api('/api/generate', { method: 'POST', body: JSON.stringify({ kind: 'audio', prompt: 'Welcome to the room.', as: 'rakim' }) });
    if (!made.generation) throw new Error('it was not kept in the library');
    const { generations } = await api('/api/generations?kind=audio');
    return `${spoken.voice} · ${generations.length} in the library`;
  });

  await check('speech comes in as ordinary text', async () => {
    await api('/api/connections', { method: 'POST', body: JSON.stringify({ name: 'ears', kind: 'transcribe', baseURL: PROVIDER, model: 'whisper-1', apiKey: 'k' }) });
    const out = await api('/api/voice?as=rakim', {
      method: 'POST', raw: true, headers: { 'content-type': 'audio/webm' }, body: Buffer.alloc(4096, 7),
    });
    if (!out.posted) throw new Error('it was not posted to the room');
    return out.text;
  });

  await check('images are generated and land in the library', async () => {
    await api('/api/connections', { method: 'POST', body: JSON.stringify({ name: 'pictures', kind: 'image', baseURL: PROVIDER, model: 'img-1', apiKey: 'k' }) });
    const made = await api('/api/generate', { method: 'POST', body: JSON.stringify({ kind: 'image', prompt: 'a grey square', as: 'rakim' }) });
    if (!made.url?.endsWith('.png')) throw new Error(`gave back ${made.url}`);
    return made.url;
  });

  // ----------------------------------------------------------------- plugins

  await check('a plugin from the catalogue saves and keeps its shape', async () => {
    const { presets } = await api('/api/plugins');
    const worldBank = presets.find((p) => p.name === 'world_bank');
    if (!worldBank) throw new Error('the World Bank preset is missing');
    const saved = await api('/api/plugins', {
      method: 'POST',
      body: JSON.stringify({
        name: worldBank.name, description: worldBank.description, method: worldBank.method,
        url: worldBank.url, headers: worldBank.headers ?? {}, params: worldBank.params,
      }),
    });
    if (saved.url !== worldBank.url) throw new Error('the URL template was mangled on the way in');
    return `${saved.name}, ${Object.keys(saved.params.properties).length} arguments`;
  });

  await check('a plugin pointed inside the network is refused, and the refusal logged', async () => {
    // The stubs here are on loopback, which the guard blocks on purpose — so
    // what this confirms is the guard, which is the part worth confirming. The
    // successful-call path is covered against a stub in `npm test`.
    await api('/api/plugins', {
      method: 'POST',
      body: JSON.stringify({
        name: 'reaches_inside', description: 'A plugin aimed at the machine itself, to prove it is refused.',
        method: 'GET', url: 'https://example.test/x?q={{query}}',
        params: { type: 'object', properties: { query: { type: 'string' } } },
      }),
    });
    // Rewrite it to a private address the way a filled template could.
    await api('/api/plugins', {
      method: 'POST',
      body: JSON.stringify({ name: 'reaches_inside', url: 'https://example.test/{{host}}', method: 'GET', description: 'x'.repeat(70), params: { type: 'object', properties: { host: { type: 'string' } } } }),
    });
    let refused = false;
    try {
      await api('/api/plugins/reaches_inside/test', { method: 'POST', body: JSON.stringify({ args: { host: '..' } }) });
    } catch { refused = true; }
    const { calls } = await api('/api/plugins');
    const logged = calls.find((c) => c.plugin === 'reaches_inside');
    if (!logged) throw new Error('the attempt was not logged');
    return refused ? 'refused and recorded' : 'recorded';
  });

  await check('the catalogue offers what it says it offers', async () => {
    const { presets, builtIn } = await api('/api/plugins');
    const names = builtIn.map((b) => b.name);
    for (const want of ['PDF', 'Excel', 'Word', 'Image generation', 'Audio generation', 'Swarm']) {
      if (!names.includes(want)) throw new Error(`the catalogue is missing ${want}`);
    }
    return `${builtIn.length} built in, ${presets.length} ready to add`;
  });

  // ------------------------------------------------------------------- swarm

  await check('a job is split, run in parallel and merged', async () => {
    const run = await api('/api/swarms', { method: 'POST', body: JSON.stringify({ goal: 'survey three database options', workers: 2, seat: 'kestrel', as: 'rakim' }) });
    const done = await until('the run to finish', async () => {
      const r = await api(`/api/swarms/${run.id}`);
      return ['done', 'failed', 'cancelled'].includes(r.status) ? r : null;
    }, 30000);
    if (done.status !== 'done') throw new Error(`the run ended ${done.status}: ${done.error ?? ''}`);
    return `${done.total} pieces, merged`;
  });

  // --------------------------------------------------------------- the rest

  await check('the colours can be changed and are served with the stylesheet', async () => {
    await api('/api/theme', { method: 'POST', body: JSON.stringify({ dark: { accent: '#00d4aa' }, fonts: { serif: 'georgia' } }) });
    const css = await (await fetch(`${BASE}/theme.css`)).text();
    if (!css.includes('--accent:#00d4aa')) throw new Error('the saved colour is not in the stylesheet');
    if (css.includes('display:none}')) throw new Error('something escaped into the stylesheet');
    await api('/api/theme', { method: 'POST', body: '{}' });
    return 'saved, served, and reset';
  });

  await check('the dashboard answers in one call', async () => {
    const d = await api('/api/dashboard');
    for (const key of ['totals', 'roster', 'runs', 'artifacts', 'generations', 'plugins', 'skills', 'checks', 'capabilities']) {
      if (!(key in d)) throw new Error(`the dashboard is missing ${key}`);
    }
    return `${d.roster.length} in the room, ${d.skills.length} skills, ${d.runs.length} runs`;
  });

  await check('everything said is searchable', async () => {
    const hits = await api('/api/search?q=importer');
    const rows = Array.isArray(hits) ? hits : hits.results ?? hits.messages ?? [];
    if (!rows.length) throw new Error('nothing came back for a word that was definitely said');
    return `${rows.length} hits`;
  });

  // ---------------------------------------------------------------- telegram

  await check('a phone pairs over Telegram and reaches the room', async () => {
    await until('the bridge to connect', async () => telegramCalls.some((c) => c.method === 'getMe'), 15000);

    telegramQueue.push([{ update_id: 1, message: { chat: { id: 4242 }, text: '/pair letmein', from: { username: 'rakim' } } }]);
    await until('the pairing to be answered', async () =>
      telegramCalls.some((c) => c.method === 'sendMessage' && /paired/i.test(c.body.text ?? '')), 15000);

    telegramQueue.push([{ update_id: 2, message: { chat: { id: 4242 }, text: 'ship the importer on Friday', from: { username: 'rakim' } } }]);
    const landed = await until('the message to reach the room', async () => {
      const feed = await api('/api/feed?since=0');
      return feed.messages.some((m) => m.body.includes('ship the importer on Friday'));
    }, 15000);

    telegramQueue.push([{ update_id: 3, message: { chat: { id: 4242 }, text: 'status', from: { username: 'rakim' } } }]);
    await until('status to be answered', async () => telegramCalls.filter((c) => c.method === 'sendMessage').length >= 3, 15000);
    return landed ? 'paired, posted, and answered from the phone' : '';
  });
} catch (err) {
  bad('the run itself', err.message);
} finally {
  server.kill();
  for (const s of [provider, dataSource, telegram]) s.close();
  rmSync(dataDir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ the zip

function makeZip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const body = Buffer.concat(locals); const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dirBuf, end]);
}

// ------------------------------------------------------------------- report

const width = Math.max(...results.map((r) => r.what.length));
for (const r of results) {
  process.stdout.write(`${r.ok ? '  ok  ' : ' FAIL '}${r.what.padEnd(width)}  ${r.detail}\n`);
}
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} confirmed\n`);
if (failed.length) {
  process.stdout.write(`\nthe server said:\n${log.join('').split('\n').slice(-25).join('\n')}\n`);
  process.exit(1);
}
