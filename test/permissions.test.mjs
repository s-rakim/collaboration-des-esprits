import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/db.js';
import { createConfig } from '../src/settings.js';
import { createSandbox } from '../src/sandbox.js';
import { createTerminal } from '../src/workspace.js';
import { createPermissions, hostOf, hostsIn, looksLikeWrite } from '../src/permissions.js';
import { plan, cdTarget, PROFILES } from '../src/shells.js';

function room() {
  const db = openDb(':memory:');
  const config = createConfig(db);
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'esprits-perm-')));
  const sandbox = createSandbox({ config, dataDir, env: { ESPRITS_SANDBOX_ENGINE: 'none' } });
  config.set('sandbox_unconfined', 'true');
  const terminal = createTerminal({ db, config, sandbox });
  const permissions = createPermissions({ config, sandbox });
  return { config, sandbox, terminal, permissions, dir: sandbox.folder().hostDir };
}

/** A browser that goes wherever it is told and remembers it. */
const fakeBrowser = () => {
  const b = {
    at: 'about:blank', did: [],
    open: async ({ url }) => { b.at = url; return { url, title: 'A page', text: 'hello' }; },
    search: async ({ query }) => { b.at = `https://search.example/?q=${query}`; return { url: b.at, title: 'Results', text: '' }; },
    read: async () => ({ url: b.at, title: 'A page', text: 'hello' }),
    where: async () => ({ url: b.at }),
    actOn: async (o) => { b.did.push(o); return { did: `${o.action}ed`, page: { url: b.at, title: 'A page', text: '' } }; },
  };
  return b;
};

test('out of the box agents can look anything up and change nothing', () => {
  const { permissions } = room();
  assert.deepEqual(permissions.site('https://example.com/a?b'), { host: 'example.com', read: true, write: false, listed: false });
  assert.deepEqual(permissions.site('github.com'), { host: 'github.com', read: true, write: false, listed: true });
  // A rule covers the site's own subdomains.
  assert.equal(permissions.site('https://api.github.com/repos').listed, true);
  assert.equal(permissions.site('https://notgithub.com').listed, false);
});

test('a site is a site however it was typed', () => {
  assert.equal(hostOf('https://www.GitHub.com:443/s-rakim/x?y#z'), 'github.com');
  assert.equal(hostOf('git@github.com'), 'github.com');
  assert.deepEqual(hostsIn('git clone https://github.com/a/b && curl -s http://127.0.0.1:3000/x; scp f me@files.example.org:/tmp').sort(),
    ['127.0.0.1', 'files.example.org', 'github.com']);
  assert.deepEqual(hostsIn('git remote add o git@gitlab.com:me/repo.git'), ['gitlab.com']);
});

test('the browser is checked page by page: read to look, write to act', async () => {
  const { permissions } = room();
  const raw = fakeBrowser();
  const browser = permissions.guardBrowser(raw);

  await browser.open({ url: 'https://docs.example.com/guide', by: 'ada', kind: 'agent' });
  await assert.rejects(() => browser.actOn({ action: 'click', target: 'Sign in' }), /may not write to docs\.example\.com/);
  assert.equal(raw.did.length, 0);

  permissions.allow('write', 'docs.example.com');
  await browser.actOn({ action: 'type', target: 'Search', text: 'limits', submit: true });
  assert.equal(raw.did.length, 1);

  permissions.allow('read', 'secret.example.com', false);
  await assert.rejects(() => browser.open({ url: 'https://secret.example.com/' }), /may not read secret\.example\.com/);
  // Wherever a person took the browser, an agent only reads it if it may read that site.
  raw.at = 'https://secret.example.com/inbox';
  await assert.rejects(() => browser.read(), /may not read secret\.example\.com/);

  // Reading only what is listed means no searching the open web either.
  permissions.allow('read', 'all', false);
  await assert.rejects(() => browser.search({ query: 'x' }), /cannot search the web/);
  await assert.rejects(() => browser.open({ url: 'https://example.org' }), /may not read example\.org/);
  permissions.allow('read', 'github.com');
  assert.equal((await browser.open({ url: 'https://github.com/a/b' })).url, 'https://github.com/a/b');
});

test('writing carries reading, and not reading rules out writing', () => {
  const { permissions } = room();
  permissions.allow('read', 'all', false);
  permissions.allow('write', 'api.example.com');
  assert.deepEqual([permissions.site('api.example.com').read, permissions.site('api.example.com').write], [true, true]);
  permissions.allow('read', 'api.example.com', false);
  assert.deepEqual([permissions.site('api.example.com').read, permissions.site('api.example.com').write], [false, false]);
  assert.throws(() => permissions.allow('write', 'not a site'), /not a site/);
});

