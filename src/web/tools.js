/**
 * The Agents' PC's tools, on every page: a terminal and a browser, each a
 * small window that floats.
 *
 * They are shaped by how each is used. A terminal is something you glance at
 * and type a line into while doing something else, so it is a window you put
 * where it is out of the way — drag it, size it, leave it open. A browser is
 * something you look at for as long as the agents are using it, so it takes a
 * share of the page beside the conversation rather than covering it.
 *
 * Both are the same ones the agents use. What a person runs or opens here the
 * agents can see, and what an agent ran or opened is here with its name on it.
 * The window's Files tab is the way out of the sandbox: work stays in it until
 * a person exports it from there.
 */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const me = () => { try { return localStorage.getItem('esprits.me') || ''; } catch { return ''; } };

export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `the server answered ${res.status}`), { code: body.code });
  return body;
}

const CSS = `
#tools{position:fixed;right:52px;bottom:24px;width:600px;height:380px;z-index:60;display:none;flex-direction:column;
  min-width:380px;min-height:230px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);
  background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:hidden;resize:both;
  box-shadow:0 24px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03)}
#tools.open{display:flex;animation:tools-in .16s cubic-bezier(.2,.7,.3,1)}
#tools.moving{user-select:none;transition:none;opacity:.96}
@keyframes tools-in{from{opacity:0;transform:translateY(10px) scale(.985)}}
#tools .tbar{display:flex;align-items:center;gap:4px;padding:6px 8px 6px 10px;border-bottom:1px solid var(--line);background:var(--panel);cursor:move;touch-action:none}
#tools .tbar .ttl{font-size:11px;color:var(--faint);margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
@media (max-width:700px){#tools{left:8px!important;right:8px!important;top:auto!important;bottom:8px!important;width:auto!important;height:60vh!important;resize:none}}

/* The browser: a second small window, moved and sized like the terminal. */
#dock{position:fixed;right:52px;top:72px;width:520px;height:400px;z-index:60;display:none;flex-direction:column;
  min-width:340px;min-height:260px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);
  background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:hidden;resize:both;
  box-shadow:0 24px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03)}
#dock.open{display:flex;animation:tools-in .16s cubic-bezier(.2,.7,.3,1)}
#dock.moving,#tools.moving{user-select:none;opacity:.96}
#tools.front,#dock.front{z-index:61}
@media (max-width:700px){#dock{left:8px!important;right:8px!important;top:8px!important;bottom:auto!important;width:auto!important;height:55vh!important;resize:none}}

/* The way in to both: tabs on the right-hand edge of every page. */
#edge-tabs{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:59;display:flex;flex-direction:column;gap:6px}
#edge-tabs button{writing-mode:vertical-rl;padding:14px 7px;font-size:12px;letter-spacing:.04em;color:var(--dim);
  background:var(--panel);border:1px solid var(--line);border-right:0;border-radius:9px 0 0 9px;cursor:pointer;
  transition:padding .12s ease,color .12s ease,background .12s ease}
#edge-tabs button:hover{padding-right:12px;color:var(--text);background:var(--panel2)}
#edge-tabs button.on{color:var(--bg);background:var(--text);border-color:var(--text)}
@media (max-width:700px){#edge-tabs button{padding:10px 5px;font-size:11px}}
#dock .nav{cursor:move;touch-action:none;display:flex;align-items:center;gap:5px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--panel)}
#dock .nav button{padding:4px 9px;font-size:13px;line-height:1.2;background:none;border-color:transparent;color:var(--dim)}
#dock .nav button:hover:not(:disabled){background:var(--panel2);border-color:var(--line);color:var(--text)}
#dock .nav form{flex:1;min-width:0;display:flex}
#dock .nav input{flex:1;min-width:0;border-radius:20px;padding:5px 13px;font-size:12.5px;background:var(--bg)}
#dock .who{display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11.5px;color:var(--faint);border-bottom:1px solid var(--line);min-height:26px}
#dock .who b{color:var(--dim);font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dock .who .lamp{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
#dock .who .lamp.on{background:var(--good)}
#dock .err{color:var(--bad);font-size:12px;padding:5px 12px}
#dock .err:empty{display:none}
#dock .view{flex:1;min-height:0;overflow:auto;background:var(--panel);display:flex;align-items:flex-start;justify-content:center}
#dock .view img{width:100%;display:block;cursor:pointer;user-select:none;-webkit-user-drag:none}
#dock .view.busy img{opacity:.75}
#dock .hello{align-self:center;text-align:center;padding:30px;max-width:420px;color:var(--dim);font-size:13.5px;line-height:1.6}
#dock .hello h4{font-family:var(--serif);font-weight:500;font-size:20px;color:var(--text);margin:0 0 8px}
#dock .hello button{margin-top:14px}
#dock .type{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--line);background:var(--panel)}
#dock .type input{flex:1;font-size:12.5px}
#dock details{border-top:1px solid var(--line);font-size:12px;max-height:38vh;overflow:auto}
#dock summary{padding:7px 12px;cursor:pointer;color:var(--dim);user-select:none}
#dock .text{white-space:pre-wrap;color:var(--dim);line-height:1.5;padding:0 12px 10px}
#dock .visits div{padding:5px 12px;border-top:1px solid var(--line);color:var(--dim);overflow-wrap:anywhere}
#dock .visits b{color:var(--text);font-weight:550}
.split{flex:none;background:transparent;position:relative;z-index:2;touch-action:none}
.split.x{width:7px;margin:0 -3px;cursor:col-resize}
.split.y{height:7px;margin:-3px 0;cursor:row-resize}
.split::after{content:'';position:absolute;inset:0;margin:auto;background:var(--line);transition:background .12s ease}
.split.x::after{width:1px;height:100%} .split.y::after{height:1px;width:100%}
.split:hover::after,.split.dragging::after{background:var(--accent)}
.split.x:hover::after,.split.x.dragging::after{width:3px} .split.y:hover::after,.split.y.dragging::after{height:3px}
#tools .tbar button.tab{background:none;border:1px solid transparent;color:var(--dim);padding:5px 12px;border-radius:7px;font:inherit;font-size:13px;cursor:pointer}
#tools .tbar button.tab.on{background:var(--panel2);border-color:var(--line);color:var(--text);font-weight:550}
#tools .tbar .x{margin-left:auto;background:none;border:0;color:var(--faint);font-size:18px;cursor:pointer;padding:2px 8px}
#tools .pane{flex:1;min-height:0;display:none;flex-direction:column}
#tools .pane.on{display:flex}
#tools .where{padding:8px 12px;font-size:12px;color:var(--dim);border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#tools .where code{color:var(--text);overflow-wrap:anywhere}
#tools .where button,#tools .where label{font-size:11.5px;white-space:nowrap}
#tools .scroll{flex:1;min-height:0;overflow:auto;padding:10px 12px}
#tools .trun{margin-bottom:12px}
#tools .trun .cmd{font-family:var(--mono);font-size:12.5px;color:var(--text);overflow-wrap:anywhere}
#tools .trun .cmd b{color:var(--faint);font-weight:400}
#tools .trun .who{font-size:11px;color:var(--faint);margin-left:6px}
#tools .trun .who.agent{color:var(--warn)}
#tools .trun pre{margin:4px 0 0;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
  font-family:var(--mono);font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;color:var(--dim)}
#tools .trun .code{font-size:11px;color:var(--faint)}
#tools .trun .code.bad{color:var(--bad)}
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
#tools input[type=checkbox]{width:auto;margin:0 4px 0 0;vertical-align:-2px}
#tools .where label{display:inline-flex;align-items:center}
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
const typed = [];
let typedAt = 0;
const steer = { terminal: null, browser: null };

let styled = false;
export const style = () => { if (!styled) { styled = true; document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`); } };

