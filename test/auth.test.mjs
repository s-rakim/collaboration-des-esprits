import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const serve = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'serve.js');
const TOKEN = 'a-long-enough-secret';

/**
 * The room behind a token.
 *
 * A header alone cannot carry a browser: EventSource, an <img src> and a plain
 * link all make requests you cannot attach one to. So the token is exchanged
 * once for a cookie, and these pin down that exchange — including that it sends
 * a person somewhere they can act rather than a JSON error they cannot.
 */
let child;
let base;
let dir;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'esprits-auth-'));
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serve], {
    env: { ...process.env, ESPRITS_DB: join(dir, 'room.db'), PORT: '4457', ESPRITS_TOKEN: TOKEN, ESPRITS_FCC: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = 'http://127.0.0.1:4457';
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the server did not start');
});

test.after(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const page = (path, opts = {}) =>
  fetch(base + path, { redirect: 'manual', headers: { accept: 'text/html', ...(opts.headers ?? {}) }, ...opts });

test('health is reachable without the token, so a monitor can watch it', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('a browser with no token is sent somewhere it can do something', async () => {
  const res = await page('/design');
  assert.equal(res.status, 302);
  // And it remembers where you were going.
  assert.equal(res.headers.get('location'), '/unlock?next=%2Fdesign');
});

test('a script with no token gets an error it can read', async () => {
  const res = await fetch(`${base}/api/overview`);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /token/);
});

test('the wrong token does not open the room', async () => {
  const res = await fetch(`${base}/unlock`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=wrong&next=/',
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null, 'a failed attempt must not set a cookie');
});

test('the right token comes back as a cookie the browser can carry', async () => {
  const res = await fetch(`${base}/unlock`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(TOKEN)}&next=/design`,
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/design');

  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i, 'script on the page must not be able to read it');
  assert.match(cookie, /SameSite=Strict/i, 'another site must not be able to ride it');

  // And it works on the things a header could never have reached.
  const value = cookie.split(';')[0];
  assert.equal((await fetch(`${base}/api/overview`, { headers: { cookie: value } })).status, 200);
  assert.equal((await page('/', { headers: { cookie: value } })).status, 200);
});

test('a bearer token still works, for anything that is not a browser', async () => {
  const res = await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
});

test('signing in cannot be used to bounce somebody off this server', async () => {
  for (const evil of ['https://evil.test/x', '//evil.test/x', 'javascript:alert(1)']) {
    const res = await fetch(`${base}/unlock`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(TOKEN)}&next=${encodeURIComponent(evil)}`,
    });
    assert.equal(res.headers.get('location'), '/', `${evil} should not be followed`);
  }
});

test('the sign-in page does not leak the token it is checking', async () => {
  const body = await (await fetch(`${base}/unlock`)).text();
  assert.equal(body.includes(TOKEN), false);
});

test('the connector endpoint takes its token in the URL, and only it', async () => {
  /*
   * Most MCP clients give you one box for an address and no way to set a
   * header. Without this, reaching the room from a hosted client means either
   * no authentication or no connection, and the first is worse. It is confined
   * to /mcp because a page or an API call always has something behind it that
   * can send a header.
   */
  const mcp = await fetch(`${base}/mcp?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  assert.notEqual(mcp.status, 401, 'the token in the URL should be accepted at /mcp');

  const wrong = await fetch(`${base}/mcp?token=nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(wrong.status, 401);

  // Everything else must still insist on a header or a cookie.
  assert.equal((await fetch(`${base}/api/overview?token=${encodeURIComponent(TOKEN)}`)).status, 401);
  assert.equal((await fetch(`${base}/api/roster?token=${encodeURIComponent(TOKEN)}`)).status, 401);
});
