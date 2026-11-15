/**
 * The sandbox: where the room's work happens.
 *
 * Everything an agent or a person runs from the room runs in here, and "in
 * here" means something specific: a container that can see one folder of this
 * machine and nothing else. Not the home folder, not the room's own database
 * with the keys in it, not the rest of the disk. Work piles up in that folder,
 * and when it is worth keeping the person exports it — as a zip, or copied to
 * a place of their choosing. Nothing leaves the sandbox on an agent's say-so.
 *
 * The isolation is the container engine's (Docker, or Podman, which takes the
 * same commands), because that is the only kind worth the name: a check
 * written in this file would be a list of commands somebody thought of, and a
 * shell has more ways of reaching a file than any list has entries.
 *
 * Which is also why there is no pretend mode. With no engine on the machine
 * the terminal refuses and says what to install. A person can choose to run
 * without isolation — it is their computer — but they have to choose it, it is
 * off until they do, and every status line says so while it is on.
 *
 * Linked folders are that choice made about one folder rather than about
 * everything. A person points the room at a project on their own disk — the
 * one they have open in their editor — and the room works there. With an
 * engine, that folder is what the container is given, and it is still all it
 * can see. Without one, commands run on the machine in that folder: not
 * isolated, and said to be not isolated, but agreed to for that folder by the
 * person who linked it.
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { zip } from './skillpack.js';
import { PROFILES, plan as planShell, survey } from './shells.js';

/** Where the sandbox folder appears inside the container. */
export const INSIDE = '/sandbox';
const DEFAULT_FOLDER = 'project';
const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** Folders that are bulk rather than work: listed as one line, left out of a zip unless asked for. */
const HEAVY = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', 'target', '.next']);
const ZIP_LIMIT = 200 * 1024 * 1024;
const LIST_LIMIT = 2000;

const ENGINES = ['docker', 'podman'];