function build() {
  if (root) return root;
  style();
  root = document.createElement('div');
  root.id = 'tools';
  root.innerHTML = `
    <div class="tbar">
      <button class="tab" data-tab="terminal">Terminal</button>
      <button class="tab" data-tab="files">Export</button>
      <span class="ttl" id="tTitle"></span>
      <button class="x" title="Close (Ctrl \`)">×</button>
    </div>
    <div class="pane" data-pane="files">
      <div class="where" id="fWhere"></div>
      <div class="scroll" id="fList"></div>
      <div class="out">
        <a class="primary" id="fZip" style="text-decoration:none;padding:6px 12px;border-radius:7px;border:1px solid var(--line);font-size:13px" download>Download as a zip</a>
        <button id="fCopy">Copy to a folder on this computer…</button>
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
          <button id="fOpen" title="Open this folder in your code editor">Open in editor</button>
          <select id="fEditor" style="width:auto;font-size:12px;padding:5px 6px" title="Which editor"></select>
        </span>
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
      <div id="tSteer"></div>
    </div>`;
  document.body.append(root);

  root.querySelector('.x').addEventListener('click', close);
  for (const b of root.querySelectorAll('[data-tab]')) b.addEventListener('click', () => show(b.dataset.tab));
  floating(root);

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
      typed.push(command); typedAt = typed.length;
      box.value = '';
      // Not waited for: a long command is watched as it runs, and can be stopped.
      api('/api/terminal/run', { method: 'POST', body: JSON.stringify({ command, as: me() }) })
        .catch((ex) => { err.textContent = ex.message; }).finally(() => refreshTerminal(true));
      await new Promise((r) => setTimeout(r, 150));
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      box.disabled = false;
      box.focus();
      refreshTerminal();
    }
  });

  // Up and down bring back what was typed before, as a terminal does.
  root.querySelector('#tCmd').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (!typed.length) return;
    e.preventDefault();
    typedAt = Math.max(0, Math.min(typed.length, typedAt + (e.key === 'ArrowUp' ? -1 : 1)));
    e.target.value = typed[typedAt] ?? '';
  });
  root.querySelector('#tRuns').addEventListener('click', async (e) => {
    const stop = e.target.closest('[data-stop]');
    if (!stop) return;
    await post(`/api/terminal/${stop.dataset.stop}/stop`, {}).catch(() => {});
    refreshTerminal(true);
  });
  import('/desk.js').then((desk) => { steer.terminal = desk.steerStrip(root.querySelector('#tSteer')); }).catch(() => {});

  /** Choosing a folder is the same wherever it is done: one of the sandbox's, or a new name. */
  root.addEventListener('change', async (e) => {
    if (e.target.matches('[data-folder]')) {
      let folder = e.target.value;
      const err = root.querySelector(shown === 'files' ? '#fSay' : '#tErr');
      err.textContent = '';
      try {
        if (folder === '@') return await linkFolder();
        if (folder === '-') {
          const sb = await api('/api/sandbox');
          if (confirm(`Stop working in ${sb.hostDir}?\n\nNothing in it is deleted; the room just lets go of it.`)) {
            await post('/api/sandbox/unlink', { name: sb.folder, as: me() });
          }
          return refresh(true);
        }
        if (folder === '+') {
          folder = prompt('A name for the new folder on the Agents’ PC — letters, numbers, dashes.', '');
          if (!folder) return refresh(true);
        }
        await post('/api/sandbox', { folder });
      } catch (ex) { err.textContent = ex.message; }
      return refresh(true);
    }
    if (e.target.id === 'fEditor') {
      let command = e.target.value;
      if (command === '?') {
        command = prompt('The command that starts your editor — its name if it is on the PATH (code, cursor, zed, subl, idea…), or the full path to its program.', '');
        if (command === null) return refreshFiles();
      }
      try { await post('/api/editor', { command, as: me() }); } catch (ex) { root.querySelector('#fSay').textContent = ex.message; }
      return refreshFiles();
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

  /** Point the room at a folder of the person's own. */
  async function linkFolder() {
    const path = prompt('Link a folder on this computer — the full path of the project you want the room to work in.\n\n'
      + 'With Docker running, that folder is all the agents can see. Without it, their commands run directly on this computer in that folder.', '');
    if (!path) return refresh(true);
    try { await post('/api/sandbox/link', { path, as: me() }); }
    catch (ex) { root.querySelector(shown === 'files' ? '#fSay' : '#tErr').textContent = ex.message; }
    return refresh(true);
  }

  root.querySelector('#tWarn').addEventListener('click', async (e) => {
    const err = root.querySelector('#tErr');
    try {
      if (e.target.closest('#sLink')) return await linkFolder();
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
  root.querySelector('#fOpen').addEventListener('click', async () => {
    const say = root.querySelector('#fSay');
    say.className = 'say'; say.textContent = 'opening…';
    try {
      const r = await post('/api/sandbox/open', { as: me() });
      say.className = 'say ok'; say.textContent = `Opened ${r.opened} with ${r.with}`;
    } catch (ex) { say.className = 'say err'; say.textContent = ex.message; }
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

  return root;
}

export const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const folderPick = (sb) => {
  const linked = new Map((sb.links ?? []).map((l) => [l.name, l.path]));
  return `<select data-folder title="Where commands start: a folder on the Agents' PC, or one of yours that you linked">
  ${sb.folders.map((f) => `<option value="${esc(f)}" ${f === sb.folder ? 'selected' : ''}
    ${linked.has(f) ? `title="${esc(linked.get(f))}"` : ''}>${esc(f)}${linked.has(f) ? ' ↗' : ''}</option>`).join('')}
  <option value="+">new folder on the PC…</option>
  <option value="@">link a folder on this computer…</option>
  ${sb.linked ? '<option value="-">unlink this folder</option>' : ''}</select>`;
};

/** What the sandbox is, in a word — the thing a person most needs to be able to see at a glance. */
const badge = (sb) => (sb.preparing ? '<span class="state wait">getting ready</span>'
  : sb.isolated ? `<span class="state" title="Commands run in a ${esc(sb.engine)} container (${esc(sb.image)}) that can see this folder and nothing else on the computer">sandboxed</span>`
  : sb.linked ? '<span class="state wait" title="Commands run directly on this computer, in a folder you linked">linked folder</span>'
  : sb.unconfined ? '<span class="state off" title="Commands run directly on this computer">not sandboxed</span>'
  : '<span class="state off">no sandbox</span>');

function refresh(all = false) {
  return shown === 'files' ? refreshFiles() : refreshTerminal(all);
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
    ? 'Getting the Agents\' PC ready. The first time, this downloads its image, which can take a few minutes; commands wait for it.'
    : sb.error ? `<b>The Agents' PC would not start.</b> ${esc(sb.error)}<div class="row"><button id="sCheck">Check again</button></div>`
    : sb.linked
      ? `<b>Working in your own folder.</b> Commands — yours and the agents' — run directly on this computer, in <code>${esc(sb.hostDir)}</code>. They are not sandboxed; with Docker running they would be, and could see only this folder.
         <div class="row"><button id="sCheck">Check for Docker again</button></div>`
    : sb.unconfined
      ? `<b>Not sandboxed.</b> Commands — yours and the agents' — run directly on this computer, in ${esc(sb.hostDir)}, and can reach anything you can.
         <div class="row"><button id="sTight" class="primary">Stop running without a sandbox</button><button id="sCheck">Check for a sandbox again</button></div>`
      : `<b>Nothing can be run yet.</b> ${esc(sb.why)}. Work here runs in a sandbox — a container that sees one folder and nothing else on this computer — and there is no engine to make one.
         <div class="row"><button id="sLink" class="primary">Link a folder on this computer</button><button id="sCheck">Check again</button><a id="sLoose">run anywhere without a sandbox</a></div>
         <div style="margin-top:8px;color:var(--faint);font-size:11.5px">No Docker? Link the project folder you have open in your editor and the room works in it directly.</div>`;
  root.querySelector('#tTitle').textContent = sb.dir;
  root.querySelector('#tCmd').placeholder = sb.isolated ? "a command, run on the Agents' PC — or pc help"
    : sb.linked && sb.ready ? `a command, run in ${sb.folder} on this computer — or pc help`
    : sb.ready ? 'a command — NOT sandboxed — or pc help' : 'nowhere to run it yet — see above (pc help still works)';
  steer.terminal?.update();

  const newest = t.runs.at(-1)?.id ?? 0;
  const stillRunning = t.runs.some((r) => r.running);
  if (!all && newest === lastRun && !stillRunning) return;
  lastRun = newest;
  const box = root.querySelector('#tRuns');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = t.runs.length
    ? t.runs.map((r) => `
      <div class="trun">
        <div class="cmd"><b>$</b> ${esc(r.command)}<span class="who ${esc(r.kind)}">${esc(r.by)}${r.thread ? ` · thread ${r.thread}` : ''}</span></div>
        ${r.output ? `<pre>${esc(r.output)}</pre>` : ''}
        <div class="code ${r.exitCode ? 'bad' : ''}">${r.running ? `running… <button data-stop="${r.id}" style="padding:0 8px;font-size:11px;margin-left:6px">Stop</button>` : `exit ${r.exitCode}${r.timedOut ? ' · stopped, it ran too long' : ''}`}</div>
      </div>`).join('')
    : `<p class="empty">Nothing has been run yet.<br>This is the same terminal the agents use: what you run here they can see,
       and what they run appears here with their name on it. What gets made stays on the Agents' PC until you export it — watch it appear in the Explorer.</p>`;
  if (atBottom || all) box.scrollTop = box.scrollHeight;
}

async function refreshFiles() {
  if (!root) return;
  let sb; let list; let ed;
  try { [sb, list, ed] = await Promise.all([api('/api/sandbox'), api('/api/sandbox/files'), api('/api/editor')]); } catch { return; }
  const pick = root.querySelector('#fEditor');
  if (document.activeElement !== pick) {
    const known = ed.found.some((x) => x.command === ed.editor);
    pick.innerHTML = [
      ...ed.found.map((x) => `<option value="${esc(x.command)}" ${x.command === ed.editor ? 'selected' : ''}>${esc(x.label)}</option>`),
      ed.editor && !known ? `<option value="${esc(ed.editor)}" selected>${esc(ed.editor)}</option>` : '',
      !ed.editor ? '<option value="" selected>the system\'s file manager</option>' : '',
      '<option value="?">another editor…</option>',
    ].join('');
  }
  const where = root.querySelector('#fWhere');
  if (!(where.contains(document.activeElement) && document.activeElement.tagName === 'SELECT')) {
    where.innerHTML = `${badge(sb)} ${folderPick(sb)} <span>${list.files.filter((f) => f.kind === 'file').length} file(s), ${size(list.bytes)}</span>
      <label style="margin-left:auto" title="Whether commands on the Agents' PC can reach the internet, for installing packages">
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
       on the Agents' PC. When it is worth keeping, export it — as a zip, or copied to a folder of yours. Nothing leaves any other way.</p>`);
  if (keep !== null) { const v = box.querySelector('#fView'); v.hidden = false; v.textContent = keep; }
  root.querySelector('#fZip').href = `/api/sandbox/export.zip?folder=${encodeURIComponent(list.folder)}`;
  root.querySelector('#fZip').style.pointerEvents = list.files.length ? '' : 'none';
  root.querySelector('#fZip').style.opacity = list.files.length ? '' : '.5';
  root.querySelector('#fCopy').disabled = !list.files.length;
}

function show(tab) {
  shown = tab === 'files' ? 'files' : 'terminal';
  for (const b of root.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === shown);
  for (const p of root.querySelectorAll('[data-pane]')) p.classList.toggle('on', p.dataset.pane === shown);
  if (shown === 'terminal') { refreshTerminal(true); root.querySelector('#tCmd').focus(); }
  else refreshFiles();
}

// ------------------------------------------------------- the floating window

const keep = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ } };
const kept = (key) => { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } };

/**
 * Make the window something you can put where you want it.
 *
 * Dragged by its bar, sized by its corner, and found again where it was left.
 * It is kept on the screen whatever happens to the screen: a window dragged
 * off the edge, or left where a smaller browser window no longer reaches, is
 * a window nobody can get back.
 */
export function floating(win, { key = 'esprits.terminal', handle = '.tbar' } = {}) {
  const place = (g) => {
    const w = Math.min(g.w, innerWidth - 16);
    const h = Math.min(g.h, innerHeight - 16);
    const x = Math.max(8, Math.min(g.x, innerWidth - w - 8));
    const y = Math.max(8, Math.min(g.y, innerHeight - 60));
    Object.assign(win.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto', width: `${w}px`, height: `${h}px` });
  };
  const was = kept(key);
  if (was && Number.isFinite(was.x)) place(was);

  const bar = win.querySelector(handle);
  // Whichever window was touched last is the one on top.
  win.addEventListener('pointerdown', () => {
    for (const w of document.querySelectorAll('#tools, #dock, .fwin')) w.classList.toggle('front', w === win);
  }, true);
  let from = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, select, a, label') || e.button !== 0) return;
    const box = win.getBoundingClientRect();
    from = { dx: e.clientX - box.left, dy: e.clientY - box.top, w: box.width, h: box.height };
    bar.setPointerCapture(e.pointerId);
    win.classList.add('moving');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!from) return;
    place({ x: e.clientX - from.dx, y: e.clientY - from.dy, w: from.w, h: from.h });
  });
  const drop = () => {
    if (!from) return;
    from = null;
    win.classList.remove('moving');
    const box = win.getBoundingClientRect();
    keep(key, { x: box.left, y: box.top, w: box.width, h: box.height });
  };
  bar.addEventListener('pointerup', drop);
  bar.addEventListener('pointercancel', drop);
  // Double-click the bar to send it back to its corner.
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, select, a, label')) return;
    Object.assign(win.style, { left: '', top: '', right: '', bottom: '', width: '', height: '' });
    try { localStorage.removeItem(key); } catch { /* nothing kept */ }
  });

  // Sized by its corner: remember that too, once it has stopped changing.
  let settle = null;
  new ResizeObserver(() => {
    if (!win.classList.contains('open') || from) return;
    clearTimeout(settle);
    settle = setTimeout(() => {
      const box = win.getBoundingClientRect();
      if (box.width) keep(key, { x: box.left, y: box.top, w: box.width, h: box.height });
    }, 300);
  }).observe(win);
  addEventListener('resize', () => { const g = kept(key); if (g && win.classList.contains('open')) place(g); });
}

