import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/db.js';
import { createConfig } from '../src/settings.js';
import { createSandbox } from '../src/sandbox.js';
import { createTerminal } from '../src/workspace.js';
import { createPc, isPcCommand, words } from '../src/pc.js';

/**
 * The Agents' PC: what a person can see of it, change on it, and type at it.
 *
 * Run without a container — the person's explicit choice — because what is
 * tested here is the machine's own commands and its files, not its walls.
 */
function pcRoom() {
  const db = openDb(':memory:');
  const config = createConfig(db);
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'esprits-pc-')));
  const sandbox = createSandbox({ config, dataDir, env: { ESPRITS_SANDBOX_ENGINE: 'none' } });
  config.set('sandbox_unconfined', 'true');
  const terminal = createTerminal({ db, config, sandbox });
  const told = [];
  const threads = { running: () => [{ id: 7, title: 'The form', seat: 'ada', build: 1, buildTitle: 'A page' }], note: (id, n) => { told.push({ id, ...n }); return { heard: 'at its next step' }; } };
  const pc = createPc({ sandbox, terminal, threads });
  return { sandbox, terminal, pc, told, dir: sandbox.folder().hostDir };
}

test('the tree lists folders and files with when each last changed, and dependencies as one line', () => {
  const { sandbox, dir } = pcRoom();
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.js'), 'x');
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'y');
  const t = sandbox.tree();
  const by = Object.fromEntries(t.entries.map((e) => [e.path, e]));
  assert.equal(by.src.kind, 'dir');
  assert.equal(by['src/app.js'].kind, 'file');
  assert.equal(by['src/app.js'].size, 1);
  assert.ok(by['src/app.js'].mtime > 0);
  assert.equal(by.node_modules.kind, 'heavy');
  assert.equal(by['node_modules/left-pad'], undefined);
});

test('a change an agent makes shows as a new time on the file — that is what the explorer watches', () => {
  const { sandbox, dir } = pcRoom();
  writeFileSync(join(dir, 'a.txt'), 'one');
  const before = sandbox.tree().entries.find((e) => e.path === 'a.txt');
  writeFileSync(join(dir, 'a.txt'), 'one two');
  utimesSync(join(dir, 'a.txt'), new Date(), new Date(Date.now() + 5000));
  const after = sandbox.tree().entries.find((e) => e.path === 'a.txt');
  assert.notEqual(after.mtime, before.mtime);
  assert.equal(after.size, 7);
});

test('a file can be saved, renamed and deleted from the desktop — inside the folder and nowhere else', () => {
  const { sandbox, dir } = pcRoom();
  const w = sandbox.write({ path: 'notes/todo.md', text: '# todo\n' });
  assert.equal(readFileSync(join(dir, 'notes', 'todo.md'), 'utf8'), '# todo\n');
  assert.ok(w.mtime > 0);
  sandbox.move({ from: 'notes/todo.md', to: 'notes/done.md' });
  assert.ok(existsSync(join(dir, 'notes', 'done.md')));
  assert.throws(() => sandbox.move({ from: 'notes/done.md', to: 'notes/done.md' }), /already there/);
  sandbox.makeDir({ path: 'empty' });
  sandbox.remove({ path: 'notes' });
  assert.ok(!existsSync(join(dir, 'notes')));
  for (const path of ['../outside.txt', 'a/../../x', '..']) {
    assert.throws(() => sandbox.write({ path, text: 'x' }), /outside the folder/, path);
    assert.throws(() => sandbox.remove({ path }), /outside the folder/, path);
  }
  // The folder itself is not something to delete from under the room.
  assert.throws(() => sandbox.remove({ path: '' }), /outside the folder/);
});

test('saving does not write over a file an agent changed since it was opened', () => {
  const { sandbox, dir } = pcRoom();
  sandbox.write({ path: 'a.js', text: 'mine v1' });
  const opened = sandbox.read({ path: 'a.js' });
  writeFileSync(join(dir, 'a.js'), 'the agent rewrote this');
  utimesSync(join(dir, 'a.js'), new Date(), new Date(Date.now() + 5000));
  assert.throws(() => sandbox.write({ path: 'a.js', text: 'mine v2', expect: opened.mtime }), (err) => err.conflict === true);
  assert.equal(readFileSync(join(dir, 'a.js'), 'utf8'), 'the agent rewrote this');
  // Said again without the condition — the person chose theirs — it saves.
  sandbox.write({ path: 'a.js', text: 'mine v2' });
  assert.equal(readFileSync(join(dir, 'a.js'), 'utf8'), 'mine v2');
});

