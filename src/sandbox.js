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
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { zip } from './skillpack.js';

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
  mkdirSync(root, { recursive: true });
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
    .update([image(), network() ? 'net' : 'no-net', root, uid ?? '', 'v1'].join('|')).digest('hex').slice(0, 12);

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
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name).sort();
  }

  /** The folder commands start in. Always one inside the sandbox; it is a name, not a path. */
  function folder() {
    let name = String(config.get('workspace') ?? '').trim();
    // An older room stored a path on the machine here. That is exactly what
    // the sandbox exists not to run in, so it is not honoured.
    if (!NAME.test(name)) name = DEFAULT_FOLDER;
    const hostDir = join(root, name);
    mkdirSync(hostDir, { recursive: true });
    return { name, hostDir, inside: `${INSIDE}/${name}` };
  }

  function setFolder(raw) {
    const name = String(raw ?? '').trim();
    if (!name) { config.set('workspace', ''); return folder(); }
    if (!NAME.test(name)) {
      throw new Error('a sandbox folder is a name — letters, numbers, dots, dashes and underscores — not a path on this computer');
    }
    mkdirSync(join(root, name), { recursive: true });
    config.set('workspace', name);
    return folder();
  }

  /** A folder named by a caller, checked to be one of ours. */
  function named(name) {
    if (name === undefined || name === null || name === '') return folder();
    if (!NAME.test(String(name)) || !existsSync(join(root, String(name)))) throw new Error(`there is no sandbox folder called "${name}"`);
    return { name: String(name), hostDir: join(root, String(name)), inside: `${INSIDE}/${name}` };
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
      // Whether a command can be run at all right now.
      ready: isolated || unconfined(),
      preparing: Boolean(preparing),
      why: isolated ? '' : engineWhy,
      error: prepareError || null,
      image: image(),
      network: network(),
      root,
      folder: f.name,
      // Where commands start, as whoever runs them sees it.
      dir: isolated ? f.inside : f.hostDir,
      hostDir: f.hostDir,
      folders: folders(),
    };
  }

  /** The same, from what is already known — for callers that cannot wait for the engine to be asked. */
  function peek() {
    const f = folder();
    const isolated = Boolean(engine);
    const ok = isolated || unconfined();
    return {
      name: f.name, hostDir: f.hostDir, isolated, ok,
      dir: isolated ? f.inside : f.hostDir,
      why: ok ? '' : (engineWhy || 'the sandbox has not been checked yet'),
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
  async function start({ command, id, folder: which }) {
    const f = named(which);
    mkdirSync(f.hostDir, { recursive: true });
    await detect();
    if (engine) {
      const bin = await prepare();
      const child = spawnImpl(bin, [
        'exec', '-e', `ESPRITS_RUN=${id}`, '-w', f.inside, container, 'sh', '-c', String(command),
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      return { child, isolated: true, cwd: f.inside };
    }
    if (!unconfined()) throw new Error(`${engineWhy}. Nothing is run outside a sandbox unless you switch that on yourself`);
    const child = spawnImpl(String(command), {
      cwd: f.hostDir, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so stopping it stops what it started too.
      detached: process.platform !== 'win32',
    });
    return { child, isolated: false, cwd: f.hostDir };
  }

  /** Stop a command and whatever it started. */
  function kill({ child, id, isolated }) {
    try {
      if (isolated && engine) {
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
    return { path: String(path), size, binary, text: binary ? '' : data.subarray(0, 200_000).toString('utf8'), clipped: !binary && size > 200_000 };
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
    folder, folders, setFolder,
    start, kill,
    files, read, exportZip, exportTo,
  };
}