/**
 * A bar between two sections that is dragged to share the space differently.
 *
 * `size` reads the section's size and `set` gives it a new one; which way is
 * bigger depends on which side of the bar the section is, hence `invert`.
 * Where it was left is remembered, and a double-click puts it back.
 */
export function splitter(handle, { axis = 'x', size, set, min = 60, max = 1200, key = null, invert = false }) {
  const was = key ? kept(key) : null;
  if (Number.isFinite(was)) set(Math.max(min, Math.min(max, was)));
  let from = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    from = { at: axis === 'x' ? e.clientX : e.clientY, size: size() };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!from) return;
    const d = (axis === 'x' ? e.clientX : e.clientY) - from.at;
    set(Math.max(min, Math.min(typeof max === 'function' ? max() : max, from.size + (invert ? -d : d))));
  });
  const drop = () => {
    if (!from) return;
    from = null;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    if (key) keep(key, Math.round(size()));
  };
  handle.addEventListener('pointerup', drop);
  handle.addEventListener('pointercancel', drop);
  handle.addEventListener('dblclick', () => { set(null); if (key) { try { localStorage.removeItem(key); } catch { /* nothing kept */ } } });
}

/** The windows that live in desk.js: the PC itself, the explorer, the editors, the activity monitor. */
const DESK = ['pc', 'explorer', 'code', 'notes', 'activity'];

