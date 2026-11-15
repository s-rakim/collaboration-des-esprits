import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, realpathSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { openDb } from '../src/db.js';
import { createConfig } from '../src/settings.js';
import { createSandbox, INSIDE } from '../src/sandbox.js';
import { createTerminal } from '../src/workspace.js';

/** Is there a container engine here that actually answers? The isolation tests need a real one. */
const ENGINE = (() => {
  for (const bin of ['docker', 'podman']) {
    try {
      if (execFileSync(bin, ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).toString().trim()) return bin;
    } catch { /* not this one */ }
  }
  return null;
})();
/** Small, and enough for these: a shell and node. Set to something already on the machine to avoid a download. */
const IMAGE = process.env.ESPRITS_TEST_IMAGE ?? 'node:22-bookworm-slim';
const real = { skip: ENGINE ? false : 'no container engine is running on this machine' };

function fresh({ engine = 'none', unconfined = false } = {}) {
  const db = openDb(':memory:');
  const config = createConfig(db);
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'esprits-sbx-')));
  const sandbox = createSandbox({ config, dataDir, env: engine === 'real' ? {} : { ESPRITS_SANDBOX_ENGINE: engine } });
  if (engine === 'real') config.set('sandbox_image', IMAGE);
  if (unconfined) config.set('sandbox_unconfined', 'true');
  const terminal = createTerminal({ db, config, sandbox });
  return { db, config, dataDir, sandbox, terminal };
}

const cleanup = (sandbox) => {
  try { execFileSync(ENGINE, ['rm', '-f', sandbox.container], { stdio: 'ignore', timeout: 60_000 }); } catch { /* never made */ }
};

/** The names in a zip, read from its central directory, and one file's contents. */
function unzip(data) {
  const names = [];
  const contents = new Map();
  for (let at = 0; at + 30 <= data.length && data.readUInt32LE(at) === 0x04034b50;) {
    const method = data.readUInt16LE(at + 8);
    const packed = data.readUInt32LE(at + 18);
    const nameLength = data.readUInt16LE(at + 26);
    const extra = data.readUInt16LE(at + 28);
    const name = data.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const body = data.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + packed);
    names.push(name);
    contents.set(name, (method === 8 ? inflateRawSync(body) : body).toString('utf8'));
    at += 30 + nameLength + extra + packed;
  }
  return { names, contents };
}

// ---------------------------------------------------------------- no engine

test('with no engine there is no pretend sandbox: it says so and names what to install', async () => {
  const { sandbox } = fresh();
  const s = await sandbox.status({ recheck: true });
  assert.equal(s.engine, null);
  assert.equal(s.isolated, false);
  assert.equal(s.ready, false, 'nothing can be run');
  await assert.rejects(() => sandbox.start({ command: 'echo hi', id: 1 }), /Nothing is run outside a sandbox unless you switch that on yourself/);
});

test('running without isolation is a choice somebody has to make, and is reported for what it is', async () => {
  const { sandbox, terminal } = fresh({ unconfined: true });
  const s = await sandbox.status();
  assert.deepEqual([s.isolated, s.unconfined, s.ready], [false, true, true]);
  assert.equal(s.dir, s.hostDir, 'it runs on the machine, so the path shown is the machine\'s');
  const out = await terminal.run({ command: 'echo here', by: 'malcolm' });
  assert.equal(out.exitCode, 0);
  assert.equal(out.cwd, s.hostDir);
});

// ------------------------------------------------------------------ folders

test('work is kept in named folders under one root, and a new room starts in "project"', () => {
  const { sandbox, dataDir } = fresh();
  assert.equal(sandbox.root, join(dataDir, 'sandbox'));
  assert.deepEqual([sandbox.folder().name, sandbox.folder().inside], ['project', `${INSIDE}/project`]);
  sandbox.setFolder('shop');
  assert.deepEqual(sandbox.folders(), ['project', 'shop']);
  assert.equal(sandbox.folder().name, 'shop');
});

