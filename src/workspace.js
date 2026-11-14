/**
 * The shared terminal.
 *
 * The person and the agents type into the same terminal, so everything that
 * runs is written down with who ran it — that record is the only thing that
 * keeps a shared terminal legible afterwards, and the only way to answer "what
 * did it do?" without guessing.
 *
 * Where it runs is not this file's decision. Every command is handed to the
 * sandbox, which runs it in a container that can see one folder and nothing
 * else of this machine. This file keeps the record and the clock.
 */

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

export function createTerminal({ db, config, sandbox }) {
  const now = () => new Date().toISOString();
  const live = new Map(); // run id -> child

  /** Where commands start, and whether one can be run at all right now. */
  function folder() {
    return sandbox.peek();
  }

  /** Choose the folder — one inside the sandbox, by name. */
  function setFolder(name) {
    sandbox.setFolder(name);
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

    if (kind !== 'human' && !config.bool('terminal_agents')) {
      return Promise.reject(new Error('agents are not allowed to use the terminal — a person switched that off'));
    }
    for (const { re, why } of NEVER) {
      if (re.test(text)) return Promise.reject(new Error(`refused: ${why}`));
    }

    const limit = Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
    // Recorded before it starts, with where it is about to run.
    const id = Number(db.prepare(
      `INSERT INTO terminal_runs (command, cwd, actor, actor_kind, thread_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(text, sandbox.peek().dir, String(by), kind, thread, now()).lastInsertRowid);

    return new Promise((done, fail) => {
      let out = '';
      let clipped = false;
      let timedOut = false;
      let timer = null;
      let settled = false;
      const keep = (chunk) => {
        if (clipped) return;
        out += chunk.toString('utf8');
        if (out.length > MAX_OUTPUT) {
          out = `${out.slice(0, MAX_OUTPUT)}\n… output cut at ${MAX_OUTPUT} characters`;
          clipped = true;
        }
      };
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        live.delete(id);
        db.prepare('UPDATE terminal_runs SET exit_code = ?, output = ?, timed_out = ?, finished_at = ? WHERE id = ?')
          .run(code, out, timedOut ? 1 : 0, now(), id);
        done(view(db.prepare('SELECT * FROM terminal_runs WHERE id = ?').get(id)));
      };

      sandbox.start({ command: text, id }).then((run) => {
        // Where it really ran: the sandbox may have had to be found first.
        db.prepare('UPDATE terminal_runs SET cwd = ? WHERE id = ?').run(run.cwd, id);
        live.set(id, run);
        run.child.stdout?.on('data', keep);
        run.child.stderr?.on('data', keep);
        run.child.on('error', (err) => { keep(Buffer.from(`${err.message}\n`)); finish(-1); });
        run.child.on('close', (code, signal) => finish(code ?? (signal ? 137 : -1)));
        timer = setTimeout(() => {
          timedOut = true;
          keep(Buffer.from(`\n… stopped after ${Math.round(limit / 1000)}s`));
          stop(id);
        }, limit);
      }).catch((err) => {
        // It never started — no sandbox, or one that would not come up. Not a
        // command that failed, so it is refused rather than recorded as a run.
        db.prepare('DELETE FROM terminal_runs WHERE id = ?').run(id);
        fail(err);
      });
    });
  }

  /** Stop a running command, and whatever it started. */
  function stop(id) {
    const run = live.get(Number(id));
    if (!run) return false;
    sandbox.kill({ child: run.child, id: Number(id), isolated: run.isolated });
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