export function openTools(tab = 'terminal') {
  if (DESK.includes(tab)) return import('/desk.js').then((desk) => desk.openApp(tab));
  if (tab === 'browser') return openBrowser();
  build().classList.add('open');
  show(tab);
  clearInterval(timer);
  // Polled while it is open, because the other hand on the terminal is an
  // agent's and nothing here would otherwise know it had typed.
  timer = setInterval(() => (shown === 'terminal' ? refreshTerminal() : refreshFiles()), 2000);
}

export function close() {
  root?.classList.remove('open');
  clearInterval(timer);
}

export function toggleTools(tab) {
  if (DESK.includes(tab)) return import('/desk.js').then((desk) => desk.toggleApp(tab));
  if (tab === 'browser') return dock?.classList.contains('open') ? closeBrowser() : openBrowser();
  if (root?.classList.contains('open') && shown === tab) close();
  else openTools(tab);
}

// ------------------------------------------------------------- the browser

let dock = null;
let looking = null;
let shotBusy = false;

export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

function buildDock() {
  if (dock) return dock;
  style();
  dock = document.createElement('div');
  dock.id = 'dock';
  dock.innerHTML = `
    <div class="nav">
      <button data-act="back" title="Back">←</button>
      <button data-act="forward" title="Forward">→</button>
      <button data-act="reload" title="Reload">⟳</button>
      <form id="bForm"><input id="bGo" placeholder="an address, or something to search for" autocomplete="off" spellcheck="false"></form>
      <button id="bClose" title="Put the browser away">×</button>
    </div>
    <div class="who" id="bWho"></div>
    <div class="err" id="bErr"></div>
    <div class="view" id="bView"></div>
    <form class="type" id="bType">
      <input id="bKeys" placeholder="type into the page — click a box in it first, Enter sends" autocomplete="off">
      <button title="Type it, then press Enter in the page">Type ↵</button>
    </form>
    <details id="bMore"><summary>What the page says, and where the browser has been</summary>
      <div class="text" id="bText"></div><div class="visits" id="bVisits"></div></details>
    <div id="bSteer"></div>`;
  document.body.append(dock);
  import('/desk.js').then((desk) => { steer.browser = desk.steerStrip(dock.querySelector('#bSteer')); }).catch(() => {});
  floating(dock, { key: 'esprits.browser', handle: '.nav' });

  const say = (text) => { dock.querySelector('#bErr').textContent = text ?? ''; };
  const act = async (body) => {
    const view = dock.querySelector('#bView');
    view.classList.add('busy');
    try { await post('/api/browser/act', { ...body, as: me() }); say(''); }
    catch (ex) { say(ex.message); }
    view.classList.remove('busy');
    look(true);
  };

  dock.querySelector('#bClose').addEventListener('click', closeBrowser);
  dock.querySelector('.nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) act({ kind: b.dataset.act });
  });
  dock.querySelector('#bForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = dock.querySelector('#bGo');
    const go = box.value.trim();
    if (!go) return;
    say('going…');
    try { await post('/api/browser/open', { go, as: me() }); say(''); box.blur(); }
    catch (ex) { say(ex.message); }
    look(true);
  });
  dock.querySelector('#bType').addEventListener('submit', (e) => {
    e.preventDefault();
    const box = dock.querySelector('#bKeys');
    if (!box.value) return act({ kind: 'key', text: 'enter' });
    act({ kind: 'type', text: box.value, enter: true });
    box.value = '';
  });

  // The picture is the page: a click on it is a click there, a wheel a scroll.
  const view = dock.querySelector('#bView');
  const spot = (e, img) => {
    const box = img.getBoundingClientRect();
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  };
  view.addEventListener('click', async (e) => {
    if (e.target.id === 'bStart') {
      say('starting Firefox…');
      try { await post('/api/browser/start', {}); say(''); } catch (ex) { say(ex.message); }
      return look(true);
    }
    const img = e.target.closest('img');
    if (img) act({ kind: 'click', ...spot(e, img) });
  });
  let wheel = 0; let wheelAt = null; let wheelTimer = null;
  view.addEventListener('wheel', (e) => {
    const img = e.target.closest('img');
    if (!img) return;
    e.preventDefault();
    wheel += e.deltaY;
    wheelAt = spot(e, img);
    clearTimeout(wheelTimer);
    // Gathered up: a wheel sends dozens of small turns, and each as its own request would arrive out of order.
    wheelTimer = setTimeout(() => { const dy = wheel; wheel = 0; act({ kind: 'scroll', dy, ...wheelAt }); }, 140);
  }, { passive: false });

  dock.querySelector('#bMore').addEventListener('toggle', () => look(true));

  return dock;
}