test('a path left over from before the sandbox is not honoured', () => {
  const { sandbox, config } = fresh();
  // An older room stored a folder on the machine here and ran commands in it.
  config.set('workspace', '/home/somebody/real-project');
  assert.equal(sandbox.folder().name, 'project');
  assert.ok(sandbox.folder().hostDir.startsWith(sandbox.root));
});

// ------------------------------------------------------------------- export

function withWork() {
  const r = fresh();
  const dir = r.sandbox.folder().hostDir;
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<h1>Landing</h1>');
  writeFileSync(join(dir, 'src', 'app.js'), 'console.log("hi")');
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1');
  return { ...r, dir };
}

test('what is in the sandbox can be seen, with dependencies as one line rather than ten thousand', () => {
  const { sandbox } = withWork();
  const listing = sandbox.files();
  assert.deepEqual(listing.files.map((f) => [f.path, f.kind]), [
    ['index.html', 'file'], ['node_modules/', 'heavy'], ['src/app.js', 'file'],
  ]);
  assert.equal(listing.bytes, '<h1>Landing</h1>'.length + 'console.log("hi")'.length);
  assert.equal(sandbox.read({ path: 'src/app.js' }).text, 'console.log("hi")');
  assert.throws(() => sandbox.read({ path: '../../room.db' }), /outside the sandbox folder/);
});

test('the results download as a zip of what was made, without the dependencies', () => {
  const { sandbox } = withWork();
  const out = sandbox.exportZip();
  assert.equal(out.name, 'project.zip');
  const { names, contents } = unzip(out.data);
  assert.deepEqual(names, ['project/index.html', 'project/src/app.js']);
  assert.equal(contents.get('project/index.html'), '<h1>Landing</h1>');
  assert.deepEqual(out.skipped, ['node_modules/']);
  // Asked for, they come too.
  assert.ok(unzip(sandbox.exportZip({ everything: true }).data).names.includes('project/node_modules/left-pad/index.js'));
});

test('the results copy out to a folder the person names, and never over anything', () => {
  const { sandbox } = withWork();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'esprits-out-')));
  const done = sandbox.exportTo({ to: outside });
  assert.equal(done.to, join(outside, 'project'));
  assert.equal(readFileSync(join(outside, 'project', 'src', 'app.js'), 'utf8'), 'console.log("hi")');
  assert.ok(existsSync(join(outside, 'project', 'node_modules', 'left-pad', 'index.js')), 'a copy is the whole thing');

  // The point of a sandbox is that nothing of yours is touched. That holds at the moment of export.
  assert.throws(() => sandbox.exportTo({ to: outside }), /already exists .* nothing is ever written over/);
  assert.throws(() => sandbox.exportTo({ to: 'relative/place' }), /full path/);
  assert.throws(() => sandbox.exportTo({ to: join(outside, 'not-there') }), /is not a folder that exists/);
  assert.throws(() => sandbox.exportTo({ to: sandbox.root }), /inside the sandbox/);
  assert.throws(() => sandbox.exportTo({ to: '' }), /say where to put it/);
});

test('there is nothing to export from an empty folder, and it says so', () => {
  const { sandbox } = fresh();
  assert.throws(() => sandbox.exportZip(), /is empty/);
  assert.throws(() => sandbox.exportTo({ to: tmpdir() }), /is empty/);
});

test('a link pointing out of the sandbox does not carry its target out with the export', () => {
  const { sandbox, dir, dataDir } = withWork();
  writeFileSync(join(dataDir, 'room.db'), 'THE KEYS');
  symlinkSync(join(dataDir, 'room.db'), join(dir, 'innocent.txt'));
  assert.ok(!unzip(sandbox.exportZip().data).names.includes('project/innocent.txt'));
  assert.equal(sandbox.files().files.find((f) => f.path === 'innocent.txt').kind, 'link');
});

// ------------------------------------------------------------ linked folders

/** A project of the person's own, somewhere on their disk. */
const project = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'my-project-')));
  writeFileSync(join(dir, 'README.md'), '# mine');
  return dir;
};

