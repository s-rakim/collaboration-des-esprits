/**
 * The terminal and the browser, as one drawer every page can open.
 *
 * They are the same terminal and the same browser the agents use, so this is
 * not a second copy of either: what a person runs here the agents can see, and
 * what an agent ran is here with its name on it. That is why it lives in the
 * rail rather than on one page — it belongs to the project, not to a tab.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const me = () => { try { return localStorage.getItem('esprits.me') || ''; } catch { return ''; } };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `the server answered ${res.status}`);
  return body;
}

const CSS = `
#tools{position:fixed;top:0;right:0;bottom:0;width:min(560px,96vw);z-index:60;display:none;flex-direction:column;
  background:var(--bg);border-left:1px solid var(--line);box-shadow:-12px 0 32px rgba(0,0,0,.28)}
#tools.open{display:flex}
#tools .bar{display:flex;align-items:center;gap:4px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--panel)}
#tools .bar button.tab{background:none;border:1px solid transparent;color:var(--dim);padding:5px 12px;border-radius:7px;font:inherit;font-size:13px;cursor:pointer}
#tools .bar button.tab.on{background:var(--panel2);border-color:var(--line);color:var(--text);font-weight:550}
#tools .bar .x{margin-left:auto;background:none;border:0;color:var(--faint);font-size:18px;cursor:pointer;padding:2px 8px}
#tools .pane{flex:1;min-height:0;display:none;flex-direction:column}
#tools .pane.on{display:flex}
#tools .where{padding:8px 12px;font-size:12px;color:var(--dim);border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#tools .where code{color:var(--text);overflow-wrap:anywhere}
#tools .where button,#tools .where label{font-size:11.5px}
#tools .scroll{flex:1;min-height:0;overflow:auto;padding:10px 12px}
#tools .run{margin-bottom:12px}
#tools .run .cmd{font-family:var(--mono);font-size:12.5px;color:var(--text);overflow-wrap:anywhere}
#tools .run .cmd b{color:var(--faint);font-weight:400}
#tools .run .who{font-size:11px;color:var(--faint);margin-left:6px}
#tools .run .who.agent{color:var(--warn)}
#tools .run pre{margin:4px 0 0;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
  font-family:var(--mono);font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;color:var(--dim)}
#tools .run .code{font-size:11px;color:var(--faint)}
#tools .run .code.bad{color:var(--bad)}
#tools .in{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line);background:var(--panel)}
#tools .in input{flex:1;font-family:var(--mono);font-size:13px}
#tools .empty{color:var(--faint);font-size:12.5px;padding:14px 2px;line-height:1.55}
#tools .err{color:var(--bad);font-size:12px;padding:6px 12px}
#tools .page h4{margin:0 0 2px;font-size:14px}
#tools .page a{color:var(--dim);font-size:11.5px;overflow-wrap:anywhere}
#tools .page img{width:100%;border:1px solid var(--line);border-radius:8px;margin:10px 0;display:block}
#tools .page .text{font-size:12.5px;color:var(--dim);white-space:pre-wrap;line-height:1.5;max-height:240px;overflow:auto;
  border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--panel)}
#tools .visits{margin-top:14px;font-size:12px}
#tools .visits div{padding:4px 0;border-top:1px solid var(--line);color:var(--dim);overflow-wrap:anywhere}
#tools .visits b{color:var(--text);font-weight:550}
`;

let root = null;
let timer = null;
let lastRun = 0;
let shown = 'terminal';

function build() {
  if (root) return root;
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  root = document.createElement('aside');
  root.id = 'tools';
  root.innerHTML = `
    <div class="bar">
      <button class="tab" data-tab="terminal">Terminal</button>
      <button class="tab" data-tab="browser">Browser</button>
      <button class="x" title="Close">×</button>
    </div>
    <div class="pane" data-pane="terminal">
      <div class="where" id="tWhere"></div>
      <div class="scroll" id="tRuns"></div>
      <div class="err" id="tErr"></div>
      <form class="in" id="tForm">
        <input id="tCmd" placeholder="a command, run in the project folder" autocomplete="off" spellcheck="false">
        <button class="primary">Run</button>
      </form>
    </div>
    <div class="pane" data-pane="browser">
      <div class="where" id="bWhere"></div>
      <form class="in" id="bForm" style="border-top:0;border-bottom:1px solid var(--line)">
        <input id="bGo" placeholder="an address, or something to search for" autocomplete="off" style="font-family:inherit">
        <button class="primary">Go</button>
      </form>
      <div class="err" id="bErr"></div>
      <div class="scroll" id="bPage"></div>
    </div>`;
  document.body.append(root);

  root.querySelector('.x').addEventListener('click', close);
  for (const b of root.querySelectorAll('[data-tab]')) b.addEventListener('click', () => show(b.dataset.tab));

  // ---------------------------------------------------------------- terminal
  root.querySelector('#tForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = root.querySelector('#tCmd');
    const command = box.value.trim();
    if (!command) return;
    const err = root.querySelector('#tErr');
    err.textContent = '';
    box.disabled = true;
    try {
      await api('/api/terminal/run', { method: 'POST', body: JSON.stringify({ command, as: me() }) });
      box.value = '';
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      box.disabled = false;
      box.focus();
      refreshTerminal();
    }
  });

  root.querySelector('#tWhere').addEventListener('click', async (e) => {
    if (e.target.closest('#tPick')) {
      const current = root.querySelector('#tWhere code')?.textContent ?? '';
      const folder = prompt('The project folder — the full path. Commands start here.', current);
      if (folder === null) return;
      try { await api('/api/workspace', { method: 'POST', body: JSON.stringify({ folder }) }); }
      catch (ex) { root.querySelector('#tErr').textContent = ex.message; }
      refreshTerminal(true);
    }
  });
  root.querySelector('#tWhere').addEventListener('change', async (e) => {
    if (e.target.id !== 'tAgents') return;
    await api('/api/workspace', { method: 'POST', body: JSON.stringify({ agentsAllowed: e.target.checked }) }).catch(() => {});
    refreshTerminal(true);
  });

  // ----------------------------------------------------------------- browser
  root.querySelector('#bForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = root.querySelector('#bGo');
    const go = box.value.trim();
    if (!go) return;
    const err = root.querySelector('#bErr');
    err.textContent = 'going…';
    try {
      await api('/api/browser/open', { method: 'POST', body: JSON.stringify({ go, as: me() }) });
      box.value = '';
      err.textContent = '';
    } catch (ex) { err.textContent = ex.message; }
    refreshBrowser();
  });
  root.querySelector('#bWhere').addEventListener('click', async (e) => {
    const err = root.querySelector('#bErr');
    try {
      if (e.target.closest('#bStart')) { err.textContent = 'starting Firefox…'; await api('/api/browser/start', { method: 'POST', body: '{}' }); err.textContent = ''; }
      if (e.target.closest('#bStop')) await api('/api/browser/stop', { method: 'POST', body: '{}' });
    } catch (ex) { err.textContent = ex.message; }
    refreshBrowser();
  });
  return root;
}

async function refreshTerminal(all = false) {
  if (!root) return;
  let t;
  try { t = await api('/api/terminal?limit=60'); } catch { return; }
  const where = root.querySelector('#tWhere');
  const ws = await api('/api/workspace').catch(() => ({}));
  where.innerHTML = t.ok
    ? `in <code>${esc(t.dir)}</code> <button id="tPick">change</button>
       <label style="margin-left:auto"><input type="checkbox" id="tAgents" ${ws.agentsAllowed ? 'checked' : ''}> agents may use it</label>`
    : `<span>${esc(t.why ?? 'no folder')}</span> <button id="tPick" class="primary">Choose the project folder</button>`;
  root.querySelector('#tCmd').disabled = !t.ok;

  const newest = t.runs.at(-1)?.id ?? 0;
  const stillRunning = t.runs.some((r) => r.running);
  if (!all && newest === lastRun && !stillRunning) return;
  lastRun = newest;
  const box = root.querySelector('#tRuns');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = t.runs.length
    ? t.runs.map((r) => `
      <div class="run">
        <div class="cmd"><b>$</b> ${esc(r.command)}<span class="who ${esc(r.kind)}">${esc(r.by)}${r.thread ? ` · thread ${r.thread}` : ''}</span></div>
        ${r.output ? `<pre>${esc(r.output)}</pre>` : ''}
        <div class="code ${r.exitCode ? 'bad' : ''}">${r.running ? 'running…' : `exit ${r.exitCode}${r.timedOut ? ' · stopped, it ran too long' : ''}`}</div>
      </div>`).join('')
    : `<p class="empty">Nothing has been run yet.<br>This is the same terminal the agents use: what you run here they can see,
       and what they run appears here with their name on it. A command starts in the project folder — it is not confined to it.</p>`;
  if (atBottom || all) box.scrollTop = box.scrollHeight;
}

async function refreshBrowser() {
  if (!root) return;
  let b;
  try { b = await api('/api/browser'); } catch { return; }
  root.querySelector('#bWhere').innerHTML = b.running
    ? `<span>Firefox is open — the same window the agents use.</span> <button id="bStop" style="margin-left:auto">Close it</button>`
    : b.installed
      ? `<span>Firefox is not open.</span> <button id="bStart" class="primary">Open Firefox</button>`
      : `<span>Firefox was not found on this machine. Install it from mozilla.org, then reopen this.</span>`;

  let page = null;
  if (b.running) page = await api('/api/browser/page').catch(() => null);
  const visits = [...b.visits].reverse();
  root.querySelector('#bPage').innerHTML = `
    ${page ? `
      <div class="page">
        <h4>${esc(page.title || '(no title)')}</h4>
        <a href="${esc(page.url)}" target="_blank" rel="noreferrer">${esc(page.url)}</a>
        <img src="/api/browser/shot?t=${Date.now()}" alt="what the browser is showing">
        <div class="text">${esc((page.text ?? '').slice(0, 4000)) || '(no readable text)'}</div>
      </div>` : `<p class="empty">A real Firefox window opens on this machine, on a profile of its own — not your everyday one.
        You and the agents both drive it: search here and they can read the results; they search and you watch it happen.</p>`}
    ${visits.length ? `<div class="visits"><strong>Where it has been</strong>${visits.map((v) => `
      <div><b>${esc(v.by)}</b> ${v.query ? `searched “${esc(v.query)}”` : `opened ${esc(v.title || v.url)}`}
      <br><span style="color:var(--faint)">${esc(v.url)}</span></div>`).join('')}</div>` : ''}`;
}

function show(tab) {
  shown = tab;
  for (const b of root.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of root.querySelectorAll('[data-pane]')) p.classList.toggle('on', p.dataset.pane === tab);
  if (tab === 'terminal') { refreshTerminal(true); root.querySelector('#tCmd').focus(); }
  else { refreshBrowser(); root.querySelector('#bGo').focus(); }
}

export function openTools(tab = 'terminal') {
  build().classList.add('open');
  show(tab);
  clearInterval(timer);
  // Polled while it is open, because the other hand on the terminal is an
  // agent's and nothing here would otherwise know it had typed.
  timer = setInterval(() => (shown === 'terminal' ? refreshTerminal() : null), 2000);
}

export function close() {
  root?.classList.remove('open');
  clearInterval(timer);
}

export function toggleTools(tab) {
  if (root?.classList.contains('open') && shown === tab) close();
  else openTools(tab);
}