test('a command that pushes, posts or publishes is a write — a clone or a fetch is not', () => {
  for (const c of ['git push origin main', 'git -C repo push', 'gh pr create --fill', 'gh issue comment 3 -b hi', 'curl -X POST https://api.github.com/x',
    'curl -d a=1 https://example.com', 'curl --data-binary @f https://example.com', 'npm publish', 'gh api repos/a/b/issues -f title=x']) {
    assert.ok(looksLikeWrite(c), c);
  }
  for (const c of ['git clone https://github.com/a/b', 'git pull', 'git fetch --all', 'gh pr list', 'gh repo view a/b', 'curl -s https://example.com',
    'echo "git pushed yesterday"', 'npm install', 'gh api repos/a/b']) {
    assert.equal(looksLikeWrite(c), '', c);
  }
});

test('an agent\'s command is refused for the sites it may not reach; a person\'s is not read at all', async () => {
  const { permissions, terminal } = room();
  const guarded = permissions.guardTerminal(terminal);

  assert.match(permissions.refusal('git push origin main'), /may not write to github\.com \(git push\)/);
  assert.match(permissions.refusal('gh pr create --fill'), /may not write to github\.com/);
  assert.equal(permissions.refusal('git clone https://github.com/a/b'), '');
  assert.equal(permissions.refusal('ls -la && node app.js'), '');

  await assert.rejects(() => guarded.run({ command: 'git push origin main', by: 'ada', kind: 'agent' }), (err) => err.denied === true);
  // Nothing was run, so nothing is on the record as having run.
  assert.equal(terminal.history().length, 0);

  // The person's own hands are not checked — the command runs (and fails on its own merits).
  const mine = await guarded.run({ command: 'echo git push origin main', by: 'malcolm', kind: 'human' });
  assert.equal(mine.exitCode, 0);

  permissions.allow('write', 'github.com');
  assert.equal(permissions.refusal('git push origin main'), '');
  permissions.allow('read', 'github.com', false);
  assert.match(permissions.refusal('git clone https://github.com/a/b'), /may not read github\.com/);
});

test('the GitHub token is given to commands, never shown, and withheld from agents who may not read GitHub', () => {
  const { permissions } = room();
  assert.deepEqual(permissions.githubEnv('agent'), {});
  const token = `ghp_${'NOTAREALTOKENnotarealtoken0000000000'}`;
  permissions.setGithubToken(token);
  const seen = JSON.stringify(permissions.view());
  assert.ok(!seen.includes(token), 'the token must not come back to a page');
  assert.equal(permissions.view().github.hasToken, true);
  assert.equal(permissions.githubEnv('agent').GH_TOKEN, token);
  assert.match(permissions.githubEnv('agent').GIT_CONFIG_KEY_0, /insteadOf$/);
  permissions.allow('read', 'github.com', false);
  assert.deepEqual(permissions.githubEnv('agent'), {});
  assert.equal(permissions.githubEnv('human').GH_TOKEN, token);
  assert.throws(() => permissions.setGithubToken('has spaces'), /does not look like/);
  permissions.setGithubToken('');
  assert.equal(permissions.view().github.hasToken, false);
});

