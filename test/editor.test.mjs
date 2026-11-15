import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';

/**
 * The room from an editor, against a real room.
 *
 * The editor itself is not here — it cannot be, in a test — so it is stood in
 * for by the handful of things the extension asks of it: a place to write, a
 * box to ask in, a list to pick from. What is proven is everything on this
 * side of that line: that a folder is linked, that a selection arrives in the
 * room with where it came from, that a command runs where the room is
 * working. What only the editor can show, it has to be opened to show.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

let server;
let base;
let mine;
const out = [];

before(async () => {
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'esprits-editor-')));
  mine = realpathSync(mkdtempSync(join(tmpdir(), 'my-code-')));
  mkdirSync(join(mine, 'src'));
  writeFileSync(join(mine, 'src', 'app.js'), 'export const limit = 600;\n');
  const port = 4800 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'src', 'bin', 'serve.js')], {
    env: { ...process.env, ESPRITS_DB: join(data, 'room.db'), PORT: String(port), ESPRITS_TOKEN: '', ESPRITS_SANDBOX_ENGINE: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => out.push(String(d)));
  server.stderr.on('data', (d) => out.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the room did not start: ${out.join('')}`);
});

after(() => server?.kill());

const api = async (path) => (await fetch(base + path)).json();

/** What the extension asks of an editor, and a record of what it was told. */
function editor({ answers = [], picks = [], selection = null, folder = mine } = {}) {
  const log = { info: [], errors: [], warnings: [], lines: [], executed: [], opened: [], status: [], commands: {} };
  const config = { url: base, token: '', name: '', follow: true };
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: { parse: (s) => ({ toString: () => s }) },
    window: {
      createOutputChannel: () => ({ appendLine: (l) => log.lines.push(l), append: (l) => log.lines.push(l), show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, set text(v) { log.status.push(v); }, get text() { return log.status.at(-1); } }),
      showInformationMessage: async (m) => { log.info.push(m); },
      showWarningMessage: async (m) => { log.warnings.push(m); },
      showErrorMessage: async (m) => { log.errors.push(m); },
      showInputBox: async () => answers.shift(),
      showQuickPick: async (items) => { const want = picks.shift(); return want === undefined ? items[0] : items.find((i) => i.label === want || i.name === want); },
      setStatusBarMessage: () => ({ dispose() {} }),
      activeTextEditor: selection && {
        document: { getText: () => selection.text, uri: { fsPath: join(folder, selection.file) }, languageId: selection.language },
        selection: { isEmpty: false, start: { line: selection.from - 1 }, end: { line: selection.to - 1 } },
      },
    },
    workspace: {
      workspaceFolders: folder ? [{ uri: { fsPath: folder }, name: 'my-code' }] : undefined,
      getConfiguration: () => ({ get: (key, fallback) => (config[key] === undefined || config[key] === '' ? fallback : config[key]) }),
      asRelativePath: (uri) => uri.fsPath.slice(folder.length + 1),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (id, fn) => { log.commands[id] = fn; return { dispose() {} }; },
      executeCommand: async (...a) => { log.executed.push(a); },
    },
    env: { openExternal: async (u) => { log.opened.push(String(u)); } },
  };
  return { vscode, log, config };
}

/** Load the extension with a stand-in for the editor's own module, which exists only inside an editor. */
function load(vscode) {
  const file = join(root, 'extensions', 'vscode', 'extension.js');
  const original = Module._load;
  Module._load = (request, ...rest) => (request === 'vscode' ? vscode : original(request, ...rest));
  delete require.cache[require.resolve(file)];
  try { return require(file); } finally { Module._load = original; }
}

function activate(ed) {
  const ext = load(ed.vscode);
  const kept = {};
  const subscriptions = [];
  const handle = ext.activate({ subscriptions, globalState: { get: (k, d) => kept[k] ?? d, update: async (k, v) => { kept[k] = v; } } });
  return { ...handle, run: (id) => ed.log.commands[id](), close: () => { ext.deactivate(); for (const s of subscriptions) s.dispose?.(); } };
}

test('a selection is quoted so it survives containing a fence of its own', () => {
  const { quote } = require(join(root, 'extensions', 'vscode', 'room.js'));
  assert.equal(quote({ file: 'src/app.js', from: 3, to: 5, language: 'js', text: 'const a = 1;\n' }),
    'From `src/app.js:3-5`:\n```js\nconst a = 1;\n```');
  const inner = quote({ file: 'README.md', from: 1, to: 1, language: 'markdown', text: 'Run:\n```\nnpm test\n```' });
  assert.match(inner, /^From `README\.md:1`:\n````markdown\n/, 'a longer fence than the one inside it');
  assert.ok(inner.endsWith('\n````'));
});

