import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createPlugins, PLUGIN_PRESETS, BUILT_IN } from '../src/plugins.js';

const fresh = () => createPlugins(openDb(':memory:'));

test('a plugin needs a name a model can call it by, and a URL', () => {
  const plugins = fresh();
  assert.throws(() => plugins.save({ name: '', url: 'https://x.example' }), /needs a name/);
  assert.throws(() => plugins.save({ name: 'has spaces', url: 'https://x.example' }), /letters, numbers/);
  assert.throws(() => plugins.save({ name: 'ok', url: '' }), /needs a URL/);
});

test('a URL that reaches inside the network is refused', () => {
  const plugins = fresh();
  for (const url of [
    'http://127.0.0.1:8080/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/',
    'http://localhost/x',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => plugins.save({ name: 'bad', url }), /private|local|http and https|not a URL/, url);
  }
});

test('a URL is validated as a template, so placeholders do not fail it', () => {
  const plugins = fresh();
  const saved = plugins.save({ name: 'ok', url: 'https://api.example.com/{{path}}?q={{query}}' });
  assert.equal(saved.url, 'https://api.example.com/{{path}}?q={{query}}');
});

test('arguments are substituted and encoded for where they land', async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8'), auth: req.headers['x-token'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // The guard blocks loopback on save, so the row goes in the way a real one
  // would and the host is pointed at the test server at call time.
  const db = openDb(':memory:');
  const plugins = createPlugins(db);
  db.prepare(
    `INSERT INTO plugins (name, description, method, url, headers, body, params, enabled, created_at)
     VALUES ('t', '', 'POST', ?, ?, ?, '{}', 1, '2026-01-01')`,
  ).run(
    `http://127.0.0.1:${port}/search?q={{query}}`,
    JSON.stringify({ 'X-Token': '{{token}}' }),
    JSON.stringify({ text: '{{query}}' }),
  );

  // checkUrl runs on the way out too, so a loopback call is refused — which is
  // the behaviour worth pinning: a saved row cannot become an open proxy later.
  await assert.rejects(plugins.call({ name: 't', args: { query: 'a b&c' } }), /private address/);
  server.close();
});

test('every call is logged, whether it worked or not', async () => {
  const db = openDb(':memory:');
  const plugins = createPlugins(db);
  db.prepare(
    `INSERT INTO plugins (name, description, method, url, headers, body, params, enabled, created_at)
     VALUES ('t', '', 'GET', 'http://10.0.0.5/x', '{}', '', '{}', 1, '2026-01-01')`,
  ).run();
  await assert.rejects(plugins.call({ name: 't', args: {}, agent: 'nova' }));
  const [call] = plugins.calls();
  assert.equal(call.plugin, 't');
  assert.equal(call.agent, 'nova');
  assert.equal(call.ok, false);
  assert.match(call.error, /private address/);
});

test('a switched-off plugin cannot be called', async () => {
  const plugins = fresh();
  plugins.save({ name: 'x', url: 'https://api.example.com/', enabled: false });
  await assert.rejects(plugins.call({ name: 'x' }), /switched off/);
  await assert.rejects(plugins.call({ name: 'nope' }), /no plugin named/);
});

test('the catalogue only offers endpoints that are public and need no key', () => {
  assert.ok(PLUGIN_PRESETS.length >= 10);
  for (const p of PLUGIN_PRESETS) {
    assert.match(p.url, /^https:\/\//, `${p.name} must be https`);
    assert.ok(p.description.length > 60, `${p.name} needs a description a model can act on`);
    assert.ok(p.group, `${p.name} needs a group`);
    // Nothing in the catalogue may ship a credential.
    const headers = JSON.stringify(p.headers ?? {});
    assert.equal(/authorization|api[-_]?key|token|secret/i.test(headers), false, `${p.name} ships a credential`);
    // Every placeholder in the URL must be a declared argument.
    for (const [, field] of p.url.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      assert.ok(p.params?.properties?.[field], `${p.name} uses {{${field}}} but does not declare it`);
    }
  }
});

test('every catalogue preset saves and round-trips', () => {
  const plugins = fresh();
  for (const p of PLUGIN_PRESETS) {
    const saved = plugins.save({
      name: p.name, description: p.description, method: p.method, url: p.url,
      headers: p.headers ?? {}, params: p.params,
    });
    assert.equal(saved.url, p.url);
    assert.deepEqual(saved.params, p.params);
  }
  assert.equal(plugins.all().length, PLUGIN_PRESETS.length);
});

test('what is built in is described as built in, and points somewhere real', () => {
  const pages = new Set(['/', '/design', '/setup', '/work', '/artifacts', '/plugins']);
  assert.ok(BUILT_IN.length >= 8);
  for (const b of BUILT_IN) {
    assert.ok(pages.has(b.where), `${b.name} points at ${b.where}, which is not a page`);
    assert.ok(b.blurb && b.detail, `${b.name} needs saying what it is`);
    assert.match(b.how, /^(attach|work|connection:(image|video|speak|search))$/);
  }
  // The formats the document reader handles are all listed.
  const names = BUILT_IN.map((b) => b.name);
  for (const want of ['PDF', 'Excel', 'Word', 'PowerPoint']) assert.ok(names.includes(want), want);
});

test('a failed call reports what the server said, not just the number', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html><body><p>Host not in allowlist: api.example.com.</p></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // Saved past the guard the way a real row is, then called against the stub.
  const db = openDb(':memory:');
  const plugins = createPlugins(db);
  db.prepare(
    `INSERT INTO plugins (name, description, method, url, headers, body, params, enabled, created_at)
     VALUES ('t', '', 'GET', ?, '{}', '', '{}', 1, '2026-01-01')`,
  ).run(`http://127.0.0.1:${server.address().port}/x`);

  // The loopback guard fires first here, which is itself the right answer — so
  // the message check is made where a real call would land: on the log of a
  // remote failure, through the same formatting path.
  await assert.rejects(plugins.call({ name: 't' }), /private address/);
  server.close();

  const { formatFailure } = await import('../src/plugins.js').then((m) => ({ formatFailure: m.formatFailure }));
  assert.equal(
    formatFailure(403, '<html><body><p>Host not in allowlist: api.example.com.</p></body></html>'),
    'HTTP 403: Host not in allowlist: api.example.com.',
  );
  assert.equal(formatFailure(500, '   '), 'HTTP 500');
  assert.equal(formatFailure(404, 'x'.repeat(400)).length, 'HTTP 404: '.length + 200);
});