test('a line that starts pc is for the machine; anything else is for its shell', () => {
  assert.ok(isPcCommand('pc status'));
  assert.ok(isPcCommand('  PC ls src'));
  assert.ok(isPcCommand('pc'));
  assert.ok(!isPcCommand('pcregrep x'));
  assert.ok(!isPcCommand('echo pc status'));
  assert.deepEqual(words('pc link "C:\\My Projects\\app" mine'), ['pc', 'link', 'C:\\My Projects\\app', 'mine']);
});

test('the PC is driven from its command line: folders, files, switches', async () => {
  const { pc, sandbox, terminal, dir } = pcRoom();
  assert.match((await pc.run('pc', 'malcolm')).text, /pc status/);
  assert.match((await pc.run('pc status', 'malcolm')).text, /NOT sandboxed/);

  assert.match((await pc.run('pc use site', 'malcolm')).text, /working in site/);
  assert.equal(sandbox.folder().name, 'site');
  assert.match((await pc.run('pc folders', 'malcolm')).text, /\* site/);
  await pc.run('pc use project', 'malcolm');

  assert.ok((await pc.run('pc write hello.txt hi there\\nsecond line', 'malcolm')).ok);
  assert.equal(readFileSync(join(dir, 'hello.txt'), 'utf8'), 'hi there\nsecond line\n');
  assert.match((await pc.run('pc cat hello.txt', 'malcolm')).text, /hi there/);
  await pc.run('pc mkdir docs', 'malcolm');
  await pc.run('pc mv hello.txt docs/hello.txt', 'malcolm');
  const ls = (await pc.run('pc ls', 'malcolm')).text;
  assert.match(ls, /docs\//);
  assert.doesNotMatch(ls, /hello/);
  assert.match((await pc.run('pc ls docs', 'malcolm')).text, /hello\.txt/);
  await pc.run('pc rm docs', 'malcolm');
  assert.equal((await pc.run('pc ls', 'malcolm')).text, '(empty)');

  await pc.run('pc network off', 'malcolm');
  assert.equal((await sandbox.status()).network, false);
  await pc.run('pc agents off', 'malcolm');
  assert.equal(terminal.agentsAllowed(), false);

  const bad = await pc.run('pc frobnicate', 'malcolm');
  assert.equal(bad.ok, false);
  assert.match(bad.text, /pc help/);
  assert.equal((await pc.run('pc network maybe', 'malcolm')).ok, false);
});

test('a running command is listed and stopped from the command line, and a thread is told something', async () => {
  const { pc, terminal, told } = pcRoom();
  const long = terminal.run({ command: 'sleep 30', by: 'ada', kind: 'agent' });
  for (let i = 0; i < 40 && !terminal.running().length; i++) await new Promise((r) => setTimeout(r, 50));
  const ps = (await pc.run('pc ps', 'malcolm')).text;
  assert.match(ps, /sleep 30/);
  assert.match(ps, /The form/);
  assert.match((await pc.run('pc stop all', 'malcolm')).text, /stopped/);
  const ended = await long;
  assert.notEqual(ended.exitCode, 0);
  assert.equal((await pc.run('pc stop all', 'malcolm')).ok, false);

  assert.match((await pc.run('pc tell 7 use sqlite, not a json file', 'malcolm')).text, /thread 7 will hear that/);
  assert.deepEqual(told, [{ id: 7, text: 'use sqlite, not a json file', by: 'malcolm' }]);
});

test('what was typed at the PC is on the terminal\'s record with everything else', async () => {
  const { pc, terminal } = pcRoom();
  const out = await pc.run('pc status', 'malcolm');
  const rec = terminal.record({ command: 'pc status', by: 'malcolm', output: out.text, exitCode: 0 });
  assert.equal(rec.running, false);
  assert.equal(terminal.history().at(-1).command, 'pc status');
  assert.match(terminal.history().at(-1).output, /folder/);
});
