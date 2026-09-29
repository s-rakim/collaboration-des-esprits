import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const serve = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'serve.js');

/**
 * Start the server with a given host and token, and report what it decided.
 *
 * The question these pin down is the one that decides whether a room is private:
 * which addresses may be bound without a password. Loopback is nobody's
 * business but yours; a tailnet or LAN address is already behind something that
 * decides who may reach it; 0.0.0.0 is every interface there is, and this
 * database holds every API key you have pasted in.
 */
async function boot(env) {
  const dir = mkdtempSync(join(tmpdir(), 'esprits-bind-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serve], {
    env: { ...process.env, ESPRITS_DB: join(dir, 'room.db'), PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const code = await new Promise((resolve) => {
    const done = setTimeout(() => { child.kill(); resolve(null); }, 4000);
    child.on('exit', (c) => { clearTimeout(done); resolve(c); });
  });
  rmSync(dir, { recursive: true, force: true });
  return { code, out, err, started: code === null };
}

test('loopback needs no token', async () => {
  const r = await boot({ ESPRITS_HOST: '127.0.0.1' });
  assert.equal(r.started, true, r.err);
  assert.match(r.out, /loopback only/);
});

test('every interface without a token is refused, and says why', async () => {
  for (const host of ['0.0.0.0', '::']) {
    const r = await boot({ ESPRITS_HOST: host });
    assert.equal(r.started, false, `${host} should not have started`);
    assert.equal(r.code, 1);
    assert.match(r.err, /refusing to bind/);
    assert.match(r.err, /every interface/);
  }
});

test('a public address without a token is refused', async () => {
  const r = await boot({ ESPRITS_HOST: '203.0.113.4' });
  assert.equal(r.started, false);
  assert.match(r.err, /refusing to bind/);
});

test('every interface is allowed once a token is set', async () => {
  const r = await boot({ ESPRITS_HOST: '0.0.0.0', ESPRITS_TOKEN: 'a-secret' });
  assert.equal(r.started, true, r.err);
  assert.match(r.out, /sign in once per browser/);
});

test('a tailnet address binds without a token, and warns about what that means', async () => {
  // Tailscale hands out addresses in 100.64.0.0/10. Nothing is listening on
  // this one, so the bind itself fails — but the decision happens first, and
  // the decision is what is being tested.
  const r = await boot({ ESPRITS_HOST: '100.101.102.103' });
  assert.match(r.out + r.err, /binding 100\.101\.102\.103 with no ESPRITS_TOKEN/);
  assert.match(r.out + r.err, /tailnet/);
  assert.doesNotMatch(r.err, /refusing to bind/);
});

test('a LAN address is treated the same way as a tailnet one', async () => {
  for (const host of ['192.168.1.50', '10.0.0.7', '172.20.1.1']) {
    const r = await boot({ ESPRITS_HOST: host });
    assert.doesNotMatch(r.err, /refusing to bind/, `${host} should be allowed`);
    assert.match(r.out + r.err, /with no ESPRITS_TOKEN/);
  }
});

test('a hostname is treated as public, because it could be anything', async () => {
  const r = await boot({ ESPRITS_HOST: 'room.example.com' });
  assert.equal(r.started, false);
  assert.match(r.err, /refusing to bind/);
});