test('a folder of the person\'s own can be linked, and the room works in it without any engine', async () => {
  const { sandbox, terminal } = fresh();                 // no engine, and isolation not switched off
  const mine = project();
  const f = sandbox.link({ path: mine });
  assert.equal(f.linked, true);
  assert.equal(f.hostDir, mine);
  assert.match(f.name, /^my-project-/);

  const s = await sandbox.status();
  assert.deepEqual([s.isolated, s.linked, s.ready, s.unconfined], [false, true, true, false]);
  assert.equal(s.dir, mine, 'it runs on the machine, so the path shown is the real one');

  const out = await terminal.run({ command: 'echo made > from-the-room.txt && ls', by: 'malcolm' });
  assert.equal(out.exitCode, 0);
  assert.match(out.output, /README\.md/);
  assert.equal(out.cwd, mine);
  assert.equal(readFileSync(join(mine, 'from-the-room.txt'), 'utf8').trim(), 'made');

  // Linking one folder is consent for that folder, not for running anywhere.
  sandbox.setFolder('project');
  await assert.rejects(() => terminal.run({ command: 'echo hi', by: 'malcolm' }), /Nothing is run outside a sandbox/);
  sandbox.setFolder(f.name);
  assert.equal((await terminal.run({ command: 'echo back', by: 'malcolm' })).exitCode, 0);
});

