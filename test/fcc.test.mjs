import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messagesAdapter, toMessages } from '../src/participants/messages.js';
import { chatAdapter } from '../src/participants/chat.js';
import { parseSnippet } from '../src/connections.js';

/**
 * fcc-2.0: Free Claude Code as the way out.
 *
 * FCC serves Anthropic's /v1/messages and no /chat/completions, so these pin
 * the translation both ways, and then the whole path: a room started with
 * nothing configured finds FCC, seats its models, and answers a message.
 */

const TOOLS = [{ name: 'reply', description: 'say something', parameters: { type: 'object', properties: { body: { type: 'string' } } } }];

function fakeFetch(answers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = answers.shift();
    return new Response(JSON.stringify(next.body ?? next), { status: next.status ?? 200 });
  };
  return { impl, calls };
}

test('a seat on the messages shape gets the Anthropic adapter', () => {
  const a = chatAdapter({ api: 'messages', model: 'm', maxTokens: 10, baseURL: 'http://127.0.0.1:1/v1' });
  assert.equal(a.model, 'm');
  // Same face as the OpenAI adapter.
  const turn = a.startTurn({ system: 's', tools: [] });
  assert.equal(typeof turn.send, 'function');
  assert.equal(typeof turn.toolResults, 'function');
});

test('a turn goes out in Anthropic shape and its tool calls come back in ours', async () => {
  const { impl, calls } = fakeFetch([
    { content: [{ type: 'text', text: 'thinking' }, { type: 'tool_use', id: 'tu_1', name: 'reply', input: { body: 'hi' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
  ]);
  const turn = messagesAdapter({
    apiKey: 'tok', model: 'nvidia_nim/x', maxTokens: 99, baseURL: 'http://fcc.test/v1/', fetchImpl: impl,
  }).startTurn({ system: 'you are a seat', tools: TOOLS });

  const first = await turn.send('hello');
  assert.equal(first.stopReason, 'tool_use');
  assert.deepEqual(first.toolCalls, [{ id: 'tu_1', name: 'reply', input: { body: 'hi' } }]);

  const out = calls[0];
  assert.equal(out.url, 'http://fcc.test/v1/messages');
  assert.equal(out.body.system, 'you are a seat', 'the system prompt is a field, not a message');
  assert.equal(out.body.max_tokens, 99);
  assert.deepEqual(out.body.tools[0].input_schema, TOOLS[0].parameters);
  assert.equal(out.body.messages[0].role, 'user');
  assert.equal(out.headers['x-api-key'], 'tok');
  assert.equal(out.headers.authorization, 'Bearer tok');
  assert.ok(out.headers['anthropic-version']);

  const second = await turn.toolResults([{ id: 'tu_1', output: 'posted' }]);
  assert.equal(second.stopReason, 'end_turn');
  assert.equal(second.text, 'done');
  const back = calls[1].body.messages;
  assert.equal(back[1].role, 'assistant');
  assert.equal(back[1].content[1].type, 'tool_use');
  assert.deepEqual(back[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'posted' }] });
});

test('consecutive tool results share one user message', () => {
  const { messages } = toMessages([
    { role: 'system', content: 's' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'y', arguments: '{"k":1}' } },
    ] },
    { role: 'tool', tool_call_id: 'a', content: '1' },
    { role: 'tool', tool_call_id: 'b', content: '2' },
  ]);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(messages[2].content.length, 2);
  assert.deepEqual(messages[1].content[1].input, { k: 1 });
});

test('a refused token is flagged, not just worded', async () => {
  const { impl } = fakeFetch([{ status: 401, body: { error: { message: 'bad token' } } }]);
  const turn = messagesAdapter({ model: 'm', maxTokens: 1, baseURL: 'http://fcc.test/v1', fetchImpl: impl, maxRetries: 0 })
    .startTurn({ system: '', tools: [] });
  await assert.rejects(turn.send('hi'), (err) => err.unauthorized === true);
});

test("a Python example's quoted Authorization header gives up its key", () => {
  const parsed = parseSnippet(`import requests

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
headers = {
    "Authorization": "Bearer nvapi-TESTTESTTEST0123456789abcdefTEST",
    "Accept": "application/json",
}
payload = {
  "messages": [{"role": "user", "content": [{"type": "image_url",
    "image_url": {"url": "https://assets.ngc.nvidia.com/products/api-catalog/x.jpg"}}]}],
  "model": "moonshotai/kimi-k3",
  "max_tokens": 16384,
  "reasoning_effort": "max"
}
response = requests.post(invoke_url, headers=headers, json=payload)`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.apiKey, 'nvapi-TESTTESTTEST0123456789abcdefTEST');
  assert.equal(parsed.baseURL, 'https://integrate.api.nvidia.com/v1');
  assert.equal(parsed.model, 'moonshotai/kimi-k3');
  assert.equal(parsed.kind, 'chat');
  assert.equal(parsed.extra.effortParam, 'reasoning_effort');
});

