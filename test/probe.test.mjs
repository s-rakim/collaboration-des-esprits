import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { candidates, probe } from '../src/probe.js';

/**
 * Adding a provider used to be a guessing game with two guesses in it — whether
 * the base URL wants /v1 on the end, and what the model is really called — and
 * getting either wrong produced an error from somebody else's server about
 * somebody else's field names. These pin down the asking that replaced it.
 */

test('the obvious repairs to a pasted URL are the ones tried', () => {
  // The bare host, which is what the documentation page shows.
  assert.deepEqual(candidates('https://integrate.api.nvidia.com'), [
    'https://integrate.api.nvidia.com',
    'https://integrate.api.nvidia.com/v1',
    'https://integrate.api.nvidia.com/openai/v1',
    'https://integrate.api.nvidia.com/api/v1',
  ]);

  // Already right: tried first, so a correct URL costs one request.
  assert.equal(candidates('https://api.openai.com/v1')[0], 'https://api.openai.com/v1');

  // A pasted endpoint rather than a base.
  assert.equal(candidates('https://api.x.test/v1/chat/completions')[0], 'https://api.x.test/v1');

  // Google hangs its compatibility layer off a versioned path, and it goes
  // early because every generic guess 404s there.
  const google = candidates('https://generativelanguage.googleapis.com');
  assert.equal(google[1], 'https://generativelanguage.googleapis.com/v1beta/openai');

  // A host with no scheme is still a host, and the scheme guessed depends on
  // where it points: a model on this machine is served over http, and assuming
  // https there fails in a way that looks like the app's fault.
  assert.equal(candidates('api.mistral.ai')[0], 'https://api.mistral.ai');
  assert.equal(candidates('localhost:11434')[0], 'http://localhost:11434');
  assert.equal(candidates('127.0.0.1:1234')[0], 'http://127.0.0.1:1234');
  assert.equal(candidates('192.168.1.50:8080')[0], 'http://192.168.1.50:8080');
  assert.deepEqual(candidates(''), []);
  assert.deepEqual(candidates('not a url at all'), []);
});

/** An endpoint that behaves like the real ones: 404 at the root, API under /v1. */
async function endpoint({ path = '/v1', models = ['a/one', 'b/two'], status = 200, body = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === `${path}/models`) {
      if (status !== 200) { res.writeHead(status); return res.end(body ?? 'nope'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(body ?? JSON.stringify({ data: models.map((id) => ({ id })) }));
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body>404 Not Found</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('a URL missing /v1 is found and reported as changed', async () => {
  const e = await endpoint();
  const found = await probe({ baseURL: e.base, apiKey: 'k' });
  e.close();
  assert.equal(found.ok, true);
  assert.equal(found.baseURL, `${e.base}/v1`);
  assert.equal(found.changed, true);
  assert.deepEqual(found.models, ['a/one', 'b/two']);
  // And it says what it tried, so a failure is a starting point.
  assert.equal(found.tried.length, 2);
  assert.equal(found.tried[0].ok, false);
});

test('a URL that was already right is not "changed", and costs one request', async () => {
  const e = await endpoint();
  const found = await probe({ baseURL: `${e.base}/v1`, apiKey: 'k' });
  e.close();
  assert.equal(found.changed, false);
  assert.equal(e.seen.length, 1, 'a correct URL should not be probed four times');
});

test('a refused key stops the search instead of trying more addresses', async () => {
  // 401 means the address is right and the credential is not; hunting for a
  // different address after that only wastes time and confuses the message.
  const e = await endpoint({ path: '', status: 401, body: 'invalid api key' });
  const found = await probe({ baseURL: e.base, apiKey: 'wrong' });
  e.close();
  assert.equal(found.ok, false);
  assert.equal(found.unauthorized, true);
  assert.equal(found.tried.length, 1);
  assert.match(found.error, /invalid api key/);
});

test('an endpoint that answers with nothing useful is not treated as working', async () => {
  for (const body of ['{"data":[]}', '{}', 'not json at all']) {
    const e = await endpoint({ body });
    const found = await probe({ baseURL: e.base, apiKey: 'k' });
    e.close();
    assert.equal(found.ok, false, `${body} should not count as a working endpoint`);
  }
});

test('the shapes providers actually return are all read', async () => {
  const shapes = [
    ['OpenAI', '{"object":"list","data":[{"id":"gpt-5.2"},{"id":"o4"}]}', ['gpt-5.2', 'o4']],
    ['a bare array', '[{"id":"one"},{"id":"two"}]', ['one', 'two']],
    ['Google', '{"models":[{"name":"models/gemini-3-pro"}]}', ['gemini-3-pro']],
    ['plain strings', '["alpha","beta"]', ['alpha', 'beta']],
  ];
  for (const [what, body, want] of shapes) {
    const e = await endpoint({ body });
    const found = await probe({ baseURL: e.base, apiKey: 'k' });
    e.close();
    assert.deepEqual(found.models, want, `${what} was not read`);
  }
});

test('the key goes where that provider wants it', async () => {
  const headers = [];
  const server = http.createServer((req, res) => {
    headers.push({ auth: req.headers.authorization, xi: req.headers['xi-api-key'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"one"}]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await probe({ baseURL: base, apiKey: 'k1' });
  assert.equal(headers[0].auth, 'Bearer k1');

  await probe({ baseURL: base, apiKey: 'k2', extra: { keyHeader: 'xi-api-key' } });
  assert.equal(headers[1].xi, 'k2');
  assert.equal(headers[1].auth, undefined, 'a named header means no bearer token as well');

  await probe({ baseURL: base, apiKey: 'k3', extra: { keyScheme: 'Token' } });
  assert.equal(headers[2].auth, 'Token k3');
  server.close();
});
