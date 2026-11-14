/**
 * The sandbox, as one drawer every page can open: its terminal, its browser,
 * and the files that have piled up in it.
 *
 * They are the same terminal and the same browser the agents use, so this is
 * not a second copy of either: what a person runs here the agents can see, and
 * what an agent ran is here with its name on it. That is why it lives in the
 * rail rather than on one page — it belongs to the project, not to a tab.
 *
 * The Files tab is the way out. Work stays in the sandbox until a person
 * exports it from here; nothing an agent does puts it anywhere else.
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
#tools .where button,#tools .where label{font-size:11.5px;white-space:nowrap}
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
#tools .where select{width:auto;font-size:12px;padding:2px 6px}
#tools .where .state{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--line);border-radius:20px;padding:1px 8px;color:var(--good);border-color:var(--good)}
#tools .where .state.off{color:var(--bad);border-color:var(--bad)}
#tools .where .state.wait{color:var(--warn);border-color:var(--warn)}
#tools .warn{padding:10px 12px;font-size:12.5px;line-height:1.55;color:var(--dim);border-bottom:1px solid var(--line)}
#tools .warn b{color:var(--text)}
#tools .warn .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
#tools .warn a{color:var(--faint);font-size:11.5px;cursor:pointer;text-decoration:underline}
#tools .file{display:flex;gap:8px;align-items:baseline;padding:4px 2px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:12px;cursor:pointer;color:var(--dim)}
#tools .file:hover{color:var(--text)}
#tools .file.heavy,#tools .file.link{cursor:default;color:var(--faint)}
#tools .file span{margin-left:auto;color:var(--faint);font-size:11px;white-space:nowrap}
#tools .view{margin:8px 0 12px;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
  font-family:var(--mono);font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;color:var(--text)}
#tools .out{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 12px;border-top:1px solid var(--line);background:var(--panel)}
#tools .out .say{font-size:12px;color:var(--dim);flex-basis:100%;overflow-wrap:anywhere}
#tools .out .say.err{color:var(--bad)} #tools .out .say.ok{color:var(--good)}
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
      <button class="tab" data-tab="files">Files</button>
      <button class="x" title="Close">×</button>
    </div>
    <div class="pane" data-pane="files">
      <div class="where" id="fWhere"></div>
      <div class="scroll" id="fList"></div>
      <div class="out">
        <a class="primary" id="fZip" style="text-decoration:none;padding:6px 12px;border-radius:7px;border:1px solid var(--line);font-size:13px" download>Download as a zip</a>
        <button id="fCopy">Copy to a folder on this computer…</button>
        <div class="say" id="fSay"></div>
      </div>
    </div>
    <div class="pane" data-pane="terminal">
      <div class="where" id="tWhere"></div>
      <div class="warn" id="tWarn" hidden></div>
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

  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

  /** Choosing a folder is the same wherever it is done: one of the sandbox's, or a new name. */
  root.addEventListener('change', async (e) => {
    if (e.target.matches('[data-folder]')) {
      let folder = e.target.value;
      if (folder === '+') {
        folder = prompt('A name for the new folder in the sandbox — letters, numbers, dashes.', '');
        if (!folder) return refresh(true);
      }
      try { await post('/api/sandbox', { folder }); } catch (ex) { root.querySelector('#tErr').textContent = ex.message; }
      return refresh(true);
    }
    if (e.target.id === 'tAgents') {
      await post('/api/workspace', { agentsAllowed: e.target.checked }).catch(() => {});
      return refresh(true);
    }
    if (e.target.id === 'fNet') {
      await post('/api/sandbox', { network: e.target.checked }).catch((ex) => { root.querySelector('#fSay').textContent = ex.message; });
      return refresh(true);
    }
  });

  root.querySelector('#tWarn').addEventListener('click', async (e) => {
    const err = root.querySelector('#tErr');
    try {
      if (e.target.closest('#sCheck')) { err.textContent = 'checking…'; await api('/api/sandbox?recheck'); err.textContent = ''; }
      if (e.target.closest('#sLoose')) {
        const ok = confirm('Run commands on this computer with no sandbox?\n\n'
          + 'They will run as you, and can read and change anything you can — the agents\' commands too. '
          + 'A sandbox needs Docker Desktop or Podman; installing one is the better answer.');
        if (ok) await post('/api/sandbox', { unconfined: true, as: me() });
      }
      if (e.target.closest('#sTight')) await post('/api/sandbox', { unconfined: false, as: me() });
    } catch (ex) { err.textContent = ex.message; }
    refresh(true);
  });

  // ------------------------------------------------------------------- files
  root.querySelector('#fList').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-path]');
    if (!row) return;
    const view = root.querySelector('#fView');
    try {
      const f = await api(`/api/sandbox/file?path=${encodeURIComponent(row.dataset.path)}`);
      view.hidden = false;
      view.textContent = f.binary ? `${f.path} is not text (${f.size} bytes) — export it to open it.`
        : f.text + (f.clipped ? '\n… the rest is not shown' : '');
    } catch (ex) { view.hidden = false; view.textContent = ex.message; }
  });
  root.querySelector('#fCopy').addEventListener('click', async () => {
    const say = root.querySelector('#fSay');
    const to = prompt('Copy this folder to where? The full path of a folder on this computer.\n'
      + 'It goes into a new folder there, and never over an existing one.', '');
    if (!to) return;
    say.className = 'say'; say.textContent = 'copying…';
    try {
      const r = await post('/api/sandbox/export', { to, as: me() });
      say.className = 'say ok'; say.textContent = `Copied ${r.files} file(s) to ${r.to}`;
    } catch (ex) { say.className = 'say err'; say.textContent = ex.message; }
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

const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const folderPick = (sb) => `<select data-folder title="The folder inside the sandbox where commands start">
  ${sb.folders.map((f) => `<option ${f === sb.folder ? 'selected' : ''}>${esc(f)}</option>`).join('')}
  <option value="+">new folder…</option></select>`;

/** What the sandbox is, in a word — the thing a person most needs to be able to see at a glance. */
const badge = (sb) => (sb.preparing ? '<span class="state wait">getting ready</span>'
  : sb.isolated ? `<span class="state" title="Commands run in a ${esc(sb.engine)} container (${esc(sb.image)}) that can see this folder and nothing else on the computer">sandboxed</span>`
  : sb.unconfined ? '<span class="state off" title="Commands run directly on this computer">not sandboxed</span>'
  : '<span class="state off">no sandbox</span>');

function refresh(all = false) {
  if (shown === 'terminal') return refreshTerminal(all);
  if (shown === 'files') return refreshFiles();
  return refreshBrowser();
}

async function refreshTerminal(all = false) {
  if (!root) return;
  let t; let sb;
  try { [t, sb] = await Promise.all([api('/api/terminal?limit=60'), api('/api/sandbox')]); } catch { return; }
  const where = root.querySelector('#tWhere');
  // Rebuilding the line under somebody choosing from its menu closes the menu.
  if (!(where.contains(document.activeElement) && document.activeElement.tagName === 'SELECT')) {
    where.innerHTML = `${badge(sb)} <code>${esc(sb.dir)}</code> ${folderPick(sb)}
      <label style="margin-left:auto"><input type="checkbox" id="tAgents" ${sb.agentsAllowed ? 'checked' : ''}> agents may use it</label>`;
  }
  const warn = root.querySelector('#tWarn');
  warn.hidden = sb.isolated && !sb.preparing && !sb.error;
  warn.innerHTML = sb.preparing
    ? 'Getting the sandbox ready. The first time, this downloads its image, which can take a few minutes; commands wait for it.'
    : sb.error ? `<b>The sandbox would not start.</b> ${esc(sb.error)}<div class="row"><button id="sCheck">Check again</button></div>`
    : sb.unconfined
      ? `<b>Not sandboxed.</b> Commands — yours and the agents' — run directly on this computer, in ${esc(sb.hostDir)}, and can reach anything you can.
         <div class="row"><button id="sTight" class="primary">Stop running without a sandbox</button><button id="sCheck">Check for a sandbox again</button></div>`
      : `<b>Nothing can be run yet.</b> ${esc(sb.why)}. Work here runs in a sandbox — a container that sees one folder and nothing else on this computer — and there is no engine to make one.
         <div class="row"><button id="sCheck" class="primary">Check again</button><a id="sLoose">run without a sandbox</a></div>`;
  root.querySelector('#tCmd').disabled = !sb.ready;
  root.querySelector('#tCmd').placeholder = sb.isolated ? 'a command, run inside the sandbox' : sb.ready ? 'a command — NOT sandboxed' : 'no sandbox — see above';

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
       and what they run appears here with their name on it. What gets made stays in the sandbox until you export it from the Files tab.</p>`;
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

async function refreshFiles() {
  if (!root) return;
  let sb; let list;
  try { [sb, list] = await Promise.all([api('/api/sandbox'), api('/api/sandbox/files')]); } catch { return; }
  const where = root.querySelector('#fWhere');
  if (!(where.contains(document.activeElement) && document.activeElement.tagName === 'SELECT')) {
    where.innerHTML = `${badge(sb)} ${folderPick(sb)} <span>${list.files.filter((f) => f.kind === 'file').length} file(s), ${size(list.bytes)}</span>
      <label style="margin-left:auto" title="Whether commands in the sandbox can reach the internet, for installing packages">
        <input type="checkbox" id="fNet" ${sb.network ? 'checked' : ''}> network</label>`;
  }
  const box = root.querySelector('#fList');
  const open = box.querySelector('#fView');
  const keep = open && !open.hidden ? open.textContent : null;
  box.innerHTML = `<pre class="view" id="fView" hidden></pre>` + (list.files.length
    ? list.files.map((f) => f.kind === 'file'
      ? `<div class="file" data-path="${esc(f.path)}">${esc(f.path)}<span>${size(f.size)}</span></div>`
      : `<div class="file ${f.kind}">${esc(f.path)}<span>${f.kind === 'heavy' ? 'not listed' : 'a link'}</span></div>`).join('')
      + (list.clipped ? '<p class="empty">…and more. Export the folder to see all of it.</p>' : '')
    : `<p class="empty">Nothing has been made in <b>${esc(list.folder)}</b> yet.<br>Everything the agents and you create from the terminal lands here,
       inside the sandbox. When it is worth keeping, export it — as a zip, or copied to a folder of yours. Nothing leaves any other way.</p>`);
  if (keep !== null) { const v = box.querySelector('#fView'); v.hidden = false; v.textContent = keep; }
  root.querySelector('#fZip').href = `/api/sandbox/export.zip?folder=${encodeURIComponent(list.folder)}`;
  root.querySelector('#fZip').style.pointerEvents = list.files.length ? '' : 'none';
  root.querySelector('#fZip').style.opacity = list.files.length ? '' : '.5';
  root.querySelector('#fCopy').disabled = !list.files.length;
}

function show(tab) {
  shown = tab;
  for (const b of root.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of root.querySelectorAll('[data-pane]')) p.classList.toggle('on', p.dataset.pane === tab);
  if (tab === 'terminal') { refreshTerminal(true); root.querySelector('#tCmd').focus(); }
  else if (tab === 'files') refreshFiles();
  else { refreshBrowser(); root.querySelector('#bGo').focus(); }
}

export function openTools(tab = 'terminal') {
  build().classList.add('open');
  show(tab);
  clearInterval(timer);
  // Polled while it is open, because the other hand on the terminal is an
  // agent's and nothing here would otherwise know it had typed.
  timer = setInterval(() => (shown === 'terminal' ? refreshTerminal() : shown === 'files' ? refreshFiles() : null), 2000);
}

export function close() {
  root?.classList.remove('open');
  clearInterval(timer);
}

export function toggleTools(tab) {
  if (root?.classList.contains('open') && shown === tab) close();
  else openTools(tab);
}
