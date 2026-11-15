#!/usr/bin/env node
/**
 * Link a folder to the running room, from a terminal.
 *
 *   npm run link                      this folder
 *   npm run link -- "C:\\code\\shop"    that one
 *   npm run link -- --unlink          let go of the one in use
 *
 * This is the same thing the "link a folder" menu in the room does, for
 * whoever would rather type it — and for any editor, since every editor has a
 * terminal or a way to run a command. The room has to be running.
 */

import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? '');
};
const has = (name) => args.includes(`--${name}`);
const valued = new Set(['url', 'as', 'token']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(String(args[i - 1] ?? '').replace(/^--/, '')));

if (has('help') || has('h')) {
  process.stdout.write([
    'Link a folder on this computer to the running room, so the agents work in it.',
    '',
    '  esprits-link [folder] [--as name] [--url http://127.0.0.1:4300] [--token T] [--unlink]',
    '',
    '  folder     the folder to link; this one if left out',
    '  --as       who you are in the room; needed when more than one person is in it',
    '  --url      where the room is (ESPRITS_URL)',
    '  --token    its access token, if it asks for one (ESPRITS_TOKEN)',
    '  --unlink   stop working in the folder currently linked',
    '',
  ].join('\n'));
  process.exit(0);
}

const base = (flag('url') || process.env.ESPRITS_URL || `http://127.0.0.1:${process.env.ESPRITS_PORT ?? process.env.PORT ?? 4300}`).replace(/\/+$/, '');
const token = flag('token') || process.env.ESPRITS_TOKEN || '';

async function call(path, body) {
  let res;
  try {
    res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`the room is not running at ${base} — start it with "npm start" in its folder`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('the room asked for its access token — pass --token, or set ESPRITS_TOKEN');
  if (!res.ok) throw new Error(data.error ?? `the room answered ${res.status}`);
  return data;
}

try {
  // Who is asking. With one person in the room it can only be them.
  let as = flag('as') || process.env.ESPRITS_HUMAN || '';
  if (!as) {
    const people = (await call('/api/overview')).roster.filter((a) => a.kind === 'human').map((a) => a.name);
    if (people.length === 1) [as] = people;
    else throw new Error(people.length
      ? `more than one person is in the room (${people.join(', ')}) — say which you are with --as`
      : 'nobody has joined the room yet — open it once in a browser and say who you are, or pass --as with a name you have used there');
  }

  if (has('unlink')) {
    const now = await call('/api/sandbox');
    if (!now.linked) throw new Error(`the room is working in ${now.dir}, which is not a linked folder`);
    const after = await call('/api/sandbox/unlink', { name: now.folder, as });
    process.stdout.write(`Let go of ${now.hostDir}. Nothing in it was touched.\nThe room is back in ${after.dir}.\n`);
  } else {
    const folder = resolve(positional[0] ?? process.cwd());
    const linked = await call('/api/sandbox/link', { path: folder, as });
    process.stdout.write(`The room now works in ${linked.hostDir}\n`
      + (linked.isolated
        ? `  inside its sandbox (${linked.engine}): this folder is all the agents can see.\n`
        : '  directly on this computer: no sandbox engine is running, so commands are not isolated.\n')
      + `  Open the room at ${base}/\n`);
  }
} catch (err) {
  process.stderr.write(`esprits-link: ${err.message}\n`);
  process.exit(1);
}
