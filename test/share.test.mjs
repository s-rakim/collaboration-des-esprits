import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addressKind, callerAllowed, makeToken, accessToken, reachable, shareBanner } from '../src/share.js';

const here = dirname(fileURLToPath(import.meta.url));

test('an address is this machine, a private network, or the internet', () => {
  for (const a of ['127.0.0.1', '127.9.9.9', '::1', 'localhost']) assert.equal(addressKind(a), 'loopback', a);
  for (const a of ['192.168.1.24', '10.8.0.2', '172.20.0.5', '100.101.102.103', 'fd7a:115c:a1e0::1', 'fe80::1%eth0']) {
    assert.equal(addressKind(a), 'private', a);
  }
  for (const a of ['8.8.8.8', '203.0.113.4', '172.32.0.1', '100.128.0.1', '2001:db8::1', 'room.example.com']) {
    assert.equal(addressKind(a), 'public', a);
  }
  assert.equal(addressKind('0.0.0.0'), 'everything');
});

test('only this machine and private networks are answered, however the address is written', () => {
  // A caller on IPv4 is often seen through an IPv6 socket, with a prefix on it.
  for (const a of ['::ffff:192.168.1.50', '::ffff:100.64.0.7', '::ffff:127.0.0.1', '10.0.0.9', '::1']) {
    assert.equal(callerAllowed(a), true, a);
  }
  for (const a of ['::ffff:8.8.8.8', '203.0.113.4', '2001:db8::1', '', undefined]) {
    assert.equal(callerAllowed(a), false, String(a));
  }
});

test('a token is made once, kept beside the database, and can be read off a screen', () => {
  const token = makeToken();
  assert.match(token, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/, 'no letters or digits that pass for each other');
  assert.notEqual(makeToken(), token);

  const dir = mkdtempSync(join(tmpdir(), 'esprits-share-'));
  const first = accessToken({ dbPath: join(dir, 'room.db'), env: {} });
  assert.equal(first.from, 'new');
  assert.equal(readFileSync(join(dir, 'access-token'), 'utf8').trim(), first.token);
  // The second start is the same room with the same way in, or every device would have to sign in again.
  const second = accessToken({ dbPath: join(dir, 'room.db'), env: {} });
  assert.deepEqual([second.token, second.from], [first.token, 'file']);
  // A token somebody chose wins, and is not written anywhere.
  const chosen = accessToken({ dbPath: join(mkdtempSync(join(tmpdir(), 'esprits-share-')), 'room.db'), env: { ESPRITS_TOKEN: 'my-own' } });
  assert.deepEqual([chosen.token, chosen.from, chosen.file], ['my-own', 'ESPRITS_TOKEN', null]);
});

const INTERFACES = {
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  'Wi-Fi': [{ address: '192.168.1.24', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
  'vEthernet (WSL)': [{ address: '172.28.96.1', family: 'IPv4', internal: false }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
  wg0: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
  'Ethernet 2': [{ address: '169.254.10.20', family: 'IPv4', internal: false }],
};

test('the addresses offered are the ones another device could actually use', () => {
  assert.deepEqual(reachable(INTERFACES).map((a) => [a.network, a.address]), [
    ['Tailscale', '100.101.102.103'],      // first: it works from anywhere
    ['VPN', '10.8.0.2'],
    ['Wi-Fi', '192.168.1.24'],
  ], 'not the loopback, a container bridge, a hypervisor switch, or an adapter with no network on it');
});

test('what is printed says where the room is on each network, and the way in', () => {
  const out = shareBanner({
    port: 4300, token: 'k7fq-m2xw-9hpd-3vbt', from: 'new', file: 'C:\\room\\data\\access-token',
    addresses: reachable(INTERFACES), platform: 'win32', name: 'DESKTOP-ABC',
  });
  assert.match(out, /Tailscale\s+http:\/\/100\.101\.102\.103:4300\//);
  assert.match(out, /Wi-Fi\s+http:\/\/192\.168\.1\.24:4300\//);
  assert.match(out, /http:\/\/desktop-abc:4300\//, 'the tailnet name, for when MagicDNS is on');
  assert.match(out, /Access token\s+k7fq-m2xw-9hpd-3vbt/);
  assert.match(out, /http:\/\/127\.0\.0\.1:4300\/unlock#k7fq-m2xw-9hpd-3vbt/);
  // The step people get stuck at on Windows, with the command that fixes it.
  assert.match(out, /netsh advfirewall firewall add rule .* localport=4300/);
  assert.doesNotMatch(shareBanner({ port: 4300, token: 't', from: 'file', file: 'f', addresses: reachable(INTERFACES), platform: 'linux' }), /netsh/);

  const alone = shareBanner({ port: 4300, token: 't', from: 'file', file: 'f', addresses: [], platform: 'linux' });
  assert.match(alone, /not on a network another device could reach/);
  const exposed = shareBanner({ port: 4300, token: 't', from: 'file', file: 'f', addresses: [{ address: '203.0.113.4', network: 'public', public: true }], platform: 'linux' });
  assert.match(exposed, /public address \(203\.0\.113\.4\)\. Callers from the internet are refused/);
});

test('npm run serve opens the room behind a token it made itself', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'esprits-share-'));
  const port = 4300 + Math.floor(Math.random() * 500) + 200;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, '..', 'src', 'bin', 'share.js')], {
    env: { ...process.env, ESPRITS_DB: join(dir, 'room.db'), PORT: String(port), ESPRITS_PORT: String(port), ESPRITS_TOKEN: '', ESPRITS_SANDBOX_ENGINE: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  for (let i = 0; i < 40 && !/Access token/.test(out); i++) await new Promise((r) => setTimeout(r, 100));

  assert.ok(existsSync(join(dir, 'access-token')), out);
  const token = readFileSync(join(dir, 'access-token'), 'utf8').trim();
  assert.match(out, new RegExp(`Access token\\s+${token}`));
  assert.match(out, /sandbox\s+off: /, 'what the sandbox is, in the banner with everything else');

  // Without the token: a script is refused, a browser is sent to sign in.
  assert.equal((await fetch(`${base}/api/rounds`)).status, 401);
  const page = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /^\/unlock\?next=/);
  // The sign-in page takes a token carried after the #, which no server sees.
  assert.match(await (await fetch(`${base}/unlock`)).text(), /location\.hash/);

  // With it: the room.
  assert.equal((await fetch(`${base}/api/rounds`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  const signIn = await fetch(`${base}/unlock`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}&next=/`,
  });
  assert.equal(signIn.status, 302);
  assert.match(signIn.headers.get('set-cookie'), /esprits_token=/);
});