test('the folder open in the editor is linked, and the room then works in it', async () => {
  const ed = editor({ answers: ['malcolm'] });
  const ext = activate(ed);
  try {
    await ext.run('esprits.linkFolder');
    const where = await api('/api/sandbox');
    assert.equal(where.hostDir, mine);
    assert.equal(where.linked, true);
    assert.equal(where.ready, true, 'no engine here, and the linked folder is the consent to run in it');
    assert.match(ed.log.info.at(-1), /directly on this computer in this folder/);
    assert.deepEqual(ed.log.errors, []);
    // And the bar at the bottom says so.
    await ext.refresh();
    assert.match(ed.log.status.at(-1), /Room: \d+ agents? · linked/);
  } finally { ext.close(); }
});

test('a command run from the editor runs in that folder, on the room\'s record', async () => {
  const ed = editor({ answers: ['node -e "require(\'fs\').writeFileSync(\'made.txt\',\'by the room\')" && echo done'] });
  const ext = activate(ed);
  try {
    // Named in settings this time, so it is not asked again.
    ed.config.name = 'malcolm';
    await ext.run('esprits.runCommand');
    assert.equal(readFileSync(join(mine, 'made.txt'), 'utf8'), 'by the room');
    assert.ok(ed.log.lines.some((l) => /^exit 0/.test(l)), ed.log.lines.join('\n'));
    const record = (await api('/api/terminal')).runs.at(-1);
    assert.deepEqual([record.by, record.kind, record.cwd], ['malcolm', 'human', mine]);
  } finally { ext.close(); }
});

test('a selection goes to the room with where it came from, addressed to whoever was picked', async () => {
  const ed = editor({
    answers: ['is this limit right?'],
    selection: { file: 'src/app.js', from: 1, to: 1, language: 'javascript', text: 'export const limit = 600;' },
  });
  ed.config.name = 'malcolm';
  const ext = activate(ed);
  try {
    await ext.run('esprits.askRoom');
    const said = (await api('/api/feed?since=0')).messages.filter((m) => m.author === 'malcolm').at(-1);
    assert.equal(said.body, 'is this limit right?\n\nFrom `src/app.js:1`:\n```javascript\nexport const limit = 600;\n```');
    assert.deepEqual(ed.log.errors, []);
  } finally { ext.close(); }
});

test('what is said and run after the editor starts watching is written to its panel, once', async () => {
  const ed = editor();
  ed.config.name = 'malcolm';
  await fetch(`${base}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'malcolm', role: 'human', kind: 'human' }) });
  const ext = activate(ed);
  try {
    await ext.refresh();                         // the first look only finds out where things stand
    const before = ed.log.lines.length;
    await fetch(`${base}/api/post`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: 'malcolm', body: 'said from the browser' }) });
    await fetch(`${base}/api/terminal/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: 'malcolm', command: 'echo from-the-room' }) });
    await ext.refresh();
    const fresh = ed.log.lines.slice(before).join('\n');
    assert.match(fresh, /malcolm:\nsaid from the browser/);
    assert.match(fresh, /\$ echo from-the-room {3}\(malcolm, in /);
    assert.match(fresh, /from-the-room\nexit 0/);
    const after = ed.log.lines.length;
    await ext.refresh();
    assert.equal(ed.log.lines.length, after, 'the same things are not written twice');
  } finally { ext.close(); }
});

test('opening the room uses the editor\'s own browser tab', async () => {
  const ed = editor();
  const ext = activate(ed);
  try {
    await ext.run('esprits.openRoom');
    assert.deepEqual(ed.log.executed.at(-1), ['simpleBrowser.show', base]);
  } finally { ext.close(); }
});

test('with the room not running, the editor says so and how to start it', async () => {
  const ed = editor({ answers: ['malcolm'] });
  ed.config.url = 'http://127.0.0.1:9';
  const ext = activate(ed);
  try {
    await ext.run('esprits.linkFolder');
    assert.match(ed.log.errors.at(-1), /the room is not running at http:\/\/127\.0\.0\.1:9 — start it with "npm start"/);
    await ext.refresh();
    assert.match(ed.log.status.at(-1), /not running/);
  } finally { ext.close(); }
});

