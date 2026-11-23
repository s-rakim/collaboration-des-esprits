import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { messagesAdapter, detectShape } from '../src/participants/messages.js';

// --------------------------------------------------------- the Messages shape

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

  const doesNot = http.createServer((req, res) => { res.writeHead(req.url.includes('/messages') ? 405 : 404); res.end('{}'); });
  await new Promise((r) => doesNot.listen(0, '127.0.0.1', r));
  assert.equal(await detectShape(`http://127.0.0.1:${doesNot.address().port}/v1`), 'messages');
  doesNot.close();

  // A provider that answers 404 to a GET on every path — as Groq does — is not
  // thereby speaking the other shape: it is asked the usual way.
  const neither = http.createServer((req, res) => { res.writeHead(404); res.end('{"error":"Unknown request URL"}'); });
  await new Promise((r) => neither.listen(0, '127.0.0.1', r));
  assert.equal(await detectShape(`http://127.0.0.1:${neither.address().port}/openai/v1`), 'chat');
  neither.close();

  // Unreachable is not an answer about shape; the real call reports the real
  // problem rather than this guessing at it.
  assert.equal(await detectShape('http://127.0.0.1:9/v1', { timeoutMs: 500 }), 'chat');
});

test('a whole turn runs in the Messages shape', async () => {
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

  const adapter = messagesAdapter({
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

  const adapter = messagesAdapter({
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

  const adapter = messagesAdapter({
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

