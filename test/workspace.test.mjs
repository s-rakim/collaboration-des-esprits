import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';

import { openDb } from '../src/db.js';
import { createConfig } from '../src/settings.js';
import { createTerminal } from '../src/workspace.js';

const fresh = () => {
  const db = openDb(':memory:');
  const config = createConfig(db);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'esprits-ws-')));
  return { db, config, dir, terminal: createTerminal({ db, config }) };
};

test('nothing runs until a person has chosen a folder', async () => {
  const { terminal } = fresh();
  assert.equal(terminal.folder().ok, false);
  await assert.rejects(() => terminal.run({ command: 'echo hi', by: 'malcolm' }), /no project folder has been chosen/);
});

test('the folder has to be a real project folder, not everything the account owns', () => {
  const { terminal, dir } = fresh();
  assert.throws(() => terminal.setFolder(join(dir, 'nope')), /does not exist/);
  writeFileSync(join(dir, 'a-file'), 'x');
  assert.throws(() => terminal.setFolder(join(dir, 'a-file')), /a file, not a folder/);
  // "The project" being the whole drive or the whole home folder is the choice
  // that turns one mistaken command into a very bad afternoon.
  assert.throws(() => terminal.setFolder(parse(dir).root), /not the whole drive/);
  assert.throws(() => terminal.setFolder(homedir()), /not the home folder itself/);
  assert.equal(terminal.setFolder(`"${dir}"`).dir, dir, 'a path pasted with its quotes still works');
});

test('a command starts in the folder, and is written down with who ran it', async () => {
  const { terminal, dir } = fresh();
  terminal.setFolder(dir);
  const made = await terminal.run({ command: 'echo built > out.txt && echo done', by: 'malcolm' });
  assert.equal(made.exitCode, 0);
  assert.match(made.output, /done/);
  assert.ok(existsSync(join(dir, 'out.txt')), 'the file should have landed in the project folder');

  const byAgent = await terminal.run({ command: 'node -e "process.exit(3)"', by: 'kestrel', kind: 'agent', thread: 7 });
  assert.equal(byAgent.exitCode, 3);

  // One terminal, two kinds of hand on it. The record is what keeps it legible.
  const all = terminal.history();
  assert.deepEqual(all.map((r) => [r.by, r.kind]), [['malcolm', 'human'], ['kestrel', 'agent']]);
  assert.equal(all[0].cwd, dir);
  assert.deepEqual(terminal.history({ thread: 7 }).map((r) => r.by), ['kestrel']);
});

test('a failing command reports its failure rather than throwing it away', async () => {
  const { terminal, dir } = fresh();
  terminal.setFolder(dir);
  const out = await terminal.run({ command: 'node -e "console.error(\'boom\'); process.exit(2)"', by: 'malcolm' });
  assert.equal(out.exitCode, 2);
  assert.match(out.output, /boom/, 'stderr is where the reason is');
});

test('a command that never finishes is stopped, and says so', async () => {
  const { terminal, dir } = fresh();
  terminal.setFolder(dir);
  const began = Date.now();
  const out = await terminal.run({ command: 'node -e "setInterval(()=>{},1000)"', by: 'kestrel', kind: 'agent', timeoutMs: 1000 });
  assert.equal(out.timedOut, true);
  assert.match(out.output, /stopped after 1s/);
  assert.ok(Date.now() - began < 8000);
  assert.equal(out.running, false);
});

test('one command cannot fill the database with its output', async () => {
  const { terminal, dir } = fresh();
  terminal.setFolder(dir);
  const out = await terminal.run({ command: 'node -e "process.stdout.write(\'x\'.repeat(200000))"', by: 'malcolm' });
  assert.ok(out.output.length < 61_000);
  assert.match(out.output, /output cut at 60000 characters/);
});

test('the handful of things that are never what was meant are refused', async () => {
  // Not security — anything here can be spelled another way, and the module
  // says so. It stops a model that has talked itself into one at the last step.
  const { terminal, dir } = fresh();
  terminal.setFolder(dir);
  for (const command of ['rm -rf /', 'rm -rf ~', 'sudo shutdown -h now', 'format C:', 'dd if=/dev/zero of=/dev/sda']) {
    await assert.rejects(() => terminal.run({ command, by: 'kestrel', kind: 'agent' }), /refused:/, command);
  }
  // And the ordinary thing next door to each is not.
  const fine = await terminal.run({ command: 'echo rm -rf ./build', by: 'malcolm' });
  assert.equal(fine.exitCode, 0);
  assert.equal(terminal.history().length, 1, 'a refused command is never started, so never recorded as run');
});

test('a person can take the terminal away from the agents and keep it themselves', async () => {
  const { terminal, dir } = fresh();
  terminal.setFolder(dir);
  terminal.setAgentsAllowed(false);
  await assert.rejects(() => terminal.run({ command: 'echo hi', by: 'kestrel', kind: 'agent' }), /a person switched that off/);
  assert.equal((await terminal.run({ command: 'echo hi', by: 'malcolm' })).exitCode, 0);
});