test('a program is used only if a person listed it — to open a file with read, with its own arguments only with write', async () => {
  const { permissions, dir } = room();
  writeFileSync(join(dir, 'note.txt'), 'the contents');
  await assert.rejects(() => permissions.useApp({ name: 'cat', file: 'note.txt' }), /not a program agents may use/);

  const saved = permissions.save({ ...permissions.read(), apps: [{ name: 'cat', command: 'cat', read: true, write: false }, { name: 'bad', command: 'rm -rf / ; true', read: true }] });
  assert.equal(saved.apps.length, 1);
  assert.match(saved.rejected.join(), /one program, not a script/);
  assert.deepEqual(permissions.appsFor(), [{ name: 'cat', read: true, write: false }]);

  const opened = await permissions.useApp({ name: 'cat', file: 'note.txt', by: 'ada' });
  assert.match(opened.output, /the contents/);
  await assert.rejects(() => permissions.useApp({ name: 'cat', args: '/etc/hostname' }), /not run it with their own arguments/);
  await assert.rejects(() => permissions.useApp({ name: 'cat', file: '../../etc/hostname' }), /outside the PC's folder/);

  permissions.save({ ...permissions.read(), apps: [{ name: 'cat', command: 'cat', read: true, write: true }] });
  await assert.rejects(() => permissions.useApp({ name: 'cat', args: 'a; rm -rf x' }), /arguments only/);
  const ran = await permissions.useApp({ name: 'cat', args: '--version' });
  assert.match(ran.output, /exit 0/);
});

test('every shell is run by something real on the machine, or says what to install', () => {
  assert.deepEqual(PROFILES.map((p) => p.id), ['pc', 'ubuntu', 'kali', 'mac', 'gitbash', 'powershell', 'cmd']);

  // Windows, no Docker: WSL for the Linux ones, Git for Windows, and Windows' own.
  const win = { platform: 'win32', wsl: ['Ubuntu-24.04', 'kali-linux'], bash: 'C:\\Program Files\\Git\\bin\\bash.exe' };
  assert.deepEqual(plan({ id: 'ubuntu', have: win, command: 'ls' }).argv, ['-d', 'Ubuntu-24.04', '--', 'bash', '-lc', 'ls']);
  assert.equal(plan({ id: 'kali', have: win, command: 'ls' }).bin, 'wsl.exe');
  assert.equal(plan({ id: 'gitbash', have: win, command: 'ls' }).bin, win.bash);
  assert.equal(plan({ id: 'powershell', have: win, command: 'ls' }).bin, 'powershell.exe');
  assert.deepEqual(plan({ id: 'cmd', have: win, command: 'dir' }).argv, ['/d', '/s', '/c', 'dir']);
  assert.match(plan({ id: 'mac', have: win }).unavailable, /only runs on a Mac/);
  assert.match(plan({ id: 'kali', have: { platform: 'win32', wsl: [] } }).unavailable, /wsl --install -d kali-linux/);
  assert.match(plan({ id: 'gitbash', have: { platform: 'win32' } }).unavailable, /git-scm\.com/);

  // With a container engine: each in a container that sees only the folder.
  const linux = { platform: 'linux', bash: 'bash' };
  assert.equal(plan({ id: 'ubuntu', engine: 'docker', have: linux, command: 'ls' }).image, 'ubuntu:24.04');
  assert.equal(plan({ id: 'kali', engine: 'docker', have: linux, command: 'ls' }).image, 'kalilinux/kali-rolling');
  assert.equal(plan({ id: 'powershell', engine: 'docker', have: linux, command: 'ls' }).where, 'container');
  assert.equal(plan({ id: 'gitbash', engine: 'docker', have: linux, command: 'ls' }).where, 'exec');
  assert.equal(plan({ id: 'mac', engine: 'docker', have: linux, command: 'ls' }).where, 'exec');

  // Nothing is imitated: with nothing to run it, it is unavailable.
  assert.match(plan({ id: 'kali', have: linux }).unavailable, /Docker or Podman/);
  assert.match(plan({ id: 'cmd', have: linux }).unavailable, /only on Windows/);
  assert.equal(plan({ id: 'mac', have: { platform: 'darwin' }, command: 'ls' }).bin, 'zsh');
});

test('a line that only changes folder is known in every shell\'s spelling', () => {
  assert.deepEqual(cdTarget('cd src'), { to: 'src' });
  assert.deepEqual(cdTarget('cd /d "My Folder"'), { to: 'My Folder' });
  assert.deepEqual(cdTarget('Set-Location -Path src\\lib'), { to: 'src\\lib' });
  assert.deepEqual(cdTarget('cd'), { to: '' });
  assert.deepEqual(cdTarget('cd ~'), { to: '' });
  assert.equal(cdTarget('cd src && ls'), null);
  assert.equal(cdTarget('cdk deploy'), null);
});

test('a tab changes folder inside the PC\'s folder and nowhere else, and commands run where it stands', async () => {
  const { sandbox, terminal, dir } = room();
  sandbox.makeDir({ path: 'src/lib' });
  assert.equal(sandbox.resolveCwd({ cwd: '', to: 'src' }).cwd, 'src');
  assert.equal(sandbox.resolveCwd({ cwd: 'src', to: 'lib' }).cwd, 'src/lib');
  assert.equal(sandbox.resolveCwd({ cwd: 'src/lib', to: '..' }).cwd, 'src');
  assert.equal(sandbox.resolveCwd({ cwd: 'src', to: '' }).cwd, 'src');
  assert.equal(sandbox.resolveCwd({ cwd: '', to: join(dir, 'src') }).cwd, 'src');
  assert.throws(() => sandbox.resolveCwd({ cwd: '', to: '../..' }), /outside the PC's folder/);
  assert.throws(() => sandbox.resolveCwd({ cwd: '', to: '/etc' }), /outside the PC's folder/);
  assert.throws(() => sandbox.resolveCwd({ cwd: '', to: 'nope' }), /no folder nope/);

  const r = await terminal.run({ command: 'pwd', by: 'malcolm', cwd: 'src/lib' });
  assert.equal(r.output.trim(), join(dir, 'src', 'lib'));
  assert.equal(r.shell, 'pc');
  const b = await terminal.run({ command: 'echo $0', by: 'malcolm', shell: 'gitbash' });
  assert.match(b.output, /bash/);
  assert.equal(terminal.history({ shell: 'gitbash' }).length, 1);
  await assert.rejects(() => terminal.run({ command: 'dir', by: 'malcolm', shell: 'cmd' }), /only on Windows/);
});

test('emptying the PC removes what is in the folder and keeps the folder — and never a folder of the person\'s own', () => {
  const { sandbox, dir } = room();
  sandbox.write({ path: 'a/b/c.txt', text: 'x' });
  sandbox.write({ path: 'top.txt', text: 'y' });
  assert.deepEqual(sandbox.empty(), { folder: 'project', removed: 2 });
  assert.equal(sandbox.tree().entries.length, 0);
  assert.equal(sandbox.folder().hostDir, dir);

  const mine = realpathSync(mkdtempSync(join(tmpdir(), 'esprits-mine-')));
  writeFileSync(join(mine, 'keep.txt'), 'mine');
  sandbox.link({ path: mine });
  assert.throws(() => sandbox.empty(), /not emptied from here/);
  assert.equal(sandbox.tree().entries.length, 1);
});
