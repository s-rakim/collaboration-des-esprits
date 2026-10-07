import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import { createRouters, ROUTERS, ROUTER_ORDER } from '../src/routers.js';
import { anthropicAdapter, detectShape } from '../src/participants/anthropic.js';

/** A child process that never really starts, so nothing is spawned in a test. */
function fakeChild({ exitWith = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  if (exitWith !== null) setTimeout(() => child.emit('exit', exitWith), 10);
  return child;
}

test('the three routers are described honestly, and the collision is written down', () => {
  assert.deepEqual(ROUTER_ORDER, ['fcc', '9router', 'mcc']);
  for (const id of ROUTER_ORDER) {
    const r = ROUTERS[id];
    assert.match(r.base, /^http:\/\/127\.0\.0\.1:\d+\/v1$/, `${id} needs a local base URL`);
    assert.ok(r.command && r.install && r.home.startsWith('https://github.com/'));
    assert.ok(['chat', 'messages'].includes(r.shape), `${id} must declare a shape`);
  }
  // The one that would otherwise be found out the hard way: two of them listen
  // on the same port as shipped, so they cannot both be up.
  assert.equal(ROUTERS.fcc.base, ROUTERS.mcc.base);
  assert.notEqual(ROUTERS['9router'].base, ROUTERS.fcc.base);
  // And the one that cannot do media, so the page never offers it for voice.
  assert.equal(ROUTERS.fcc.media, false);
});

test('a router already running is used rather than started again', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"a"},{"id":"b"}]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  let spawned = 0;
  const routers = createRouters({
    spawnImpl: () => { spawned += 1; return fakeChild(); },
    fetchImpl: (url, opts) => fetch(String(url).replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${port}`), opts),
  });

  const out = await routers.start('fcc');
  assert.equal(out.ok, true);
  assert.equal(out.started, false);
  assert.match(out.note, /already running/);
  // Somebody else's router is as good as ours, and starting a second would
  // only collide with the first.
  assert.equal(spawned, 0, 'it should not have spawned anything');
  server.close();
});

test('a router that dies on startup says what it said, and how to install it', async () => {
  const routers = createRouters({
    spawnImpl: () => fakeChild({ exitWith: 127 }),
    // Nothing is listening, so health always fails.
    fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')),
  });

  const child = routers.start('fcc');
  await assert.rejects(child, (err) => {
    assert.match(err.message, /stopped straight away/);
    assert.match(err.message, /exit 127/);
    // The next thing to do, rather than only what went wrong — and the real
    // installer, since the command it installs is fcc-server and "fcc" is not
    // a command it ships at all.
    assert.match(err.message, /install\.ps1|install\.sh/);
    return true;
  });
  assert.equal(routers.running, null, 'a router that died must not be left marked as running');
});

test('only one router runs from here at a time', async () => {
  const alive = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  await new Promise((r) => alive.listen(0, '127.0.0.1', r));
  const port = alive.address().port;

  // 9Router answers; the others do not.
  const routers = createRouters({
    spawnImpl: () => fakeChild(),
    fetchImpl: (url, opts) => {
      const target = String(url);
      if (target.includes('20128')) return fetch(target.replace('20128', String(port)), opts);
      return Promise.reject(new Error('connect ECONNREFUSED'));
    },
  });

  const nine = await routers.start('9router');
  assert.equal(nine.ok, true);
  assert.equal(nine.started, false, 'it was already answering');

  alive.close();
});

test('stopping something nothing started is not an error', () => {
  const routers = createRouters({ spawnImpl: () => fakeChild(), fetchImpl: () => Promise.reject(new Error('no')) });
  const out = routers.stop();
  assert.equal(out.stopped, false);
  assert.match(out.note, /nothing was started/);
});

// --------------------------------------------------------- the Anthropic shape

test('which shape a router speaks is asked, not assumed', async () => {
  // A path that exists but takes POST answers 405; one that does not exist
  // answers 404. A POST would have been ambiguous, because a 404 could equally
  // be the router saying it has no such model.
  const serves = http.createServer((req, res) => {
    res.writeHead(req.url.includes('/chat/completions') ? 405 : 404);
    res.end('{}');
  });
  await new Promise((r) => serves.listen(0, '127.0.0.1', r));
  assert.equal(await detectShape(`http://127.0.0.1:${serves.address().port}/v1`), 'chat');
  serves.close();

  const doesNot = http.createServer((req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise((r) => doesNot.listen(0, '127.0.0.1', r));
  assert.equal(await detectShape(`http://127.0.0.1:${doesNot.address().port}/v1`), 'messages');
  doesNot.close();

  // Unreachable is not an answer about shape; the real call reports the real
  // problem rather than this guessing at it.
  assert.equal(await detectShape('http://127.0.0.1:9/v1', { timeoutMs: 500 }), 'chat');
});

test('a whole turn runs in the shape Free Claude Code serves', async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    bodies.push({ path: req.url, body });

    const answered = body.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    if (body.tools?.length && !answered) {
      return res.end(JSON.stringify({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'c1', name: body.tools[0].name, input: { q: 'importer' } },
        ],
      }));
    }
    res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Postgres.' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const adapter = anthropicAdapter({
    model: 'vendor/big', maxTokens: 512,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  });
  const turn = adapter.startTurn({
    system: 'You are in a room.',
    tools: [{ name: 'search', description: 'look it up', parameters: { type: 'object' } }],
  });

  const first = await turn.send('what database should the importer use?');
  assert.equal(first.stopReason, 'tool_use');
  assert.equal(first.toolCalls[0].name, 'search');
  assert.deepEqual(first.toolCalls[0].input, { q: 'importer' });
  // Text alongside a tool call is kept. The OpenAI shape has nowhere to put it.
  assert.match(first.text, /Let me look/);

  const second = await turn.toolResults([{ id: 'c1', output: 'Postgres has them.' }]);
  assert.equal(second.stopReason, 'end_turn');
  assert.match(second.text, /Postgres/);

  // It went to /messages, and the three translations happened.
  assert.ok(bodies[0].path.endsWith('/messages'));
  assert.equal(bodies[0].body.system, 'You are in a room.');
  assert.ok(bodies[0].body.messages.every((m) => m.role !== 'system'), 'system is a field, not a message');
  assert.deepEqual(bodies[0].body.tools[0].input_schema, { type: 'object' });

  // Roles alternate strictly here, so a tool result is a block on a user
  // message rather than a message of its own.
  const roles = bodies[1].body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user'], JSON.stringify(roles));
  assert.equal(bodies[1].body.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(bodies[1].body.messages.at(-1).content[0].tool_use_id, 'c1');

  server.close();
});