/** Look at the browser again: is it open, where is it, and what is it showing. */
async function look(now = false) {
  if (!dock?.classList.contains('open')) return;
  let b;
  try { b = await api('/api/browser'); } catch { return; }
  const view = dock.querySelector('#bView');
  const who = dock.querySelector('#bWho');
  for (const btn of dock.querySelectorAll('[data-act]')) btn.disabled = !b.running;
  dock.querySelector('#bKeys').disabled = !b.running;

  if (!b.running) {
    who.innerHTML = '<span class="lamp"></span><span>not open</span>';
    view.innerHTML = b.installed
      ? `<div class="hello"><h4>A browser you share with the agents</h4>
           A real Firefox window, on a profile of its own rather than your everyday one. Search or open a page here and the
           agents can read it; they search and you watch it happen — and click, scroll and type in it from this picture.
           <br><button id="bStart" class="primary">Open Firefox</button></div>`
      : `<div class="hello"><h4>Firefox is not on this computer</h4>
           The shared browser is a real Firefox window. Install it from mozilla.org and open this again; nothing else is needed.</div>`;
  } else {
    const at = await api('/api/browser/where').catch(() => null);
    const last = b.visits.at(-1);
    who.innerHTML = `<span class="lamp on"></span><b>${esc(at?.title || 'Firefox')}</b>
      ${last ? `<span style="margin-left:auto;white-space:nowrap">last moved by ${esc(last.by)}</span>` : ''}`;
    const box = dock.querySelector('#bGo');
    if (at && document.activeElement !== box) box.value = at.url === 'about:blank' ? '' : at.url;

    // The new picture replaces the old only once it has arrived, so the view does not blink between them.
    if (!view.querySelector('img')) view.innerHTML = '<img alt="what the browser is showing" draggable="false">';
    if (!shotBusy || now) {
      shotBusy = true;
      const next = new Image();
      next.onload = () => { const img = view.querySelector('img'); if (img) img.src = next.src; shotBusy = false; };
      next.onerror = () => { shotBusy = false; };
      next.src = `/api/browser/shot?t=${Date.now()}`;
    }
  }

  steer.browser?.update();
  if (dock.querySelector('#bMore').open) {
    const page = b.running ? await api('/api/browser/page').catch(() => null) : null;
    dock.querySelector('#bText').textContent = page ? (page.text ?? '').slice(0, 6000) || '(no readable text)' : '';
    dock.querySelector('#bVisits').innerHTML = [...b.visits].reverse().map((v) => `
      <div><b>${esc(v.by)}</b> ${v.query ? `searched “${esc(v.query)}”` : `opened ${esc(v.title || v.url)}`}
      <br><span style="color:var(--faint)">${esc(v.url)}</span></div>`).join('');
  }
}

