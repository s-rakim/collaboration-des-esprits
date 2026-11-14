/**
 * The shared terminal.
 *
 * One folder, chosen by a person, and commands that start in it. The person
 * and the agents type into the same terminal, so everything that runs is
 * written down with who ran it — that record is the only thing that keeps a
 * shared terminal legible afterwards, and the only way to answer "what did it
 * do to my project?" without guessing.
 *
 * What this is not: a sandbox. A command starts in the folder, and a shell
 * command can go wherever the account running this server can go. The folder
 * says where work happens, not where it is confined. Somebody who wants
 * confinement runs the whole server inside a container or a spare account, and
 * no check written here would be an honest substitute for that.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, parse } from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Enough to read a failing build; not enough for one command to fill the database. */
const MAX_OUTPUT = 60_000;

/**
 * Commands refused outright.
 *
 * Not security — anything here can be spelled another way. These are the
 * handful of things that are never what was meant and cannot be taken back, so
 * a model that has talked itself into one is stopped at the last step rather
 * than believed.
 */
const NEVER = [
  { re: /\brm\s+(?:-[a-z]*\s+)*-[a-z]*r[a-z]*f?[a-z]*\s+(?:\/|~|\$HOME|\/\*)\s*(?:$|[;&|])/i, why: 'it deletes from the root or the home folder' },
  { re: /\b(?:mkfs|fdisk|diskpart)\b|\bdd\s+[^|;]*\bof=\/dev\//i, why: 'it writes to a disk device' },
  { re: /\bformat\s+[a-z]:/i, why: 'it formats a drive' },
  { re: /\b(?:shutdown|reboot|halt|poweroff)\b/i, why: 'it turns the machine off' },
  { re: /\b(?:del|rd|rmdir)\s+(?:\/[sq]\s+)+[a-z]:\\?\s*(?:$|[;&|])/i, why: 'it deletes a whole drive' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'it is a fork bomb' },
];

export function createTerminal({ db, config, spawnImpl = spawn }) {
  const now = () => new Date().toISOString();
  const live = new Map(); // run id -> child

  /** The folder, as stored, and whether it is still there. */
  function folder() {
    const dir = config.get('workspace');
    if (!dir) return { dir: '', ok: false, why: 'no project folder has been chosen yet' };
    if (!existsSync(dir)) return { dir, ok: false, why: `${dir} no longer exists` };
    return { dir, ok: true };
  }

  /**
   * Choose the folder.
   *
   * It has to exist and be a folder, and it may not be the root or the home
   * folder: "the project" being everything the account owns is the choice
   * that turns one mistaken command into a very bad afternoon.
   */
  function setFolder(raw) {
    const typed = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
    if (!typed) { config.set('workspace', ''); return folder(); }
    const dir = resolve(typed);
    if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} is a file, not a folder`);
    if (dir === parse(dir).root) throw new Error('choose a project folder, not the whole drive');
    if (dir === resolve(homedir())) throw new Error('choose a project folder inside your home folder, not the home folder itself');
    config.set('workspace', dir);
    return folder();
  }

  const view = (r) => ({
    id: r.id,
    command: r.command,
    cwd: r.cwd,
    by: r.actor,
    kind: r.actor_kind,
    thread: r.thread_id ?? null,
    exitCode: r.exit_code,
    running: r.exit_code === null && !r.finished_at,
    output: r.output,
    timedOut: Boolean(r.timed_out),
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
  });

  /**
   * Run one command in the folder and wait for it.
   *
   * Recorded before it starts, so a command that hangs or takes the server
   * down with it is still in the history as the last thing that was asked for.
   */
  function run({ command, by, kind = 'human', thread = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const text = String(command ?? '').trim();
    if (!text) return Promise.reject(new Error('there is no command to run'));
    if (!by) return Promise.reject(new Error('a command needs somebody to have run it'));

    const where = folder();
    if (!where.ok) return Promise.reject(new Error(`${where.why} — choose one on the Threads page`));
    if (kind !== 'human' && !config.bool('terminal_agents')) {
      return Promise.reject(new Error('agents are not allowed to use the terminal — a person switched that off'));
    }
    for (const { re, why } of NEVER) {
      if (re.test(text)) return Promise.reject(new Error(`refused: ${why}`));
    }

    const limit = Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
    const id = Number(db.prepare(
      `INSERT INTO terminal_runs (command, cwd, actor, actor_kind, thread_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(text, where.dir, String(by), kind, thread, now()).lastInsertRowid);

    return new Promise((done) => {
      let out = '';
      let clipped = false;
      let timedOut = false;
      const keep = (chunk) => {
        if (clipped) return;
        out += chunk.toString('utf8');
        if (out.length > MAX_OUTPUT) {
          out = `${out.slice(0, MAX_OUTPUT)}\n… output cut at ${MAX_OUTPUT} characters`;
          clipped = true;
        }
      };

      let child;
      const finish = (code) => {
        clearTimeout(timer);
        live.delete(id);
        db.prepare('UPDATE terminal_runs SET exit_code = ?, output = ?, timed_out = ?, finished_at = ? WHERE id = ?')
          .run(code, out, timedOut ? 1 : 0, now(), id);
        done(view(db.prepare('SELECT * FROM terminal_runs WHERE id = ?').get(id)));
      };

      try {
        child = spawnImpl(text, {
          cwd: where.dir, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group, so stopping it stops what it started too. A
          // shell is a parent; killing only the shell leaves the build it
          // launched running and holding the output open, and the command
          // then never finishes as far as anybody waiting on it can tell.
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        out = err.message;
        return finish(-1);
      }
      live.set(id, child);
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      child.on('error', (err) => { keep(Buffer.from(`${err.message}\n`)); finish(-1); });
      child.on('close', (code, signal) => finish(code ?? (signal ? 137 : -1)));

      const timer = setTimeout(() => {
        timedOut = true;
        keep(Buffer.from(`\n… stopped after ${Math.round(limit / 1000)}s`));
        stop(id);
      }, limit);
    });
  }

  /** Stop a running command, and whatever it started. */
  function stop(id) {
    const child = live.get(Number(id));
    if (!child) return false;
    try {
      // A shell is a parent; killing only it leaves the thing it launched.
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    } catch { /* already gone */ }
    return true;
  }

  function history({ limit = 40, thread = undefined, since = 0 } = {}) {
    const where = ['id > ?'];
    const params = [Number(since) || 0];
    if (thread !== undefined && thread !== null) { where.push('thread_id = ?'); params.push(Number(thread)); }
    return db.prepare(`SELECT * FROM terminal_runs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...params, Math.min(Number(limit) || 40, 200))
      .reverse()
      .map(view);
  }

  return {
    folder,
    setFolder,
    run,
    stop,
    history,
    agentsAllowed: () => config.bool('terminal_agents'),
    setAgentsAllowed: (on) => config.set('terminal_agents', on ? 'true' : 'false'),
  };
}
