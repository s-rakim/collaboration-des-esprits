/**
 * The local routers, and running one from the page rather than a terminal.
 *
 * A router stands in front of many providers and speaks one of two request
 * shapes, so the room asks one address and stops carrying a problem that was
 * never its own. Three are worth offering by name; any address can still be
 * typed in by hand.
 *
 * They are started as child processes of this server because the alternative is
 * a second terminal window that has to stay open, which is a thing to remember
 * and therefore a thing to forget. Started here, a router lives exactly as long
 * as the room does.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOGUE = JSON.parse(readFileSync(join(HERE, '..', 'routers.json'), 'utf8'));

export const ROUTERS = CATALOGUE.routers;
export const ROUTER_ORDER = CATALOGUE.order;

/** How long to wait for a freshly started router to answer before giving up. */
const START_TIMEOUT_MS = 90_000;

export function createRouters({ fetchImpl = fetch, spawnImpl = spawn } = {}) {
  /** The one we started, if any. At most one: they collide on ports. */
  let running = null;

  const base = (id) => ROUTERS[id]?.base ?? '';

  /**
   * Is it answering? Asked of the address rather than of the process, because a
   * router somebody started themselves is just as good as one we started, and
   * the page should say so rather than offering to start a second.
   */
  async function health(id) {
    const r = ROUTERS[id];
    if (!r) return { id, ok: false, error: `no router called "${id}"` };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetchImpl(`${r.base}/models`, { signal: ctl.signal });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { id, ok: false, base: r.base, error: `answered ${res.status}` };
      }
      const body = await res.json();
      const rows = Array.isArray(body) ? body : body.data ?? body.models ?? [];
      return {
        id, ok: true, base: r.base, models: rows.length,
        ours: running?.id === id,
      };
    } catch {
      return { id, ok: false, base: r.base, error: 'not answering' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function all() {
    return Promise.all(ROUTER_ORDER.map((id) => health(id)));
  }

  /**
   * Start one and wait for it to answer.
   *
   * Waiting matters: a router takes a while to come up, and returning the
   * moment the process exists would have the page report success and then fail
   * every call for the next half minute.
   */
  async function start(id, { timeoutMs = START_TIMEOUT_MS } = {}) {
    const r = ROUTERS[id];
    if (!r) throw new Error(`no router called "${id}"`);

    const already = await health(id);
    if (already.ok) return { ...already, started: false, note: 'it was already running' };

    if (running) {
      throw new Error(
        `${ROUTERS[running.id]?.label ?? running.id} is already running from here —`
        + ' stop it first. They listen on the same ports, so only one can be up.',
      );
    }

    let child;
    try {
      child = spawnImpl(r.command, [], {
        // Inherited so it dies with us. A router left running after the room
        // closes is a port somebody has to go and find later.
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
    } catch (err) {
      throw new Error(`could not run "${r.command}": ${err.message}`);
    }

    const log = [];
    const keep = (d) => { log.push(String(d)); if (log.length > 40) log.shift(); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);

    let exited = null;
    child.on('exit', (code) => { exited = code; if (running?.id === id) running = null; });
    child.on('error', (err) => { keep(err.message); exited = -1; });

    running = { id, child, log };

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (exited !== null) {
        running = null;
        throw new Error(
          `${r.label} stopped straight away${exited === -1 ? '' : ` (exit ${exited})`}.`
          + (log.length ? ` It said: ${log.join('').trim().slice(-300)}` : '')
          + ` Is it installed? ${r.install}`,
        );
      }
      const now = await health(id);
      if (now.ok) return { ...now, started: true, ours: true };
      if (Date.now() >= deadline) {
        stop();
        throw new Error(`${r.label} did not answer within ${Math.round(timeoutMs / 1000)}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }

  function stop() {
    if (!running) return { stopped: false, note: 'nothing was started from here' };
    const { id, child } = running;
    running = null;
    try { child.kill(); } catch { /* already gone */ }
    return { stopped: true, id };
  }

  /** The last lines it printed, for when it will not start and will not say why. */
  function output() {
    return running ? running.log.join('').trim().slice(-4000) : '';
  }

  return { all, health, start, stop, output, base, catalogue: () => ({ order: ROUTER_ORDER, routers: ROUTERS }), get running() { return running?.id ?? null; } };
}