export function openBrowser() {
  buildDock().classList.add('open');
  clearInterval(looking);
  look(true);
  // Looked at again often enough to watch an agent browse, while it is on the page.
  looking = setInterval(() => look(), 1500);
  dock.querySelector('#bGo').focus();
}

export function closeBrowser() {
  dock?.classList.remove('open');
  clearInterval(looking);
}

// ------------------------------------------------------------ the edge tabs

/**
 * Tabs on the right-hand edge of the page: the way in to the terminal, the
 * browser and the file explorer, from wherever you are. Each opens its small window,
 * and shows that it is open; pressing it again puts the window away.
 */
function mark() {
  const tabs = document.getElementById('edge-tabs');
  if (!tabs) return;
  const float = Boolean(root?.classList.contains('open'));
  tabs.querySelector('[data-tool="terminal"]').classList.toggle('on', float && shown === 'terminal');
  tabs.querySelector('[data-tool="browser"]').classList.toggle('on', Boolean(dock?.classList.contains('open')));
  tabs.querySelector('[data-tool="explorer"]').classList.toggle('on', Boolean(document.querySelector('#explorer.open')));
  tabs.querySelector('[data-tool="pc"]').classList.toggle('on', Boolean(document.querySelector('#pcwin.open')));
}

export function edgeTabs() {
  if (document.getElementById('edge-tabs')) return;
  style();
  const tabs = document.createElement('div');
  tabs.id = 'edge-tabs';
  tabs.innerHTML = `
    <button data-tool="pc" title="The Agents' PC: everything on the machine the agents work on">Agents' PC</button>
    <button data-tool="terminal" title="The terminal you share with the agents (Ctrl \`)">Terminal</button>
    <button data-tool="browser" title="The browser you share with the agents">Browser</button>
    <button data-tool="explorer" title="The files on the Agents' PC, changing as the agents work">Explorer</button>`;
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (b) toggleTools(b.dataset.tool);
  });
  document.body.append(tabs);
  // Windows open and close from other places too — the rail, a shortcut, their own ×.
  new MutationObserver(mark).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
}