test('what may be linked is a project, never the machine or the room\'s own keys', () => {
  const { sandbox, dataDir } = fresh();
  assert.throws(() => sandbox.link({ path: '' }), /say which folder/);
  assert.throws(() => sandbox.link({ path: 'relative/place' }), /full path/);
  assert.throws(() => sandbox.link({ path: join(tmpdir(), 'not-there-at-all') }), /does not exist/);
  assert.throws(() => sandbox.link({ path: '/' }), /not a whole drive/);
  assert.throws(() => sandbox.link({ path: '~' }), /not the home folder itself/);
  // The folder that holds the database holds every key in it.
  assert.throws(() => sandbox.link({ path: dataDir }), /holds the room's own data, with your keys in it/);
  assert.throws(() => sandbox.link({ path: join(dataDir, '..') }), /holds the room's own data/);
  assert.throws(() => sandbox.link({ path: sandbox.root }), /inside the room's own data/);
});

test('linked folders are listed with the sandbox\'s own, can be let go of, and are never deleted', async () => {
  const { sandbox } = fresh();
  const mine = project();
  const first = sandbox.link({ path: mine, name: 'shop site' });
  assert.equal(first.name, 'shop-site', 'a name that can be typed and mounted');
  assert.equal(sandbox.link({ path: mine }).name, 'shop-site', 'linking it again is the same link, not a second one');

  const s = await sandbox.status();
  assert.deepEqual(s.folders, ['project', 'shop-site']);
  assert.deepEqual(s.links, [{ name: 'shop-site', path: mine, missing: false }]);
  // Its files are seen and exported like any other folder's.
  assert.deepEqual(sandbox.files().files.map((x) => x.path), ['README.md']);

  const after = sandbox.unlink('shop-site');
  assert.equal(after.name, 'project');
  assert.ok(existsSync(join(mine, 'README.md')), 'letting go of a folder does not touch it');
  assert.throws(() => sandbox.unlink('shop-site'), /no linked folder called/);
});

test('a linked folder that has gone says so rather than running somewhere else', async () => {
  const { sandbox, terminal } = fresh();
  const mine = project();
  sandbox.link({ path: mine });
  execFileSync('rm', ['-rf', mine]);
  const s = await sandbox.status();
  assert.equal(s.ready, false);
  assert.match(s.why, /is no longer there/);
  await assert.rejects(() => terminal.run({ command: 'echo hi', by: 'malcolm' }), /is no longer there/);
});

test('with an engine, a linked folder is what the container is given — and still all it can see', real, async () => {
  const { sandbox, terminal, dataDir } = fresh({ engine: 'real' });
  try {
    const mine = project();
    const f = sandbox.link({ path: mine });
    writeFileSync(join(dataDir, 'room.db'), 'THE KEYS');

    const out = await terminal.run({ command: `pwd; cat README.md; echo from-inside > made.txt; cat "${join(dataDir, 'room.db')}" 2>&1`, by: 'kestrel', kind: 'agent', timeoutMs: 300_000 });
    assert.equal(out.cwd, `${INSIDE}/${f.name}`, 'it runs in the container, in the linked folder');
    assert.match(out.output, new RegExp(`^/sandbox/${f.name}\\n# mine`));
    assert.doesNotMatch(out.output, /THE KEYS/);
    assert.equal(readFileSync(join(mine, 'made.txt'), 'utf8').trim(), 'from-inside', 'what it makes lands in the real folder');
    assert.equal((await sandbox.status()).isolated, true);
  } finally { cleanup(sandbox); }
});

// ---------------------------------------------------------------- the editor

test('any editor that starts from a command can open the folder, or one file in it', async () => {
  const started = [];
  const db = openDb(':memory:');
  const config = createConfig(db);
  const sandbox = createSandbox({
    config, dataDir: realpathSync(mkdtempSync(join(tmpdir(), 'esprits-ed-'))), env: { ESPRITS_SANDBOX_ENGINE: 'none' },
    // Stands in for starting a program: records what would have been run.
    spawnImpl: (bin, args) => { started.push([bin, ...args]); return { once() {}, unref() {} }; },
    // Stands in for looking on the PATH: this machine has Zed, and nothing else.
    execImpl: (bin, args, _opts, cb) => cb(args[0] === 'zed' ? null : new Error('not found'), args[0] === 'zed' ? '/usr/bin/zed' : '', ''),
  });
  const mine = project();
  sandbox.link({ path: mine });

  const found = await sandbox.editors();
  assert.deepEqual(found.found, [{ command: 'zed', label: 'Zed' }]);
  assert.equal(found.editor, 'zed', 'with nothing chosen, the one that is installed');

  assert.deepEqual(await sandbox.openInEditor(), { opened: mine, with: 'zed' });
  assert.deepEqual(started.at(-1), ['zed', mine]);
  // A file is opened with its folder, so the editor shows it in its project rather than alone.
  await sandbox.openInEditor({ path: 'README.md' });
  assert.deepEqual(started.at(-1), ['zed', mine, join(mine, 'README.md')]);

  // Anything else is a command the person types — a name, or a full path with its own flags.
  sandbox.setEditor('"C:\\Program Files\\My Editor\\ed.exe" --reuse-window');
  assert.equal((await sandbox.editors()).editor, '"C:\\Program Files\\My Editor\\ed.exe" --reuse-window');
  await sandbox.openInEditor();
  assert.deepEqual(started.at(-1), ['C:\\Program Files\\My Editor\\ed.exe', '--reuse-window', mine]);

  assert.throws(() => sandbox.setEditor('code; rm -rf ~'), /the command that starts it/);
  await assert.rejects(() => sandbox.openInEditor({ path: '../outside.txt' }), /outside the folder/);
  await assert.rejects(() => sandbox.openInEditor({ path: 'nope.txt' }), /there is no file/);
});

// ------------------------------------------------------- a real container

test('a command runs inside the container and its work lands in the sandbox folder', real, async () => {
  const { sandbox, terminal } = fresh({ engine: 'real' });
  try {
    const s = await sandbox.status({ recheck: true });
    assert.equal(s.engine, ENGINE);
    assert.equal(s.isolated, true);
    assert.equal(s.dir, `${INSIDE}/project`);

    const out = await terminal.run({ command: 'pwd && echo built > out.txt && node -e "console.log(6*7)"', by: 'malcolm', timeoutMs: 300_000 });
    assert.equal(out.exitCode, 0, out.output);
    assert.match(out.output, /^\/sandbox\/project\n42/);
    assert.equal(out.cwd, `${INSIDE}/project`, 'the record says where it really ran');
    assert.equal(readFileSync(join(sandbox.folder().hostDir, 'out.txt'), 'utf8'), 'built\n', 'and the result is where the person can export it from');
  } finally { cleanup(sandbox); }
});

test('from inside, the rest of the machine is not there — including the room\'s own data', real, async () => {
  const { sandbox, terminal, dataDir } = fresh({ engine: 'real' });
  try {
    // Something an agent must never be able to read: this stands for the database with the keys in it.
    writeFileSync(join(dataDir, 'room.db'), 'THE KEYS');
    const marker = join(realpathSync(tmpdir()), `esprits-outside-${process.pid}.txt`);
    writeFileSync(marker, 'A FILE ON THE MACHINE');

    const look = await terminal.run({
      command: `cat "${marker}"; cat "${join(dataDir, 'room.db')}"; ls /sandbox; ls "${dataDir}" 2>&1; echo "home=$(ls /home 2>/dev/null | wc -l)"`,
      by: 'kestrel', kind: 'agent', timeoutMs: 300_000,
    });
    assert.doesNotMatch(look.output, /A FILE ON THE MACHINE/, 'a file outside the sandbox was readable');
    assert.doesNotMatch(look.output, /THE KEYS/, 'the room\'s own data was readable from inside the sandbox');
    assert.match(look.output, /No such file or directory/);

    // And it cannot write its way out either: the same path, inside, is the container's own.
    await terminal.run({ command: `mkdir -p "${dataDir}" && echo planted > "${join(dataDir, 'planted.txt')}"`, by: 'kestrel', kind: 'agent', timeoutMs: 60_000 });
    assert.ok(!existsSync(join(dataDir, 'planted.txt')), 'a write to a path outside the sandbox reached the machine');
    assert.deepEqual(readdirSync(dataDir).sort(), ['room.db', 'sandbox']);
  } finally { cleanup(sandbox); }
});

test('a command that never ends is stopped inside the container, along with what it started', real, async () => {
  const { sandbox, terminal } = fresh({ engine: 'real' });
  try {
    await terminal.run({ command: 'true', by: 'malcolm', timeoutMs: 300_000 });   // container up before the clock matters
    // Counted from /proc rather than with ps, which a small image does not have.
    const count = (what) => `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^${what} ' || true`;
    const seen = await terminal.run({ command: `sleep 7 & sleep 0.3; ${count('sleep 7')}`, by: 'malcolm', timeoutMs: 30_000 });
    assert.equal(seen.output.trim().split('\n').at(-1), '1', 'the count has to be able to see a process, or a zero below means nothing');

    const began = Date.now();
    const out = await terminal.run({ command: 'sleep 311 & sleep 311; wait', by: 'kestrel', kind: 'agent', timeoutMs: 1500 });
    assert.equal(out.timedOut, true);
    assert.ok(Date.now() - began < 15_000);
    // Ending our end of the connection is not ending the command; check the other end.
    await new Promise((r) => setTimeout(r, 1500));
    const left = await terminal.run({ command: count('sleep 311'), by: 'malcolm', timeoutMs: 30_000 });
    assert.equal(left.output.trim().split('\n').at(-1), '0', `still running inside: ${left.output}`);
  } finally { cleanup(sandbox); }
});

test('with the network switched off, the sandbox has none', real, async () => {
  const { sandbox, terminal } = fresh({ engine: 'real' });
  try {
    sandbox.configure({ network: false });
    const out = await terminal.run({ command: 'ls /sys/class/net', by: 'malcolm', timeoutMs: 300_000 });
    assert.equal(out.output.trim(), 'lo', 'only the loopback should be left');
    // Switching it back on means a different container, not the same one relabelled.
    sandbox.configure({ network: true });
    const again = await terminal.run({ command: 'ls /sys/class/net', by: 'malcolm', timeoutMs: 300_000 });
    assert.match(again.output, /eth0/);
  } finally { cleanup(sandbox); }
});

test('the container can be thrown away and the work is still there', real, async () => {
  const { sandbox, terminal } = fresh({ engine: 'real' });
  try {
    await terminal.run({ command: 'echo kept > note.txt', by: 'malcolm', timeoutMs: 300_000 });
    await sandbox.restart();
    const out = await terminal.run({ command: 'cat note.txt', by: 'malcolm', timeoutMs: 300_000 });
    assert.equal(out.output.trim(), 'kept');
  } finally { cleanup(sandbox); }
});
