/**
 * What the agents may reach beyond their own folder: websites, and the
 * programs on this computer.
 *
 * Two words do the work, and they mean the same thing everywhere. **Read** is
 * looking: opening a page, fetching a file, cloning a repository, opening a
 * document in a program. **Write** is changing something that is not theirs:
 * submitting a form, clicking a button on a site, pushing to a repository,
 * running a program with arguments of their own.
 *
 * A person decides, site by site and program by program. Sites not listed get
 * the default, which is read and no write: an agent can look things up, and
 * cannot post anything anywhere until somebody says so. GitHub is listed from
 * the start because it is the site where the difference matters most.
 *
 * These rules bind the agents. A person in the room is not asked: it is their
 * browser and their computer.
 *
 * What this is and is not. The browser and the fetch tool are gated exactly —
 * every request names its site. A shell command is gated by reading it: the
 * sites it names, and whether it looks like a write (`git push`, `curl -X
 * POST`, `gh pr create`). That stops an agent doing what it was not allowed
 * to by the ordinary routes, and says why. It is not a wall around a shell —
 * the wall is the PC's network switch, which turns the network off altogether.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$|^localhost$/i;
const APP_NAME = /^[A-Za-z0-9][\w.-]{0,39}$/;

const DEFAULTS = {
  sites: {
    default: { read: true, write: false },
    rules: [{ host: 'github.com', read: true, write: false }],
  },
  apps: [],
};

/** A site as somebody typed it — an address, a host, a host with a path — down to its host. */
export function hostOf(typed) {
  let s = String(typed ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]*@/, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  return s;
}

/** Does this rule's host cover that host? A rule covers its own subdomains. */
const covers = (rule, host) => {
  const r = rule.replace(/^\*\./, '');
  return host === r || host.endsWith(`.${r}`);
};