test('two tool results in one round become one user message', async () => {
  // A parallel call answered in a single round is ordinary, and sending those
  // as two user messages in a row is refused outright.
  let seen = null;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"stop_reason":"end_turn","content":[{"type":"text","text":"ok"}]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const adapter = anthropicAdapter({
    model: 'm', maxTokens: 64, baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  });
  const turn = adapter.startTurn({ system: 'x', tools: [] });
  turn.sent().push({ role: 'user', content: 'go' });
  turn.sent().push({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'a', type: 'function', function: { name: 'one', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'two', arguments: '{}' } },
    ],
  });
  await turn.toolResults([{ id: 'a', output: '1' }, { id: 'b', output: '2' }]);

  assert.deepEqual(seen.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(seen.messages.at(-1).content.length, 2);
  server.close();
});

test('a refused key is flagged rather than only worded, in this shape too', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"invalid x-api-key"}}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const adapter = anthropicAdapter({
    apiKey: 'nope', model: 'm', maxTokens: 8,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  });
  await assert.rejects(
    () => adapter.startTurn({ system: 'x', tools: [] }).send('hi'),
    (err) => {
      // Flagged, so nobody downstream has to pattern-match the sentence.
      assert.equal(err.unauthorized, true);
      return true;
    },
  );
  server.close();
});

test('each router is started by a command it actually installs', () => {
  // "fcc" is not a command Free Claude Code ships — its own pyproject names the
  // server entry point fcc-server — so starting it would have failed with the
  // same "not recognized" a missing program gives, and looked like our bug.
  assert.equal(ROUTERS.fcc.command, 'fcc-server');
  assert.equal(ROUTERS.mcc.command, 'mcc-server');
  assert.equal(ROUTERS['9router'].command, '9router');
  // And every card can say how to get the thing it cannot find.
  for (const id of ROUTER_ORDER) assert.ok(ROUTERS[id].install.trim().length > 10, id);
});