export function createSandbox({
  config,
  dataDir,
  spawnImpl = spawn,
  execImpl = execFile,
  env = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  gid = typeof process.getgid === 'function' ? process.getgid() : null,
}) {
  const root = resolve(dataDir, 'sandbox');
  // The sandbox's own folder is always there to go back to, whatever else is linked.
  mkdirSync(join(root, DEFAULT_FOLDER), { recursive: true });
  const container = `esprits-sandbox-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`;

  /** One command to the engine, to its end. Never through a shell: the arguments are not ours to have reinterpreted. */
  const call = (bin, args, { timeoutMs = 20_000 } = {}) => new Promise((done) => {
    execImpl(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      done({ ok: !err, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() || err?.message || '' });
    });
  });

  // ------------------------------------------------------------- the engine

  let engine = null;         // 'docker' | 'podman' | null
  let engineWhy = '';
  let checkedAt = 0;
  let preparing = null;      // the promise of a container being made ready
  let prepareError = '';

  const image = () => config.get('sandbox_image') || 'node:22-bookworm';
  const network = () => config.bool('sandbox_network');
  const unconfined = () => config.bool('sandbox_unconfined');

  /** Find an engine that is installed *and answering* — a Docker with its daemon stopped isolates nothing. */
  async function detect({ force = false } = {}) {
    if (!force && Date.now() - checkedAt < 30_000) return engine;
    checkedAt = Date.now();
    const forced = String(env.ESPRITS_SANDBOX_ENGINE ?? '').toLowerCase();
    if (forced === 'none') { engine = null; engineWhy = 'the sandbox engine is switched off by ESPRITS_SANDBOX_ENGINE'; return engine; }

    const found = [];
    for (const bin of forced && ENGINES.includes(forced) ? [forced] : ENGINES) {
      const r = await call(bin, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8000 });
      if (r.ok && r.out) { engine = bin; engineWhy = ''; return engine; }
      // Installed but not answering is a different thing to tell somebody than not installed.
      if (!/ENOENT|not found|not recognized/i.test(r.err)) found.push(bin);
    }
    engine = null;
    engineWhy = found.length
      ? `${found[0] === 'docker' ? 'Docker' : 'Podman'} is installed but not running — start it, then check again`
      : 'no sandbox engine was found — install Docker Desktop (or Podman), start it, then check again';
    return engine;
  }

  /** What the container must be, as one string: when this changes the old container is the wrong one. */
  const spec = () => createHash('sha1')
    .update([image(), network() ? 'net' : 'no-net', root, uid ?? '', 'v2',
      ...links().map((l) => `${l.name}=${l.path}`)].join('|')).digest('hex').slice(0, 12);

  async function ensure() {
    const bin = await detect();
    if (!bin) throw new Error(engineWhy);
    const wanted = spec();
    const seen = await call(bin, ['inspect', '-f', '{{.State.Running}}|{{index .Config.Labels "esprits.spec"}}', container]);
    if (seen.ok) {
      const [running, has] = seen.out.split('|');
      if (has === wanted) {
        if (running === 'true') return bin;
        const started = await call(bin, ['start', container], { timeoutMs: 60_000 });
        if (started.ok) return bin;
      }
      // Wrong image, wrong network, or it would not start: make a fresh one.
      await call(bin, ['rm', '-f', container], { timeoutMs: 60_000 });
    }

    // On Linux, files made by a container's root belong to root on this side
    // too, and the person then cannot delete their own results. Running as
    // them avoids it. Docker Desktop and rootless Podman map this themselves.
    const asUser = bin === 'docker' && uid !== null && uid !== 0 && process.platform === 'linux';
    if (asUser) mkdirSync(join(root, '.home'), { recursive: true });
    const made = await call(bin, [
      'run', '-d', '--name', container, '--label', `esprits.spec=${wanted}`,
      '--init', '--pids-limit', '1024',
      '-v', `${root}:${INSIDE}`, '-w', INSIDE,
      // A linked folder is given to the container under its name, beside the
      // sandbox's own. It is the only other thing of the machine's it gets.
      ...links().filter((l) => existsSync(l.path)).flatMap((l) => ['-v', `${l.path}:${INSIDE}/${l.name}`]),
      ...(network() ? [] : ['--network', 'none']),
      ...(asUser ? ['--user', `${uid}:${gid ?? uid}`, '-e', `HOME=${INSIDE}/.home`] : []),
      image(), 'sleep', 'infinity',
    // The first time, this is a download of the whole image.
    ], { timeoutMs: 20 * 60_000 });
    if (!made.ok) throw new Error(`the sandbox could not be started: ${made.err.split('\n').at(-1)}`);
    return bin;
  }

  /** Make the sandbox ready, once, however many callers ask at the same moment. */
  function prepare() {
    if (!preparing) {
      prepareError = '';
      preparing = ensure()
        .catch((err) => { prepareError = err.message; throw err; })
        .finally(() => { preparing = null; });
    }
    return preparing;
  }

  // ------------------------------------------------------------- the folder

  function folders() {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !linkOf(d.name))
      .map((d) => d.name).sort();
  }

  // ------------------------------------------------------- linked folders

  /** The folders on this computer a person has linked: [{ name, path }]. */
  function links() {
    try {
      const kept = JSON.parse(config.get('linked_folders') || '[]');
      return Array.isArray(kept) ? kept.filter((l) => l && NAME.test(String(l.name)) && typeof l.path === 'string' && l.path) : [];
    } catch { return []; }
  }
  const linkOf = (name) => links().find((l) => l.name === name) ?? null;
  const within = (inner, outer) => inner === outer || inner.startsWith(outer + (process.platform === 'win32' ? '\\' : '/'));

  /**
   * Link a folder on this computer, so the room can work in it.
   *
   * It has to be a project folder and not everything the account owns, and
   * it may not hold — or be held by — the room's own data: a folder with the
   * database in it is a folder with every key in it, and an agent given that
   * folder has been given those.
   */
  function link({ path: raw, name: wanted }) {
    const typed = String(raw ?? '').trim().replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, homedir());
    if (!typed) throw new Error('say which folder — its full path on this computer');
    if (!isAbsolute(typed)) throw new Error('give the full path of the folder');
    const dir = resolve(typed);
    if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} is a file, not a folder`);
    if (dir === parse(dir).root) throw new Error('link a project folder, not a whole drive');
    if (dir === resolve(homedir())) throw new Error('link a project folder inside your home folder, not the home folder itself');
    const data = resolve(dataDir);
    if (within(data, dir)) throw new Error('that folder holds the room\'s own data, with your keys in it — link the project you want worked on, not a folder above the room');
    if (within(dir, data)) throw new Error('that is inside the room\'s own data — choose a project folder of yours');

    const all = links();
    const already = all.find((l) => resolve(l.path) === dir);
    if (already) { config.set('workspace', already.name); return folder(); }

    // Named after the folder, in letters a mention or a path can carry.
    let base = String(wanted ?? '').trim() || dir.split(/[\\/]/).filter(Boolean).at(-1) || 'linked';
    base = base.replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 48) || 'linked';
    let name = base;
    for (let n = 2; linkOf(name) || existsSync(join(root, name)); n++) name = `${base}-${n}`;

    config.set('linked_folders', JSON.stringify([...all, { name, path: dir }]));
    config.set('workspace', name);
    return folder();
  }

  /** Stop working in a linked folder. Nothing in it is touched; the room simply lets go of it. */
  function unlink(name) {
    const all = links();
    if (!all.some((l) => l.name === name)) throw new Error(`no linked folder called "${name}"`);
    const rest = all.filter((l) => l.name !== name);
    config.set('linked_folders', rest.length ? JSON.stringify(rest) : '');
    if (config.get('workspace') === name) config.set('workspace', '');
    return folder();
  }

  /** The folder commands start in: one of the sandbox's own, by name, or one the person linked. */
  function folder() {
    let name = String(config.get('workspace') ?? '').trim();
    // An older room stored a path on the machine here. That is exactly what
    // the sandbox exists not to run in, so it is not honoured.
    if (!NAME.test(name)) name = DEFAULT_FOLDER;
    const linked = linkOf(name);
    if (linked) return { name, hostDir: linked.path, inside: `${INSIDE}/${name}`, linked: true, missing: !existsSync(linked.path) };
    const hostDir = join(root, name);
    mkdirSync(hostDir, { recursive: true });
    return { name, hostDir, inside: `${INSIDE}/${name}`, linked: false };
  }

  function setFolder(raw) {
    const name = String(raw ?? '').trim();
    if (!name) { config.set('workspace', ''); return folder(); }
    if (!NAME.test(name)) {
      throw new Error('a sandbox folder is a name — letters, numbers, dots, dashes and underscores — not a path on this computer. To work in a folder of yours, link it');
    }
    if (!linkOf(name)) mkdirSync(join(root, name), { recursive: true });
    config.set('workspace', name);
    return folder();
  }

  /** A folder named by a caller, checked to be one of ours. */
  function named(name) {
    if (name === undefined || name === null || name === '') return folder();
    const linked = NAME.test(String(name)) ? linkOf(String(name)) : null;
    if (linked) return { name: linked.name, hostDir: linked.path, inside: `${INSIDE}/${linked.name}`, linked: true };
    if (!NAME.test(String(name)) || !existsSync(join(root, String(name)))) throw new Error(`there is no sandbox folder called "${name}"`);
    return { name: String(name), hostDir: join(root, String(name)), inside: `${INSIDE}/${name}`, linked: false };
  }

  // ----------------------------------------------------------------- status

  async function status({ recheck = false } = {}) {
    await detect({ force: recheck });
    const f = folder();
    const isolated = Boolean(engine);
    return {
      engine,
      isolated,
      unconfined: !isolated && unconfined(),
      // The folder in use is one of the person's own, on their disk.
      linked: Boolean(f.linked),
      links: links().map((l) => ({ ...l, missing: !existsSync(l.path) })),
      // Whether a command can be run at all right now.
      ready: (isolated || unconfined() || Boolean(f.linked)) && !f.missing,
      preparing: Boolean(preparing),
      why: f.missing ? `the linked folder ${f.hostDir} is no longer there` : isolated ? '' : engineWhy,
      error: prepareError || null,
      image: image(),
      network: network(),
      root,
      folder: f.name,
      // Where commands start, as whoever runs them sees it.
      dir: isolated ? f.inside : f.hostDir,
      hostDir: f.hostDir,
      folders: [...folders(), ...links().map((l) => l.name)],
    };
  }

  /** The same, from what is already known — for callers that cannot wait for the engine to be asked. */
  function peek() {
    const f = folder();
    const isolated = Boolean(engine);
    const ok = (isolated || unconfined() || Boolean(f.linked)) && !f.missing;
    return {
      name: f.name, hostDir: f.hostDir, isolated, ok, linked: Boolean(f.linked),
      dir: isolated ? f.inside : f.hostDir,
      why: ok ? '' : f.missing ? `the linked folder ${f.hostDir} is no longer there` : (engineWhy || 'the sandbox has not been checked yet'),
    };
  }

  function configure({ network: net, image: img, unconfined: loose } = {}) {
    if (net !== undefined) config.set('sandbox_network', net ? 'true' : 'false');
    if (img !== undefined) {
      const name = String(img).trim();
      if (name && !/^[\w./:@-]+$/.test(name)) throw new Error('that is not an image name');
      config.set('sandbox_image', name);
    }
    if (loose !== undefined) config.set('sandbox_unconfined', loose ? 'true' : 'false');
  }

  // --------------------------------------------------------------- running

  /**
   * Start one command in the sandbox. Returns the process, with its output
   * to read, and how it is running — so the record can say.
   */
  /** A folder inside the PC's folder, as a path relative to it — refused if it is anywhere else. */
  function resolveCwd({ folder: which, cwd = '', to = '' } = {}) {
    const f = named(which);
    const typed = String(to ?? '').trim().replace(/\\/g, '/');
    // An absolute path as the shell shows it — /sandbox/name/… or the folder on disk — is taken as inside the folder.
    let rel;
    if (typed.startsWith(`${f.inside}/`) || typed === f.inside) rel = typed.slice(f.inside.length);
    else if (typed.toLowerCase().startsWith(f.hostDir.replace(/\\/g, '/').toLowerCase())) rel = typed.slice(f.hostDir.length);
    else if (typed.startsWith('/') || /^[a-z]:/i.test(typed)) throw new Error('that is outside the PC\'s folder — a tab stays inside it');
    else rel = `${String(cwd ?? '').replace(/\\/g, '/')}/${typed}`;
    const full = resolve(f.hostDir, rel.replace(/^\/+/, ''));
    const sep = process.platform === 'win32' ? '\\' : '/';
    if (full !== f.hostDir && !full.startsWith(f.hostDir + sep)) throw new Error('that is outside the PC\'s folder — a tab stays inside it');
    if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error(`there is no folder ${typed}`);
    return { folder: f.name, cwd: full === f.hostDir ? '' : full.slice(f.hostDir.length + 1).split(sep).join('/') };
  }

  let have = null;
  /** What this machine can run a shell with — looked at once, and again when asked. */
  async function surveyed({ force = false } = {}) {
    if (!have || force) have = await survey({ env, execImpl });
    return have;
  }

  /** Every shell a terminal tab can be, and whether this machine can run it. */
  async function shells({ recheck = false } = {}) {
    await detect({ force: recheck });
    const h = await surveyed({ force: recheck });
    const f = folder();
    const hostOk = Boolean(f.linked) || unconfined();
    return PROFILES.map((p) => {
      const how = planShell({ id: p.id, engine, have: h });
      let why = how.unavailable ?? '';
      if (!why && how.where === 'host' && !hostOk) {
        why = 'It would run directly on this computer. Link a folder of yours to work in, or choose to run without a sandbox — then it opens.';
      }
      // The PC's own tab always opens: its pc … commands work whatever else does, and it says what is missing.
      const waiting = p.id === 'pc' && !engine && !hostOk;
      return {
        id: p.id, label: p.label, hint: p.hint, available: !why, why,
        how: waiting ? 'nothing yet — it will say what to set up' : how.how ?? '', isolated: how.where === 'container' || how.where === 'exec' || (how.where === 'pc' && Boolean(engine)),
      };
    });
  }

  async function start({ command, id, folder: which, cwd = '', env: extra = {}, shell = 'pc' }) {
    const f = named(which);
    if (f.linked) {
      if (!existsSync(f.hostDir)) throw new Error(`the linked folder ${f.hostDir} is no longer there`);
    } else mkdirSync(f.hostDir, { recursive: true });
    await detect();
    const at = cwd ? resolveCwd({ folder: f.name, cwd, to: '' }).cwd : '';
    const inside = at ? `${f.inside}/${at}` : f.inside;
    const onHost = at ? join(f.hostDir, at) : f.hostDir;
    // Passed by name, with the value in our own environment, so nothing secret is on a command line.
    const names = Object.keys(extra);
    const childEnv = { ...process.env, ...extra };
    const how = shell === 'pc' ? { where: 'pc' } : planShell({ id: shell, engine, have: await surveyed(), command: String(command) });
    if (how.unavailable) throw new Error(how.unavailable);

    if (engine && (how.where === 'pc' || how.where === 'exec')) {
      const bin = await prepare();
      const child = spawnImpl(bin, [
        'exec', '-e', `ESPRITS_RUN=${id}`, ...names.flatMap((n) => ['-e', n]), '-w', inside, container,
        ...(how.where === 'exec' ? how.argv : ['sh', '-c', String(command)]),
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv });
      return { child, isolated: true, cwd: inside };
    }
    if (engine && how.where === 'container') {
      // A container of its own, for this one command: it sees the PC's folder and nothing else, and is gone afterwards.
      const name = `esprits-run-${id}`;
      const asUser = engine === 'docker' && uid !== null && uid !== 0 && process.platform === 'linux';
      const child = spawnImpl(engine, [
        'run', '--rm', '--init', '--name', name, '--pids-limit', '1024',
        '-e', `ESPRITS_RUN=${id}`, ...names.flatMap((n) => ['-e', n]),
        '-v', `${f.hostDir}:${f.inside}`, '-w', inside,
        ...(network() ? [] : ['--network', 'none']),
        ...(asUser ? ['--user', `${uid}:${gid ?? uid}`, '-e', 'HOME=/tmp'] : []),
        how.image, ...how.argv,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv });
      return { child, isolated: true, cwd: inside, oneOff: name };
    }
    // A folder the person linked is one they have said the room may work in
    // directly. Anywhere else needs them to have switched isolation off.
    if (!f.linked && !unconfined()) {
      throw new Error(`${engineWhy}. Nothing is run outside a sandbox unless you switch that on yourself — or link a folder of your own to work in`);
    }
    const opts = {
      cwd: onHost, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
      // Its own process group, so stopping it stops what it started too.
      detached: process.platform !== 'win32',
    };
    if (how.where === 'host') {
      // WSL is told where to start in its own words; it is handed a Windows path and turns it into its own.
      const argv = how.wslCd ? [how.argv[0], how.argv[1], '--cd', onHost, ...how.argv.slice(2)] : how.argv;
      const child = spawnImpl(how.bin, argv, { ...opts, ...(how.verbatim ? { windowsVerbatimArguments: true } : {}) });
      return { child, isolated: false, cwd: onHost };
    }
    const child = spawnImpl(String(command), { ...opts, shell: true });
    return { child, isolated: false, cwd: onHost };
  }

  /** Stop a command and whatever it started. */
  function kill({ child, id, isolated, oneOff }) {
    try {
      if (oneOff && engine) {
        execImpl(engine, ['rm', '-f', oneOff], { timeout: 15_000, windowsHide: true }, () => {});
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      } else if (isolated && engine) {
        // Ending our end of `exec` does not end the command at the other end.
        // Everything it started carries its number in its environment, which
        // is what is used to find them.
        const hunt = `for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx 'ESPRITS_RUN=${Number(id)}' && kill -9 "\${p#/proc/}"; done; true`;
        execImpl(engine, ['exec', container, 'sh', '-c', hunt], { timeout: 15_000, windowsHide: true }, () => {});
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      } else if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    } catch { /* already gone */ }
  }

  /** Throw the container away. The folder, and everything in it, stays. */
  async function restart() {
    await detect({ force: true });
    if (!engine) throw new Error(engineWhy);
    await call(engine, ['rm', '-f', container], { timeoutMs: 60_000 });
    await prepare();
    return status();
  }

  /**
   * Put the container away when the room closes. The folder stays; the
   * container is only the walls, and a room that is not running should not
   * leave one idling on the machine.
   */
  function close() {
    if (!engine) return;
    try { execFileSync(engine, ['rm', '-f', container], { stdio: 'ignore', timeout: 20_000, windowsHide: true }); } catch { /* already gone */ }
  }

  // ------------------------------------------------------------- the editor

  /**
   * Editors that can be started from a command, by the name of that command.
   *
   * Any editor with one can be used — the list is only what is looked for
   * when nobody has said. The room runs on the person's own machine, so
   * opening a folder in their editor is starting a program they already have
   * with a path, not a protocol each editor would have to support.
   */
  const KNOWN_EDITORS = [
    ['code', 'VS Code'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['codium', 'VSCodium'], ['zed', 'Zed'],
    ['subl', 'Sublime Text'], ['idea', 'IntelliJ IDEA'], ['webstorm', 'WebStorm'], ['pycharm', 'PyCharm'],
    ['phpstorm', 'PhpStorm'], ['goland', 'GoLand'], ['rider', 'Rider'], ['fleet', 'Fleet'], ['atom', 'Atom'],
    ['notepad++', 'Notepad++'], ['gedit', 'gedit'], ['kate', 'Kate'],
  ];
  let editorsFound = null;

  /** Which of those are on this machine. Looked for once; the answer does not change while the room runs. */
  async function editors() {
    if (!editorsFound) {
      const finder = process.platform === 'win32' ? 'where' : 'which';
      const hits = await Promise.all(KNOWN_EDITORS.map(async ([command, label]) =>
        ((await call(finder, [command], { timeoutMs: 4000 })).ok ? { command, label } : null)));
      editorsFound = hits.filter(Boolean);
    }
    const chosen = String(config.get('editor') ?? '').trim();
    return {
      found: editorsFound,
      // What will be used: the person's choice, else the first one found, else whatever the system opens folders with.
      editor: chosen || editorsFound[0]?.command || '',
      chosen: chosen || null,
    };
  }

  function setEditor(command) {
    const typed = String(command ?? '').trim();
    // A program and, at most, its own flags. Not a place to put a pipeline.
    if (typed && /[;&|<>`$\n\r]/.test(typed)) throw new Error('an editor is the command that starts it, such as "code" or the full path to its program');
    config.set('editor', typed);
  }

  /**
   * Open a folder, or one file in it, in the person's editor.
   *
   * With no editor known, the folder is handed to the system to open the way
   * it opens any folder — which is at least the right place.
   */
  async function openInEditor({ folder: which, path: file } = {}) {
    const f = named(which);
    if (!existsSync(f.hostDir)) throw new Error(`${f.hostDir} is not there to open`);
    let target = f.hostDir;
    if (file) {
      target = resolve(f.hostDir, String(file));
      if (!within(target, f.hostDir)) throw new Error('that is outside the folder');
      if (!existsSync(target)) throw new Error(`there is no file ${file}`);
    }
    const { editor } = await editors();
    const [bin, args] = editor
      ? (() => { const parts = editor.match(/"[^"]+"|\S+/g).map((x) => x.replace(/^"|"$/g, '')); return [parts[0], [...parts.slice(1), ...(file ? [f.hostDir, target] : [target])]]; })()
      : process.platform === 'win32' ? ['explorer', [target]]
        : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];

    return new Promise((done, fail) => {
      let child;
      try {
        // On Windows the editors' commands are .cmd scripts, which only a shell can start.
        const win = process.platform === 'win32';
        // Through a shell there, arguments are joined with spaces — so one with a space in it needs its quotes back.
        const quote = (a) => (win && /\s/.test(a) ? `"${a}"` : a);
        child = spawnImpl(quote(bin), args.map(quote), { detached: true, stdio: 'ignore', windowsHide: true, shell: win });
      } catch (err) { return fail(new Error(`could not start ${bin}: ${err.message}`)); }
      child.once('error', (err) => fail(new Error(err.code === 'ENOENT'
        ? `there is no program called "${bin}" on this computer — set the command that starts your editor`
        : `could not start ${bin}: ${err.message}`)));
      // Given a moment to fail to start; an editor that started stays running, and is not waited for.
      setTimeout(() => { child.unref?.(); done({ opened: target, with: editor || 'the system\'s own opener' }); }, 400);
    });
  }

  // ------------------------------------------------------------- what is in it

  /** Every file in a folder, with heavy directories as one line each. */
  function files({ folder: which } = {}) {
    const f = named(which);
    const out = [];
    let clipped = false;
    const walk = (dir, rel) => {
      for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= LIST_LIMIT) { clipped = true; return; }
        const path = rel ? `${rel}/${d.name}` : d.name;
        const full = join(dir, d.name);
        if (d.isSymbolicLink()) { out.push({ path, kind: 'link', size: 0 }); continue; }
        if (d.isDirectory()) {
          if (HEAVY.has(d.name)) { out.push({ path: `${path}/`, kind: 'heavy', size: 0 }); continue; }
          walk(full, path);
          continue;
        }
        let size = 0;
        try { size = statSync(full).size; } catch { /* went away as we looked */ }
        out.push({ path, kind: 'file', size });
      }
    };
    walk(f.hostDir, '');
    return { folder: f.name, files: out, clipped, bytes: out.reduce((n, x) => n + x.size, 0) };
  }

  /**
   * The folder as a tree: every folder and file, with its size and when it
   * last changed. Asked for again and again by the explorer, which is how a
   * person watches the agents' work appear — so it is a walk of the disk and
   * nothing cleverer, bounded so a huge folder cannot make it slow.
   */
  function tree({ folder: which } = {}) {
    const f = named(which);
    const out = [];
    let clipped = false;
    const walk = (dir, rel) => {
      let list;
      try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of list.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
        if (out.length >= LIST_LIMIT) { clipped = true; return; }
        const path = rel ? `${rel}/${d.name}` : d.name;
        const full = join(dir, d.name);
        let st = null;
        try { st = statSync(full); } catch { /* went away as we looked */ }
        const mtime = st ? Math.round(st.mtimeMs) : 0;
        if (d.isSymbolicLink()) { out.push({ path, kind: 'link', size: 0, mtime }); continue; }
        if (d.isDirectory()) {
          const heavy = HEAVY.has(d.name);
          out.push({ path, kind: heavy ? 'heavy' : 'dir', size: 0, mtime });
          if (!heavy) walk(full, path);
          continue;
        }
        out.push({ path, kind: 'file', size: st?.size ?? 0, mtime });
      }
    };
    if (existsSync(f.hostDir)) walk(f.hostDir, '');
    return { folder: f.name, linked: Boolean(f.linked), hostDir: f.hostDir, entries: out, clipped, at: Date.now() };
  }

  /** One file's text, for looking at a result without exporting it. */
  function read({ folder: which, path }) {
    const f = named(which);
    const full = resolve(f.hostDir, String(path ?? ''));
    if (full !== f.hostDir && !full.startsWith(f.hostDir + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error('that is outside the sandbox folder');
    }
    if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`there is no file ${path}`);
    const size = statSync(full).size;
    const data = readFileSync(full);
    const binary = data.subarray(0, 8000).includes(0);
    return { path: String(path), size, mtime: Math.round(statSync(full).mtimeMs), binary, text: binary ? '' : data.subarray(0, 200_000).toString('utf8'), clipped: !binary && size > 200_000 };
  }

  // ------------------------------------------------------- changing what is in it

  /** A path inside a folder, refused if it would be anywhere else. */
  function inFolder(f, path, { self = false } = {}) {
    const rel = String(path ?? '').trim().replace(/^[\\/]+/, '');
    const full = resolve(f.hostDir, rel);
    const inside = full.startsWith(f.hostDir + (process.platform === 'win32' ? '\\' : '/'));
    if (!(inside || (self && full === f.hostDir))) throw new Error('that is outside the folder');
    return full;
  }

  /** Where a file really is, for sending it as it is — a picture, say. */
  function locate({ folder: which, path }) {
    const full = inFolder(named(which), path);
    if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`there is no file ${path}`);
    return full;
  }

  /**
   * Save a file's text. `expect` is the time the file had when it was opened:
   * given, a file that has changed since — an agent was writing it too — is
   * not written over, and the caller is told so.
   */
  function write({ folder: which, path, text, expect }) {
    const f = named(which);
    const full = inFolder(f, path);
    if (existsSync(full)) {
      const st = statSync(full);
      if (!st.isFile()) throw new Error(`${path} is a folder`);
      if (expect !== undefined && expect !== null && Math.round(st.mtimeMs) !== Number(expect)) {
        const err = new Error(`${path} has changed since you opened it`);
        err.conflict = true;
        throw err;
      }
    }
    const body = String(text ?? '');
    if (body.length > 2_000_000) throw new Error('that is too large to save from here');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
    const st = statSync(full);
    return { folder: f.name, path: String(path), size: st.size, mtime: Math.round(st.mtimeMs) };
  }

  function makeDir({ folder: which, path }) {
    const f = named(which);
    const full = inFolder(f, path);
    if (existsSync(full)) throw new Error(`${path} is already there`);
    mkdirSync(full, { recursive: true });
    return { folder: f.name, path: String(path) };
  }

  /** Rename or move, never over something that is already there. */
  function move({ folder: which, from, to }) {
    const f = named(which);
    const a = inFolder(f, from);
    const b = inFolder(f, to);
    if (!existsSync(a)) throw new Error(`there is no ${from}`);
    if (existsSync(b)) throw new Error(`${to} is already there`);
    mkdirSync(dirname(b), { recursive: true });
    renameSync(a, b);
    return { folder: f.name, from: String(from), to: String(to) };
  }

  function remove({ folder: which, path }) {
    const f = named(which);
    const full = inFolder(f, path);
    if (!existsSync(full)) throw new Error(`there is no ${path}`);
    rmSync(full, { recursive: true, force: true });
    return { folder: f.name, path: String(path) };
  }

  /**
   * Empty a folder of the PC: everything in it goes, the folder stays.
   *
   * Only the PC's own folders. One the person linked is their project on
   * their disk, and deleting that is not something a button in here does.
   */
  function empty({ folder: which } = {}) {
    const f = named(which);
    if (f.linked) throw new Error(`${f.name} is a folder of yours that you linked (${f.hostDir}). It is not emptied from here — delete what you want gone yourself, or unlink it`);
    let removed = 0;
    for (const d of readdirSync(f.hostDir)) {
      rmSync(join(f.hostDir, d), { recursive: true, force: true });
      removed += 1;
    }
    return { folder: f.name, removed };
  }

  // ---------------------------------------------------------------- export

  /**
   * The folder as a zip.
   *
   * Dependencies and version-control history are left out unless asked for:
   * what a person wants out of the sandbox is what was made, and node_modules
   * is neither that nor something a zip in memory should be asked to hold.
   */
  function exportZip({ folder: which, everything = false } = {}) {
    const f = named(which);
    const entries = [];
    const skipped = [];
    let total = 0;
    const walk = (dir, rel) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const path = rel ? `${rel}/${d.name}` : d.name;
        const full = join(dir, d.name);
        if (d.isSymbolicLink()) continue;        // a link can point out of the sandbox; its target is not ours to pack
        if (d.isDirectory()) {
          if (!everything && HEAVY.has(d.name)) { skipped.push(`${path}/`); continue; }
          walk(full, path);
          continue;
        }
        if (!d.isFile()) continue;
        total += statSync(full).size;
        if (total > ZIP_LIMIT) {
          throw new Error(`${f.name} is larger than ${Math.round(ZIP_LIMIT / 1024 / 1024)} MB — copy it to a folder instead of downloading it`);
        }
        entries.push([`${f.name}/${path}`, readFileSync(full)]);
      }
    };
    walk(f.hostDir, '');
    if (!entries.length) throw new Error(`${f.name} is empty — there is nothing to export yet`);
    return { name: `${f.name}.zip`, data: zip(entries), files: entries.length, skipped };
  }

  /**
   * Copy the folder out, to a place on this computer the person names.
   *
   * It goes into a new folder there and never over an existing one: the point
   * of working in a sandbox is that nothing of yours is touched, and that
   * holds for the moment of export too.
   */
  function exportTo({ folder: which, to }) {
    const f = named(which);
    const typed = String(to ?? '').trim().replace(/^["']|["']$/g, '').replace(/^~(?=$|[\\/])/, homedir());
    if (!typed) throw new Error('say where to put it — a folder on this computer');
    if (!isAbsolute(typed)) throw new Error('give the full path of the folder to put it in');
    const parent = resolve(typed);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`${parent} is not a folder that exists`);
    if (parent === root || parent.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error('that is inside the sandbox — choose somewhere outside it');
    }
    const dest = join(parent, f.name);
    if (existsSync(dest)) throw new Error(`${dest} already exists — move it, or choose another place; nothing is ever written over`);
    if (!readdirSync(f.hostDir).length) throw new Error(`${f.name} is empty — there is nothing to export yet`);
    // Links are copied as links, not followed: one pointing out of the
    // sandbox must not become a way of carrying something else along.
    cpSync(f.hostDir, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    return { folder: f.name, to: dest, files: files({ folder: f.name }).files.length };
  }

  return {
    root, container,
    detect, prepare, restart, close, status, peek, configure,
    folder, folders, setFolder, link, unlink, links,
    start, kill, shells, resolveCwd, empty,
    files, tree, read, locate, write, makeDir, move, remove, exportZip, exportTo,
    editors, setEditor, openInEditor,
  };
}