/** The sites a shell command names, as hosts. */
export function hostsIn(command) {
  const out = new Set();
  const text = String(command ?? '');
  for (const m of text.matchAll(/\b(?:https?|git|ssh|ftp):\/\/([^\s/'"`<>]+)/gi)) out.add(hostOf(m[1]));
  // git@github.com:owner/repo.git
  for (const m of text.matchAll(/\b[\w.-]+@([a-z0-9.-]+\.[a-z]{2,}):[\w./~-]+/gi)) out.add(hostOf(m[1]));
  out.delete('');
  return [...out];
}

/** Does this command change something at the other end, rather than fetch from it? */
export function looksLikeWrite(command) {
  const c = String(command ?? '');
  if (/\bgit\s+(?:[-\w=.]+\s+)*push\b/.test(c)) return 'git push';
  if (/\bgh\s+(?:pr|issue|release|repo|gist|secret|variable|label|workflow|run|api)\b/.test(c)
    && /\b(?:create|merge|close|reopen|edit|delete|comment|review|ready|upload|rename|archive|fork|sync|set|remove|enable|disable|rerun|cancel|run)\b|\bgh\s+api\b[^|;&]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--method\s+(?:POST|PUT|PATCH|DELETE)|\s-[fF]\s)/i.test(c)) return 'a gh command that changes something';
  if (/\bcurl\b/.test(c) && /(?:-X\s*|--request[= ]\s*)(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file)\b/i.test(c)) return 'a request that sends data';
  if (/\bwget\b/.test(c) && /--(?:post-data|post-file|method=(?:POST|PUT|PATCH|DELETE))/i.test(c)) return 'a request that sends data';
  if (/\b(?:npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bdocker\s+push\b/.test(c)) return 'publishing';
  if (/\b(?:scp|rsync)\b[^|;&]*\s[\w.-]+@[\w.-]+:/.test(c)) return 'copying to another machine';
  return '';
}

export class Denied extends Error {
  constructor(message) { super(message); this.denied = true; }
}

export function createPermissions({ config, sandbox = null, spawnImpl = spawn }) {
  // ------------------------------------------------------------------ stored

  function read() {
    let saved = null;
    try { saved = JSON.parse(config.get('permissions') || 'null'); } catch { /* start again from the defaults */ }
    const out = {
      sites: {
        default: { read: saved?.sites?.default?.read ?? DEFAULTS.sites.default.read, write: saved?.sites?.default?.write ?? DEFAULTS.sites.default.write },
        rules: Array.isArray(saved?.sites?.rules) ? saved.sites.rules : DEFAULTS.sites.rules,
      },
      apps: Array.isArray(saved?.apps) ? saved.apps : DEFAULTS.apps,
    };
    return clean(out).value;
  }

  /** Whatever was handed in, as rules that mean something — and what was thrown out, said. */
  function clean(raw) {
    const rejected = [];
    const rules = [];
    const seen = new Set();
    for (const r of raw?.sites?.rules ?? []) {
      const host = hostOf(r?.host);
      if (!HOST.test(host)) { rejected.push(`"${r?.host}" is not a site — give its address, like github.com`); continue; }
      if (seen.has(host)) continue;
      seen.add(host);
      // Writing to a site you may not read makes no sense; write carries read.
      rules.push({ host, read: Boolean(r.read) || Boolean(r.write), write: Boolean(r.write) });
    }
    const apps = [];
    const names = new Set();
    for (const a of raw?.apps ?? []) {
      const name = String(a?.name ?? '').trim();
      const command = String(a?.command ?? '').trim();
      if (!APP_NAME.test(name)) { rejected.push(`"${name}" is not a name for a program — letters, numbers, dots and dashes`); continue; }
      if (!command) { rejected.push(`${name} needs the command that starts it`); continue; }
      if (/[\n\r;&|`$<>]/.test(command)) { rejected.push(`${name}: the command is one program, not a script`); continue; }
      if (names.has(name.toLowerCase())) continue;
      names.add(name.toLowerCase());
      apps.push({ name, command, read: Boolean(a.read) || Boolean(a.write), write: Boolean(a.write) });
    }
    const d = raw?.sites?.default ?? {};
    return {
      value: { sites: { default: { read: Boolean(d.read) || Boolean(d.write), write: Boolean(d.write) }, rules }, apps },
      rejected,
    };
  }

  function save(raw) {
    const { value, rejected } = clean(raw);
    config.set('permissions', JSON.stringify(value));
    return { ...view(), rejected };
  }

  /** What a page shows: the rules, and whether there is a GitHub token — never the token. */
  function view() {
    const token = config.secret('github_token') || '';
    return { ...read(), github: { token: token ? `…${token.slice(-4)}` : '', hasToken: Boolean(token) } };
  }

  function setGithubToken(token) {
    const t = String(token ?? '').trim();
    if (t && !/^[A-Za-z0-9_]{20,255}$/.test(t)) throw new Error('that does not look like a GitHub token');
    config.setSecret('github_token', t || null);
    return view();
  }

  // ----------------------------------------------------------------- asking

  /** What an agent may do on this site. */
  function site(typed) {
    const host = hostOf(typed);
    const p = read();
    // The most specific rule that covers the host decides.
    const rule = p.sites.rules.filter((r) => covers(r.host, host)).sort((a, b) => b.host.length - a.host.length)[0];
    return { host, read: (rule ?? p.sites.default).read, write: (rule ?? p.sites.default).write, listed: Boolean(rule) };
  }

  const where = (host) => `Agents' PC → Permissions${host ? `, or: pc allow ${'{what}'} ${host}` : ''}`;

  function need(what, typed, doing = '') {
    const s = site(typed);
    if (!s.host) return s;
    if (!s[what]) {
      throw new Denied(`not allowed: agents may not ${what === 'read' ? 'read' : 'write to'} ${s.host}${doing ? ` (${doing})` : ''}. `
        + `A person can allow it in ${where(s.host).replace('{what}', what)}`);
    }
    return s;
  }

  /** Set one site's rule, keeping the rest. */
  function allow(what, typed, on = true) {
    const host = hostOf(typed);
    if (!['read', 'write'].includes(what)) throw new Error('say read or write');
    const p = read();
    if (host === 'all' || host === '*' || host === 'everything') {
      p.sites.default[what] = on;
      if (what === 'write' && on) p.sites.default.read = true;
      if (what === 'read' && !on) p.sites.default.write = false;
      return save(p);
    }
    if (!HOST.test(host)) throw new Error(`"${typed}" is not a site — give its address, like github.com`);
    let rule = p.sites.rules.find((r) => r.host === host);
    if (!rule) { rule = { host, ...site(host) }; p.sites.rules.push(rule); }
    rule[what] = on;
    if (what === 'write' && on) rule.read = true;
    if (what === 'read' && !on) rule.write = false;
    return save(p);
  }

  // ------------------------------------------------------------- the browser

  /**
   * The browser as an agent holds it: every page it asks for is checked
   * against the rules first, and acting on a page needs write for that site.
   */
  function guardBrowser(browser) {
    if (!browser) return browser;
    const current = async () => { try { return (await browser.where()).url; } catch { return ''; } };
    return {
      ...browser,
      async open(opts) {
        need('read', opts?.url, 'opening it');
        const page = await browser.open(opts);
        // It may have been sent on somewhere else; what comes back is checked too.
        if (page?.url) need('read', page.url, 'it redirected there');
        return page;
      },
      async search(opts) {
        const p = read();
        if (!p.sites.default.read) throw new Denied(`not allowed: agents may only read the sites a person has listed, so they cannot search the web. A person can change that in ${where('')}`);
        return browser.search(opts);
      },
      async read() {
        need('read', await current(), 'the page the browser is showing');
        return browser.read();
      },
      /** Click something or fill something in on the page that is showing. */
      async actOn(opts) {
        const url = await current();
        need('write', url, opts?.action === 'click' ? 'clicking on it' : 'typing into it');
        const done = await browser.actOn(opts);
        const after = await current();
        // A click that leaves for another site lands somewhere that needs its own permission to read.
        if (after && hostOf(after) !== hostOf(url)) need('read', after, 'the click went there');
        return done;
      },
    };
  }

  /** The fetch tool, checked the same way. */
  function guardWeb(web) {
    if (!web) return web;
    return {
      ...web,
      available: (...a) => web.available?.(...a),
      async fetchPage(opts) {
        need('read', opts?.url, 'fetching it');
        const page = await web.fetchPage(opts);
        if (page?.url) need('read', page.url, 'it redirected there');
        return page;
      },
    };
  }

  // ------------------------------------------------------------ the terminal

  /** Why an agent's command is refused, or '' when it is not. */
  function refusal(command) {
    const hosts = hostsIn(command);
    const writing = looksLikeWrite(command);
    // A push or a `gh` command names no site, but there is only one it can mean.
    const implied = /\bgh\s/.test(command) || (writing === 'git push' && !hosts.length) ? ['github.com'] : [];
    try {
      for (const h of hosts) need('read', h, 'a command names it');
      if (writing) for (const h of [...hosts, ...implied]) need('write', h, writing);
      for (const h of implied) need('read', h, 'a command reaches it');
    } catch (err) {
      if (err.denied) return err.message;
      throw err;
    }
    return '';
  }

  /** What a command is given so that git and gh can sign in to GitHub — when agents may read it at all. */
  function githubEnv(kind) {
    const token = config.secret('github_token') || '';
    if (!token) return {};
    if (kind !== 'human' && !site('github.com').read) return {};
    return {
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
    };
  }

  /** The terminal as an agent holds it. A person's commands are not read. */
  function guardTerminal(terminal) {
    if (!terminal) return terminal;
    return {
      ...terminal,
      run(opts) {
        const kind = opts?.kind ?? 'human';
        if (kind !== 'human') {
          const why = refusal(opts?.command);
          if (why) return Promise.reject(new Denied(why));
        }
        return terminal.run({ ...opts, env: { ...(opts?.env ?? {}), ...githubEnv(kind) } });
      },
    };
  }

  // ---------------------------------------------------------------- programs

  const app = (name) => read().apps.find((a) => a.name.toLowerCase() === String(name ?? '').toLowerCase()) ?? null;

  /** The programs an agent may be told about. */
  const appsFor = () => read().apps.filter((a) => a.read).map((a) => ({ name: a.name, read: a.read, write: a.write }));

  /**
   * An agent uses a program on this computer.
   *
   * With read, it can open one file of the PC's folder in the program — the
   * person sees it open. With write, it can run the program with arguments of
   * its own and gets back what the program printed. Either way it runs on this
   * computer, as the person, which is why each program is listed by hand.
   */
  function useApp({ name, file = '', args = '', by = 'agent' }) {
    const a = app(name);
    if (!a || !a.read) {
      const known = appsFor().map((x) => x.name).join(', ') || 'none';
      return Promise.reject(new Denied(`not allowed: "${name}" is not a program agents may use. Allowed: ${known}. A person can add one in Agents' PC → Permissions`));
    }
    const extra = String(args ?? '').trim();
    if (extra && !a.write) {
      return Promise.reject(new Denied(`not allowed: agents may open files in ${a.name} but not run it with their own arguments. A person can allow write for it in Agents' PC → Permissions`));
    }
    if (/[\n\r;&|`$<>]/.test(extra)) return Promise.reject(new Error('arguments only — no pipes, redirects or second commands'));

    const dir = sandbox?.folder().hostDir ?? process.cwd();
    const argv = [];
    if (extra) for (const m of extra.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) argv.push(m[1] ?? m[2] ?? m[3]);
    if (file) {
      const full = resolve(dir, String(file).replace(/^[\\/]+/, ''));
      if (full !== dir && !full.startsWith(dir + (process.platform === 'win32' ? '\\' : '/'))) return Promise.reject(new Error('that file is outside the PC\'s folder'));
      if (!existsSync(full)) return Promise.reject(new Error(`there is no ${file} in the PC's folder`));
      argv.push(full);
    }
    if (!file && !extra) argv.push(dir);

    return new Promise((done, fail) => {
      let out = '';
      let child;
      try {
        child = spawnImpl(a.command, argv, { cwd: existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined, windowsHide: false, shell: process.platform === 'win32' });
      } catch (err) { fail(new Error(`${a.name} would not start: ${err.message}`)); return; }
      const keep = (b) => { if (out.length < 20_000) out += b.toString('utf8'); };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      let settled = false;
      const finish = (text) => { if (settled) return; settled = true; clearTimeout(timer); done({ app: a.name, by, output: text }); };
      child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); fail(new Error(`${a.name} would not start: ${err.message}`)); } });
      child.on('close', (code) => finish(`exit ${code}\n${out || '(no output)'}`));
      // A program with a window does not end; it is left open, and that is the result.
      const timer = setTimeout(() => {
        try { child.unref(); } catch { /* already gone */ }
        finish(`${a.name} is open${out ? `\n${out}` : ''}`);
      }, extra ? 60_000 : 2500);
    });
  }

  return {
    view, save, read, clean, site, need, allow, setGithubToken,
    guardBrowser, guardWeb, guardTerminal, refusal, githubEnv,
    appsFor, useApp,
  };
}
