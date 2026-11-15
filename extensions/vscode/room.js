/**
 * Talking to the room, from an editor.
 *
 * Nothing in this file knows about the editor: it is the room's HTTP API with
 * names on it. That is what lets it be checked against a real room without an
 * editor in the way — and what an extension for a different editor would
 * start from.
 */

function createRoom({ url = 'http://127.0.0.1:4300', token = '', fetchImpl = globalThis.fetch } = {}) {
  const base = String(url).replace(/\/+$/, '');

  async function call(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      const err = new Error(`the room is not running at ${base} — start it with "npm start" in its folder`);
      err.offline = true;
      throw err;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
    if (res.status === 401) throw new Error('the room asked for its access token — set it in the "esprits.token" setting (it is printed when the room starts with npm run serve)');
    if (!res.ok) throw new Error(data.error || `the room answered ${res.status}`);
    return data;
  }

  return {
    base,
    call,
    health: () => call('/health'),
    /** Take a place in the room as a person. Joining again under the same name is the same person. */
    join: (name) => call('/api/join', { method: 'POST', body: { name, role: 'human', kind: 'human' } }),
    /** Who can answer, in what order, and who the coordinator is. */
    rounds: (idea) => call(`/api/rounds${idea ? `?idea=${encodeURIComponent(idea)}` : ''}`),
    /** What the sandbox is, and which folder the room is working in. */
    status: () => call('/api/sandbox'),
    /** Point the room at a folder on this computer. */
    link: (path, as) => call('/api/sandbox/link', { method: 'POST', body: { path, as } }),
    unlink: (name, as) => call('/api/sandbox/unlink', { method: 'POST', body: { name, as } }),
    say: ({ body, as, idea = null }) => call('/api/post', { method: 'POST', body: { body, as, idea } }),
    dropIdea: ({ title, raw = '', as }) => call('/api/ideas', { method: 'POST', body: { title, raw, as } }),
    run: (command, as) => call('/api/terminal/run', { method: 'POST', body: { command, as } }),
    /** Commands run since one that has been seen. */
    commandsSince: (id = 0) => call(`/api/terminal?since=${Number(id) || 0}&limit=50`),
    /** Messages said since one that has been seen. */
    saidSince: (id = 0) => call(`/api/feed?since=${Number(id) || 0}`),
  };
}

/**
 * A piece of code, put so the agents can tell what and where it is.
 *
 * The fence is made longer than any run of backticks inside the code, or a
 * selection that itself contains a fence would end this one early and the
 * rest would arrive as prose.
 */
function quote({ file, from, to, language = '', text }) {
  const longest = Math.max(2, ...(String(text).match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const where = file ? `${file}${from ? `:${from}${to && to !== from ? `-${to}` : ''}` : ''}` : '';
  return `${where ? `From \`${where}\`:\n` : ''}${fence}${language}\n${String(text).replace(/\s+$/, '')}\n${fence}`;
}

module.exports = { createRoom, quote };