test('with no folder open there is nothing to link, and it says that', async () => {
  const ed = editor({ folder: null });
  const ext = activate(ed);
  try {
    await ext.run('esprits.linkFolder');
    assert.match(ed.log.warnings.at(-1), /Open a folder first/);
  } finally { ext.close(); }
});

// ------------------------------------------------------- from any terminal

const link = (args, cwd) => new Promise((done) => {
  execFile(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'src', 'bin', 'link.js'), ...args, '--url', base],
    { cwd }, (err, stdout, stderr) => done({ code: err?.code ?? 0, stdout, stderr }));
});

test('any editor\'s terminal can link the folder it is in, and let go of it again', async () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'other-project-')));
  writeFileSync(join(other, 'main.py'), 'print(1)\n');

  const linked = await link([], other);          // no folder named: the one it is run in
  assert.equal(linked.code, 0, linked.stderr);
  assert.match(linked.stdout, new RegExp(`The room now works in ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(linked.stdout, /directly on this computer/);
  assert.equal((await api('/api/sandbox')).hostDir, other);

  const gone = await link(['--unlink'], other);
  assert.equal(gone.code, 0, gone.stderr);
  assert.match(gone.stdout, /Nothing in it was touched/);
  assert.ok(existsSync(join(other, 'main.py')));
  assert.equal((await api('/api/sandbox')).linked, false);

  // And what cannot be linked is refused in the room's own words.
  const refused = await link(['/'], other);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /esprits-link: link a project folder, not a whole drive/);
});

// ------------------------------------------------------------ the package

test('the extension is packaged as the installer expects, and says what its own manifest says', async () => {
  const { buildVsix } = await import('../scripts/package-extension.mjs');
  const { inflateRawSync } = await import('node:zlib');
  const out = buildVsix();
  const pkg = JSON.parse(readFileSync(join(root, 'extensions', 'vscode', 'package.json'), 'utf8'));
  assert.equal(out.name, `esprits-room-${pkg.version}.vsix`);

  // Read it back as a zip, the way an installer would.
  const files = new Map();
  for (let at = 0; at + 30 <= out.data.length && out.data.readUInt32LE(at) === 0x04034b50;) {
    const method = out.data.readUInt16LE(at + 8);
    const packed = out.data.readUInt32LE(at + 18);
    const nameLength = out.data.readUInt16LE(at + 26);
    const extra = out.data.readUInt16LE(at + 28);
    const name = out.data.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const body = out.data.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + packed);
    files.set(name, (method === 8 ? inflateRawSync(body) : body).toString('utf8'));
    at += 30 + nameLength + extra + packed;
  }
  assert.deepEqual([...files.keys()].sort(), [
    '[Content_Types].xml', 'extension.vsixmanifest',
    'extension/LICENSE.txt', 'extension/README.md', 'extension/extension.js', 'extension/package.json', 'extension/room.js',
  ]);

  const manifest = files.get('extension.vsixmanifest');
  assert.match(manifest, new RegExp(`<Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />`));
  assert.match(manifest, new RegExp(`Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode.replace('^', '\\^')}"`));
  assert.match(manifest, /<InstallationTarget Id="Microsoft\.VisualStudio\.Code" \/>/);
  assert.match(manifest, /Type="Microsoft\.VisualStudio\.Code\.Manifest" Path="extension\/package\.json"/);
  // Every kind of file inside is declared, or the package is refused as malformed.
  const types = files.get('[Content_Types].xml');
  for (const path of files.keys()) {
    if (path === '[Content_Types].xml') continue;
    const ext = path.slice(path.lastIndexOf('.'));
    assert.ok(types.includes(`Extension="${ext}"`), `${ext} is not declared`);
  }
  // What is packed is what is in the folder — and what its entry point asks for is there.
  assert.equal(files.get('extension/extension.js'), readFileSync(join(root, 'extensions', 'vscode', 'extension.js'), 'utf8'));
  assert.equal(JSON.parse(files.get('extension/package.json')).main, './extension.js');
  for (const command of pkg.contributes.commands) {
    assert.ok(files.get('extension/extension.js').includes(`'${command.command}'`), `${command.command} is declared but not registered`);
  }
  // The copy kept in the repository is this one, not one from before the last change.
  const kept = join(root, 'extensions', 'vscode', out.name);
  assert.ok(existsSync(kept), `run "npm run extension:package" — ${out.name} has not been built`);
  assert.ok(readFileSync(kept).equals(out.data), 'the packaged extension is out of date — run "npm run extension:package"');
});