test('a placeholder where the key goes is not taken for a key', () => {
  const parsed = parseSnippet(`curl https://api.example.com/v1/chat/completions \\
  -H "Authorization: Bearer $EXAMPLE_API_KEY" -d '{"model": "m"}'`);
  assert.equal(parsed.apiKey, '');
  assert.equal(parsed.baseURL, 'https://api.example.com/v1');
});

// ------------------------------------------------------------- the whole path

const serve = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'serve.js');

/**
 * A stand-in Free Claude Code and a real room pointed at it.
 * `answer(body)` decides what /v1/messages says to a seat's turn.
 */
async function roomOnFcc(t, port, answer) {
  const seen = [];
  const fcc = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/health') return json(200, { status: 'healthy' });
      if (req.url === '/v1/chat/completions') return json(404, { detail: 'Not Found' });
      if (req.url.startsWith('/v1/models')) {
        return json(200, { data: [{ id: 'nvidia_nim/test-model' }, { id: 'groq/other' }], default_model_id: 'nvidia_nim/test-model' });
      }
      if (req.url === '/v1/messages' && req.method === 'POST') {
        const body = JSON.parse(raw);
        seen.push(body);
        const [status, out] = answer(body, seen.length);
        return json(status, out);
      }
      json(404, { detail: 'Not Found' });
    });
  });
  await new Promise((r) => fcc.listen(0, '127.0.0.1', r));
  const fccBase = `http://127.0.0.1:${fcc.address().port}/v1`;

  const dir = mkdtempSync(join(tmpdir(), 'esprits-fcc-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serve], {
    env: { ...process.env, ESPRITS_DB: join(dir, 'room.db'), PORT: String(port), ESPRITS_FCC: fccBase, ESPRITS_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  t.after(() => { if (process.env.DEBUG_FCC) writeFileSync(process.env.DEBUG_FCC, log); child.kill(); fcc.close(); rmSync(dir, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => (await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const until = async (what, check) => {
    for (let i = 0; i < 80; i++) {
      try { const v = await check(); if (v) return v; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const feed = async () => (await get('/api/feed?since=0')).messages;
  return { seen, get, post, until, feed };
}

const answered = (body) => body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));

test('a fresh room finds Free Claude Code, seats it, and answers a plain hello', async (t) => {
  const room = await roomOnFcc(t, 4461, (body, n) => {
    if (body.max_tokens === 1) return [200, { content: [{ type: 'text', text: 'h' }], stop_reason: 'max_tokens' }];
    if (answered(body)) return [200, { content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' }];
    return [200, {
      content: [{ type: 'tool_use', id: `tu_${n}`, name: 'reply', input: { body: 'hello from fcc' } }],
      stop_reason: 'tool_use',
    }];
  });

  const status = await room.until('the room to connect to FCC', async () => {
    const s = await room.get('/api/fcc');
    return s.connection && s.seats.length ? s : null;
  });
  assert.equal(status.running, true);
  assert.equal(status.connection.model, 'nvidia_nim/test-model', "FCC's own default is the model used");
  assert.ok(status.seats.every((s) => s.enabled), 'the starter seats are in the chat');

  await room.post('/api/join', { name: 'rakim', role: 'human', kind: 'human' });
  // No @mention: talking in the room is talking to the room.
  await room.post('/api/post', { body: 'hello room', as: 'rakim' });

  const reply = await room.until('a model to answer', async () =>
    (await room.feed()).find((m) => m.authorKind !== 'human' && m.body === 'hello from fcc'));
  assert.ok(reply);
  const turn = room.seen.find((b) => b.max_tokens !== 1);
  assert.equal(turn.model, 'nvidia_nim/test-model');
  assert.ok(turn.system, 'the system prompt went as a field');
  assert.ok(turn.tools.every((tool) => tool.input_schema), 'tools went in Anthropic shape');
});

test('a model that cannot answer says why in the chat, once', async (t) => {
  const room = await roomOnFcc(t, 4462, () =>
    [401, { type: 'error', error: { type: 'authentication_error', message: 'NVIDIA_NIM_API_KEY was rejected' } }]);

  await room.until('the room to connect to FCC', async () => (await room.get('/api/fcc')).seats.length);
  await room.post('/api/join', { name: 'rakim', role: 'human', kind: 'human' });
  await room.post('/api/post', { body: 'anyone there?', as: 'rakim' });

  const notes = await room.until('the failure to be said in the room', async () => {
    const said = (await room.feed()).filter((m) => /could not answer/.test(m.body));
    return said.length >= 2 ? said : null;
  });
  assert.ok(notes.every((m) => m.authorKind === 'system'));
  assert.match(notes[0].body, /rejected the API key/);
  assert.match(notes[0].body, /Free Claude Code's admin page/);
  // A retry with the same failure is not said again.
  await new Promise((r) => setTimeout(r, 6000));
  const again = (await room.feed()).filter((m) => /could not answer/.test(m.body));
  assert.equal(again.length, notes.length);
});
