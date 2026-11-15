/**
 * The Agents' PC, as windows: a file explorer, a code editor, a text editor
 * and an activity monitor.
 *
 * The PC is the machine the agents work on. These are the windows a person
 * looks into it through, and they are built around one fact: somebody else is
 * using the machine at the same time. So the explorer does not wait to be
 * refreshed — a file an agent makes appears in it marked new, one it rewrites
 * is marked changed, one it deletes fades out — and an open file follows the
 * disk for as long as you have not typed in it, so you can watch it being
 * written. When you have typed in it, nothing is taken from you: you are told
 * the file moved, and choose.
 *
 * They open from the tabs on the right-hand edge of any page, and from the
 * desktop at /pc, where they are the whole point.
 */

import { esc, me, api, post, floating, size, openTools, splitter, style as toolStyle } from '/tools.js';

const CSS = `
.fwin{position:fixed;z-index:60;display:none;flex-direction:column;min-width:340px;min-height:240px;
  max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);background:var(--bg);border:1px solid var(--line);
  border-radius:12px;overflow:hidden;resize:both;box-shadow:0 24px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03)}
.fwin.open{display:flex;animation:tools-in .16s cubic-bezier(.2,.7,.3,1)}
.fwin.moving{user-select:none;opacity:.96}
.fwin.front{z-index:61}
.fwin .tbar{display:flex;align-items:center;gap:8px;padding:7px 8px 7px 12px;border-bottom:1px solid var(--line);background:var(--panel);cursor:move;touch-action:none;flex:none}
.fwin .tbar .name{font-size:14px;font-weight:600;color:var(--text);white-space:nowrap}
.fwin .tbar .ttl{font-size:12.5px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;flex:1;min-width:0}
.fwin .tbar .x{margin-left:auto;background:none;border:0;color:var(--faint);font-size:18px;cursor:pointer;padding:0 8px;line-height:1}
.fwin .tbar .x:hover{color:var(--text)}
.fwin button{font-size:13.5px}
.fwin .bar2{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--line);flex:none;flex-wrap:wrap}
.fwin .bar2 button{padding:4px 9px;background:none;border-color:transparent;color:var(--dim)}
.fwin .bar2 button:hover:not(:disabled){background:var(--panel2);border-color:var(--line);color:var(--text)}
.fwin .bar2 button:disabled{opacity:.35}
.fwin .bar2 select{width:auto;font-size:13.5px;padding:3px 6px}
.fwin .foot{display:flex;align-items:center;gap:10px;padding:5px 12px;border-top:1px solid var(--line);background:var(--panel);font-size:12.5px;color:var(--faint);flex:none;min-height:26px}
.fwin .foot .say{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fwin .foot .say.err{color:var(--bad)} .fwin .foot .say.ok{color:var(--good)}
.fwin .live{display:inline-flex;align-items:center;gap:5px}
.fwin .live i{width:6px;height:6px;border-radius:50%;background:var(--good);animation:desk-pulse 1.6s ease-in-out infinite}
@keyframes desk-pulse{50%{opacity:.25}}
@media (max-width:700px){.fwin{left:8px!important;right:8px!important;top:8px!important;width:auto!important;height:70vh!important;resize:none}}

#explorer{left:calc(50% - 380px);top:90px;width:760px;height:480px}
#explorer .crumbs{display:flex;align-items:center;gap:2px;flex:1;min-width:120px;font-size:14px;overflow:hidden;white-space:nowrap}
#explorer .crumbs a{color:var(--dim);cursor:pointer;padding:2px 5px;border-radius:5px}
#explorer .crumbs a:hover{background:var(--panel2);color:var(--text)}
#explorer .crumbs a:last-child{color:var(--text);font-weight:550}
#explorer .crumbs span{color:var(--faint)}
#explorer .cols{flex:1;min-height:0;display:flex}
#explorer .tree{width:190px;flex:none;overflow:auto;padding:6px 4px;font-size:14px;background:var(--panel)}
#explorer .tree .d{display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:6px;cursor:pointer;color:var(--dim);white-space:nowrap}
#explorer .tree .d:hover{background:var(--panel2);color:var(--text)}
#explorer .tree .d.on{background:var(--panel2);color:var(--text);font-weight:550}
#explorer .tree .d .tw{width:12px;flex:none;text-align:center;color:var(--faint);font-size:9px}
#explorer .tree .d .dot{width:6px;height:6px;border-radius:50%;background:var(--warn);margin-left:auto;flex:none}
#explorer .main{flex:1;min-width:0;display:flex;flex-direction:column}
#explorer .list{flex:1;min-height:0;overflow:auto}
#explorer .row{display:grid;grid-template-columns:20px minmax(0,1fr) 78px 92px 74px;gap:8px;align-items:center;padding:5px 12px;font-size:14px;
  border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);cursor:default;color:var(--dim);user-select:none}
#explorer .row.head{position:sticky;top:0;background:var(--bg);font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);z-index:1;border-bottom:1px solid var(--line)}
#explorer .row:not(.head):hover{background:var(--panel)}
#explorer .row.sel{background:var(--panel2);color:var(--text)}
#explorer .row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
#explorer .row .r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
#explorer .row svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
#explorer .row.dir svg{color:var(--accent,#d9a441)}
#explorer .row.gone{opacity:.45}
#explorer .row.gone .nm{text-decoration:line-through}
#explorer .row.new{animation:desk-flash 1.4s ease-out}
#explorer .row.changed{animation:desk-flash 1.4s ease-out}
@keyframes desk-flash{from{background:color-mix(in srgb,var(--good) 28%,transparent)}}
#explorer .tag{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;border:1px solid;border-radius:20px;padding:0 7px;justify-self:end;white-space:nowrap}
#explorer .tag.new{color:var(--good)} #explorer .tag.changed{color:var(--warn)} #explorer .tag.gone{color:var(--bad)}
#explorer .empty{color:var(--faint);font-size:14px;padding:26px 18px;line-height:1.6;text-align:center}
#explorer .peek{flex:none;max-height:42%;display:flex;flex-direction:column;background:var(--panel)}
#explorer .peek .ph{display:flex;align-items:center;gap:6px;padding:5px 10px;font-size:13px;color:var(--dim);border-bottom:1px solid var(--line)}
#explorer .peek .ph b{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#explorer .peek .ph button{padding:2px 8px;font-size:12.5px;white-space:nowrap}
#explorer .peek .ph>span:nth-child(2){white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
#explorer .peek .ph b{flex:none;max-width:40%}
#explorer .peek>div:last-child,#explorer .peek pre{flex:1;min-height:0}
#explorer .peek pre{margin:0;padding:8px 12px;overflow:auto;font-family:var(--mono);font-size:13px;line-height:1.45;color:var(--dim);white-space:pre-wrap;overflow-wrap:anywhere}
#explorer .peek img{max-width:100%;max-height:220px;display:block;margin:8px auto}

.fwin.editor{width:720px;height:500px}
#code{left:calc(50% - 300px);top:70px} #notes{left:calc(50% - 240px);top:120px;width:560px;height:440px}
.editor .tabs{display:flex;gap:2px;padding:5px 8px 0;border-bottom:1px solid var(--line);background:var(--panel);overflow-x:auto;flex:none}
.editor .tabs .t{display:flex;align-items:center;gap:6px;padding:5px 6px 5px 11px;font-size:13.5px;color:var(--dim);border:1px solid transparent;border-bottom:0;
  border-radius:7px 7px 0 0;cursor:pointer;white-space:nowrap}
.editor .tabs .t.on{background:var(--bg);border-color:var(--line);color:var(--text);margin-bottom:-1px}
.editor .tabs .t i{font-style:normal;color:var(--warn);width:8px}
.editor .tabs .t u{text-decoration:none;color:var(--faint);padding:0 4px;border-radius:4px}
.editor .tabs .t u:hover{background:var(--panel2);color:var(--text)}
.editor .moved{display:none;padding:6px 12px;font-size:13.5px;color:var(--text);background:color-mix(in srgb,var(--warn) 16%,transparent);border-bottom:1px solid var(--line);gap:8px;align-items:center}
.editor .moved.on{display:flex}
.editor .moved button{padding:2px 9px;font-size:13px}
.editor .pad{flex:1;min-height:0;display:flex;position:relative}
.editor .gut{flex:none;width:46px;overflow:hidden;background:var(--panel);border-right:1px solid var(--line);color:var(--faint);
  font-family:var(--mono);font-size:14px;line-height:1.5;text-align:right;padding:10px 8px 10px 0;white-space:pre;user-select:none}
.editor textarea{flex:1;min-width:0;border:0;border-radius:0;outline:0;resize:none;background:var(--bg);color:var(--text);
  font-family:var(--mono);font-size:14px;line-height:1.5;padding:10px 12px;white-space:pre;overflow:auto;tab-size:2}
.editor textarea:focus{box-shadow:none}
.editor.prose textarea{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--sans,inherit);font-size:15.5px;line-height:1.65;padding:18px 22px}
.editor.prose .gut{display:none}
.editor .none{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--faint);font-size:14.5px;text-align:center;padding:20px}

#activity{right:60px;top:80px;width:440px;height:520px}
#activity .scroll{flex:1;min-height:0;overflow:auto;padding:4px 0}
#activity h5{margin:12px 14px 6px;font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600}
#activity .kv{display:grid;grid-template-columns:86px minmax(0,1fr);gap:3px 10px;padding:0 14px;font-size:14px;color:var(--dim)}
#activity .kv b{color:var(--faint);font-weight:400}
#activity .kv span{color:var(--text);overflow-wrap:anywhere}
#activity .sw{display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:10px 14px 2px;font-size:14px;color:var(--dim)}
#activity .sw label{display:inline-flex;align-items:center;gap:5px}
#activity .sw input{width:auto;margin:0}
#activity .it{padding:8px 14px;border-top:1px solid var(--line);font-size:14px}
#activity .it .l1{display:flex;align-items:center;gap:8px}
#activity .it .l1 code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-family:var(--mono);font-size:13.5px}
#activity .it .l1 b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#activity .it .by{font-size:12.5px;color:var(--faint);white-space:nowrap}
#activity .it button{padding:2px 9px;font-size:13px}
#activity .none{padding:4px 14px 8px;font-size:14px;color:var(--faint)}

#pcwin{right:60px;top:64px;width:400px;height:520px}
#pcwin .bar2 .st{font-size:12px;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--good);border-radius:20px;padding:1px 9px;color:var(--good);white-space:nowrap}
#pcwin .bar2 .st.off{color:var(--bad);border-color:var(--bad)} #pcwin .bar2 .st.wait{color:var(--warn);border-color:var(--warn)}
#pcwin .bar2 code{font-size:13px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#pcwin .progs{flex:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:4px;padding:8px;overflow:auto;align-content:start}
#pcwin .progs button{display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 2px 6px;background:none;border:1px solid transparent;border-radius:9px;color:var(--text);font-size:13px}
#pcwin .progs button:hover{background:var(--panel);border-color:var(--line)}
#pcwin .progs i{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--panel);border:1px solid var(--line);color:var(--accent)}
#pcwin svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
#pcwin .sec{flex:1;min-height:0;overflow:auto;padding:0 0 6px}
#pcwin h6{margin:0;padding:8px 12px 5px;font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600;position:sticky;top:0;background:var(--bg);z-index:1}
#pcwin h6 span{text-transform:none;letter-spacing:0;font-weight:400}
#pcwin .pfiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1px 6px;padding:0 8px}
#pcwin .pfiles button{display:flex;align-items:center;gap:7px;padding:4px 6px;background:none;border:1px solid transparent;border-radius:6px;color:var(--dim);font-size:14px;text-align:left;min-width:0}
#pcwin .pfiles button:hover{background:var(--panel);color:var(--text)}
#pcwin .pfiles button i{flex:none;display:grid} #pcwin .pfiles button.dir i{color:var(--accent)}
#pcwin .pfiles button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pcwin .pfiles button.fresh{color:var(--text)} #pcwin .pfiles button.fresh::after{content:'';width:6px;height:6px;border-radius:50%;background:var(--good);margin-left:auto;flex:none}
#pcwin .none{padding:4px 12px 8px;font-size:14px;color:var(--faint);line-height:1.5}
#pcwin .rw{display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:14px}
#pcwin .rw code,#pcwin .rw b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
#pcwin .rw code{font-family:var(--mono);font-size:13.5px;color:var(--text)}
#pcwin .rw span{font-size:12.5px;color:var(--faint);white-space:nowrap} #pcwin .rw button{padding:1px 8px;font-size:12.5px} #pcwin .rw a{color:var(--dim);font-size:13px}

/* Saying something to an agent while it works — the same strip in every window. */
.steer{display:none;gap:6px;align-items:center;padding:7px 10px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--warn) 9%,var(--panel));flex:none}
.steer.on{display:flex}
.steer select{width:auto;max-width:42%;font-size:13.5px;padding:4px 6px}
.steer input{flex:1;min-width:0;font-size:14px}
.steer button{font-size:13.5px;white-space:nowrap}
.steer .heard{font-size:12.5px;color:var(--good);white-space:nowrap}
`;

let styled = false;
const style = () => { toolStyle(); if (!styled) { styled = true; document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`); } };

const ICON = {
  dir: '<svg viewBox="0 0 20 20"><path d="M2.5 6V15a1.5 1.5 0 0 0 1.5 1.5h12A1.5 1.5 0 0 0 17.5 15V7.5A1.5 1.5 0 0 0 16 6h-6L8.2 3.8H4A1.5 1.5 0 0 0 2.5 5.3z"/></svg>',
  file: '<svg viewBox="0 0 20 20"><path d="M5 2.5h6.5L15.5 6.5V16A1.5 1.5 0 0 1 14 17.5H5A1.5 1.5 0 0 1 3.5 16V4A1.5 1.5 0 0 1 5 2.5z"/><path d="M11.5 2.5V6.5h4"/></svg>',
};

const when = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
};

/** A window: a bar to move it by, a body, and a place it remembers. */
function makeWin({ id, name, cls = '' }) {
  style();
  const win = document.createElement('div');
  win.id = id;
  win.className = `fwin ${cls}`;
  win.dataset.app = id;
  win.innerHTML = `<div class="tbar"><b class="name">${esc(name)}</b><span class="ttl"></span><button class="x" title="Close">×</button></div>`;
  document.body.append(win);
  floating(win, { key: `esprits.win.${id}` });
  win.querySelector('.x').addEventListener('click', () => closeApp(id === 'pcwin' ? 'pc' : id));
  return win;
}

const front = (win) => {
  for (const w of document.querySelectorAll('#tools, #dock, .fwin')) w.classList.toggle('front', w === win);
};

// ------------------------------------------------------------------ steering

let runningCache = { at: 0, threads: [] };
async function runningThreads() {
  if (Date.now() - runningCache.at < 1200) return runningCache.threads;
  const r = await api('/api/threads/running').catch(() => null);
  runningCache = { at: Date.now(), threads: r?.threads ?? [] };
  return runningCache.threads;
}

/**
 * The strip that lets a person say something to a thread while it works.
 * Put at the foot of any window; it shows itself only while a thread is at
 * work, and what is typed reaches that thread at its next step.
 */
export function steerStrip(parent) {
  style();
  const form = document.createElement('form');
  form.className = 'steer';
  form.innerHTML = `<select title="Which thread"></select>
    <input placeholder="Tell it something — it hears it at its next step" autocomplete="off">
    <button class="primary">Steer</button><span class="heard"></span>`;
  parent.append(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = form.querySelector('input');
    const text = box.value.trim();
    const id = form.querySelector('select').value;
    if (!text || !id) return;
    const heard = form.querySelector('.heard');
    try {
      const r = await post(`/api/threads/${id}/note`, { text, as: me() });
      box.value = '';
      heard.style.color = '';
      heard.textContent = `heard ${r.heard}`;
    } catch (ex) { heard.style.color = 'var(--bad)'; heard.textContent = ex.message; }
    setTimeout(() => { heard.textContent = ''; }, 5000);
  });
  const update = async () => {
    const threads = await runningThreads();
    form.classList.toggle('on', threads.length > 0);
    const pick = form.querySelector('select');
    if (document.activeElement === pick) return;
    const sig = threads.map((t) => t.id).join();
    if (pick.dataset.sig === sig) return;
    const was = pick.value;
    pick.dataset.sig = sig;
    pick.innerHTML = threads.map((t) => `<option value="${t.id}">${esc(t.seat || 'thread')} — ${esc(t.title)}</option>`).join('');
    if (threads.some((t) => String(t.id) === was)) pick.value = was;
    pick.style.display = threads.length > 1 ? '' : 'none';
    if (threads.length === 1) form.querySelector('input').placeholder = `Tell ${threads[0].seat || 'the agent'} something while it works on “${threads[0].title}”`;
  };
  update();
  return { update };
}

// ------------------------------------------------------------------ explorer

const ex = {
  win: null, timer: null, folder: null, cwd: '', entries: [], known: null,
  tags: new Map(), ghosts: new Map(), sel: null, open: new Set(['']), sig: '', peek: null, steer: null,
};
const TAG_MS = 30_000;
const GHOST_MS = 8_000;

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const isProse = (p) => /\.(txt|md|markdown|rst|log)$/i.test(p) || !/\./.test(nameOf(p));

function buildExplorer() {
  if (ex.win) return ex.win;
  const win = makeWin({ id: 'explorer', name: 'Explorer' });
  win.insertAdjacentHTML('beforeend', `
    <div class="bar2">
      <button data-do="up" title="Up one folder">↑</button>
      <div class="crumbs" id="xCrumbs"></div>
      <select id="xFolder" title="Which of the PC's folders"></select>
      <button data-do="newfile" title="A new file here">+ File</button>
      <button data-do="newdir" title="A new folder here">+ Folder</button>
    </div>
    <div class="cols">
      <div class="tree" id="xTree"></div>
      <div class="split x" id="xSplitT" title="Drag to resize"></div>
      <div class="main">
        <div class="list" id="xList"></div>
        <div class="split y" id="xSplitP" title="Drag to resize" hidden></div>
        <div class="peek" id="xPeek" hidden></div>
      </div>
    </div>
    <div class="foot"><span class="live"><i></i>live</span><span id="xCount"></span>
      <button data-do="zip" style="padding:1px 8px;font-size:12.5px" title="Download this PC folder as a zip">Export zip</button>
      <span class="say" id="xSay"></span></div>`);
  ex.win = win;
  ex.steer = steerStrip(win);
  const tree = win.querySelector('#xTree');
  const pk = win.querySelector('#xPeek');
  splitter(win.querySelector('#xSplitT'), { axis: 'x', key: 'esprits.split.tree', min: 90, max: () => win.clientWidth - 220,
    size: () => tree.getBoundingClientRect().width, set: (v) => { tree.style.width = v === null ? '' : `${v}px`; } });
  splitter(win.querySelector('#xSplitP'), { axis: 'y', invert: true, key: 'esprits.split.peek', min: 60, max: () => win.clientHeight - 200,
    size: () => pk.getBoundingClientRect().height, set: (v) => { pk.style.height = v === null ? '' : `${v}px`; pk.style.maxHeight = v === null ? '' : 'none'; } });

  const say = (text, kind = '') => { const el = win.querySelector('#xSay'); el.className = `say ${kind}`; el.textContent = text ?? ''; };
  const change = async (path, body, done) => {
    try { await post(path, { ...body, folder: ex.folder, as: me() }); say(done, 'ok'); }
    catch (err) { say(err.message, 'err'); }
    refreshExplorer(true);
  };

  win.addEventListener('click', async (e) => {
    const crumb = e.target.closest('[data-go]');
    if (crumb) { ex.cwd = crumb.dataset.go; ex.sel = null; return refreshExplorer(true); }
    const twist = e.target.closest('[data-twist]');
    if (twist) {
      const p = twist.dataset.twist;
      if (ex.open.has(p)) ex.open.delete(p); else ex.open.add(p);
      return renderExplorer(true);
    }
    const dir = e.target.closest('[data-dir]');
    if (dir) { ex.cwd = dir.dataset.dir; ex.open.add(ex.cwd); ex.sel = null; return refreshExplorer(true); }
    const act = e.target.closest('[data-do]')?.dataset.do;
    if (act === 'up') { ex.cwd = parentOf(ex.cwd); ex.sel = null; return refreshExplorer(true); }
    if (act === 'newfile' || act === 'newdir') {
      const name = prompt(act === 'newfile' ? 'A name for the new file' : 'A name for the new folder', '');
      if (!name) return undefined;
      const path = ex.cwd ? `${ex.cwd}/${name}` : name;
      if (act === 'newdir') return change('/api/sandbox/mkdir', { path }, `made ${path}/`);
      await change('/api/sandbox/write', { path, text: '', expect: undefined }, `made ${path}`);
      return openApp(isProse(path) ? 'notes' : 'code', { path, folder: ex.folder });
    }
    if (act === 'zip') { location.href = `/api/sandbox/export.zip?folder=${encodeURIComponent(ex.folder)}`; return undefined; }
    if (act === 'open') return openApp('code', { path: ex.sel, folder: ex.folder });
    if (act === 'opentext') return openApp('notes', { path: ex.sel, folder: ex.folder });
    if (act === 'download') { location.href = `/api/sandbox/raw?folder=${encodeURIComponent(ex.folder)}&path=${encodeURIComponent(ex.sel)}`; return undefined; }
    if (act === 'rename') {
      const to = prompt('Rename or move to — a path inside this folder', ex.sel);
      if (!to || to === ex.sel) return undefined;
      const from = ex.sel; ex.sel = to;
      return change('/api/sandbox/move', { from, to }, `${from} → ${to}`);
    }
    if (act === 'delete') {
      if (!confirm(`Delete ${ex.sel}?\n\nIt is removed from the Agents' PC. This cannot be undone.`)) return undefined;
      const path = ex.sel; ex.sel = null;
      return change('/api/sandbox/remove', { path }, `deleted ${path}`);
    }
    const row = e.target.closest('[data-path]');
    if (row && !row.classList.contains('gone')) {
      // Marked in place: redrawing the list between the two clicks of a double-click would lose the second.
      ex.sel = row.dataset.path;
      for (const r of win.querySelectorAll('#xList .row')) r.classList.toggle('sel', r === row);
      ex.sig = sigOf();
      peek();
    }
    return undefined;
  });
  win.addEventListener('dblclick', (e) => {
    const row = e.target.closest('[data-path]');
    if (!row || row.classList.contains('gone')) return;
    const p = row.dataset.path;
    if (row.classList.contains('dir')) { ex.cwd = p; ex.open.add(p); ex.sel = null; refreshExplorer(true); } else if (row.dataset.kind === 'file') openApp(isProse(p) ? 'notes' : 'code', { path: p, folder: ex.folder });
  });
  win.querySelector('#xFolder').addEventListener('change', async (e) => {
    try { await post('/api/sandbox', { folder: e.target.value }); } catch (err) { say(err.message, 'err'); }
    ex.folder = null; ex.cwd = ''; ex.sel = null; ex.known = null; ex.tags.clear(); ex.ghosts.clear();
    refreshExplorer(true);
  });
  return win;
}

/** Show the chosen file under the list: its text, or the picture it is. */
async function peek() {
  const box = ex.win.querySelector('#xPeek');
  const entry = ex.entries.find((e) => e.path === ex.sel);
  if (!entry || entry.kind !== 'file') { box.hidden = true; ex.win.querySelector('#xSplitP').hidden = true; ex.peek = null; return; }
  // Looked at again only when the file itself has changed.
  if (ex.peek?.path === entry.path && ex.peek.mtime === entry.mtime && !box.hidden) return;
  ex.peek = { path: entry.path, mtime: entry.mtime };
  const q = `folder=${encodeURIComponent(ex.folder)}&path=${encodeURIComponent(entry.path)}`;
  const head = `<div class="ph"><b>${esc(nameOf(entry.path))}</b><span>${size(entry.size)} · changed ${when(entry.mtime)}</span>
    <span style="margin-left:auto;display:flex;gap:5px">
      <button data-do="open">Code</button><button data-do="opentext">Notes</button>
      <button data-do="rename">Rename</button><button data-do="download">Download</button><button data-do="delete">Delete</button></span></div>`;
  if (/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(entry.path)) {
    box.innerHTML = `${head}<div style="overflow:auto"><img alt="" src="/api/sandbox/raw?${q}&t=${entry.mtime}"></div>`;
  } else {
    const f = await api(`/api/sandbox/file?${q}`).catch((err) => ({ text: err.message }));
    if (ex.sel !== entry.path) return;
    box.innerHTML = `${head}<pre>${esc(f.binary ? 'Not text — download it to open it.' : (f.text ?? '').slice(0, 6000) + ((f.text ?? '').length > 6000 || f.clipped ? '\n…' : ''))}</pre>`;
  }
  box.hidden = false;
  ex.win.querySelector('#xSplitP').hidden = false;
}

async function refreshExplorer(force = false) {
  if (!ex.win?.classList.contains('open')) return;
  let t; let sb;
  try { [t, sb] = await Promise.all([api(`/api/sandbox/tree${ex.folder ? `?folder=${encodeURIComponent(ex.folder)}` : ''}`), api('/api/sandbox')]); }
  catch (err) {
    // The folder it was showing is gone — a link let go of, say. Fall back to the one in use.
    if (ex.folder) { ex.folder = null; ex.known = null; }
    return;
  }
  // Following the PC: when the folder in use changes, so does what is shown.
  if (ex.folder && ex.following !== sb.folder && ex.folder !== sb.folder) {
    ex.following = sb.folder; ex.folder = null; ex.known = null; ex.cwd = ''; ex.sel = null; ex.tags.clear(); ex.ghosts.clear();
    return refreshExplorer(true);
  }
  ex.following = sb.folder;
  ex.folder = t.folder;
  ex.hostDir = t.hostDir;
  ex.folders = sb.folders;
  ex.clipped = t.clipped;

  // What is different from the last look is what somebody just did.
  const now = new Map(t.entries.map((e) => [e.path, e]));
  if (ex.known) {
    const at = Date.now();
    for (const [path, e] of now) {
      const was = ex.known.get(path);
      if (!was) ex.tags.set(path, { kind: 'new', at });
      else if (e.kind === 'file' && (was.mtime !== e.mtime || was.size !== e.size)) {
        ex.tags.set(path, { kind: ex.tags.get(path)?.kind === 'new' ? 'new' : 'changed', at });
      }
      ex.ghosts.delete(path);
    }
    for (const [path, e] of ex.known) if (!now.has(path)) { ex.ghosts.set(path, { ...e, at }); ex.tags.delete(path); }
  }
  ex.known = now;
  ex.entries = t.entries;
  const at = Date.now();
  for (const [p, tag] of ex.tags) if (at - tag.at > TAG_MS) ex.tags.delete(p);
  for (const [p, g] of ex.ghosts) if (at - g.at > GHOST_MS) ex.ghosts.delete(p);
  // The folder being looked at was deleted from under us: step out of it.
  while (ex.cwd && !now.has(ex.cwd)) ex.cwd = parentOf(ex.cwd);
  if (ex.sel && !now.has(ex.sel)) ex.sel = null;
  renderExplorer(force);
  peek();
  ex.steer?.update();
}

const sigOf = () => JSON.stringify([ex.folder, ex.cwd, ex.sel, [...ex.open], ex.entries.map((e) => [e.path, e.mtime, e.size]),
  [...ex.tags].map(([p, t]) => [p, t.kind]), [...ex.ghosts.keys()], ex.folders]);

function renderExplorer(force = false) {
  const win = ex.win;
  const sig = sigOf();
  if (!force && sig === ex.sig) return;
  const flash = sig !== ex.sig;
  ex.sig = sig;

  win.querySelector('.ttl').textContent = ex.hostDir ?? '';
  const pick = win.querySelector('#xFolder');
  if (document.activeElement !== pick) {
    pick.innerHTML = (ex.folders ?? [ex.folder]).map((f) => `<option ${f === ex.folder ? 'selected' : ''}>${esc(f)}</option>`).join('');
  }
  const parts = ex.cwd ? ex.cwd.split('/') : [];
  win.querySelector('#xCrumbs').innerHTML = [`<a data-go="">${esc(ex.folder)}</a>`,
    ...parts.map((p, i) => `<span>›</span><a data-go="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`)].join('');
  win.querySelector('[data-do="up"]').disabled = !ex.cwd;

  // Folders with something new inside carry a dot, so a change deep down is seen from the top.
  const touched = new Set();
  for (const p of [...ex.tags.keys(), ...ex.ghosts.keys()]) for (let d = parentOf(p); ; d = parentOf(d)) { touched.add(d); if (!d) break; }
  const dirs = ex.entries.filter((e) => e.kind === 'dir' || e.kind === 'heavy');
  const kids = (parent) => dirs.filter((d) => parentOf(d.path) === parent);
  const branch = (parent, depth) => kids(parent).map((d) => {
    const has = d.kind === 'dir' && kids(d.path).length > 0;
    const open = ex.open.has(d.path);
    return `<div class="d ${ex.cwd === d.path ? 'on' : ''}" style="padding-left:${6 + depth * 13}px" ${d.kind === 'dir' ? `data-dir="${esc(d.path)}"` : ''}>
        <span class="tw" ${has ? `data-twist="${esc(d.path)}"` : ''}>${has ? (open ? '▾' : '▸') : ''}</span>${esc(nameOf(d.path))}
        ${touched.has(d.path) ? '<span class="dot" title="something changed in here"></span>' : ''}</div>${has && open ? branch(d.path, depth + 1) : ''}`;
  }).join('');
  win.querySelector('#xTree').innerHTML = `<div class="d ${ex.cwd === '' ? 'on' : ''}" data-dir=""><span class="tw">▾</span><b style="font-weight:600">${esc(ex.folder)}</b>
    ${touched.has('') && ex.cwd !== '' ? '<span class="dot"></span>' : ''}</div>${branch('', 1)}`;

  const here = [...ex.entries.filter((e) => parentOf(e.path) === ex.cwd),
    ...[...ex.ghosts].filter(([p]) => parentOf(p) === ex.cwd).map(([p, g]) => ({ ...g, path: p, gone: true }))];
  const list = win.querySelector('#xList');
  const top = list.scrollTop;
  list.innerHTML = `<div class="row head"><span></span><span>Name</span><span class="r">Size</span><span class="r">Changed</span><span></span></div>` + (here.length
    ? here.map((e) => {
      const dir = e.kind === 'dir' || e.kind === 'heavy';
      const tag = e.gone ? 'gone' : ex.tags.get(e.path)?.kind ?? (dir && touched.has(e.path) ? 'changed' : '');
      return `<div class="row ${dir ? 'dir' : ''} ${tag} ${ex.sel === e.path ? 'sel' : ''}" data-path="${esc(e.path)}" data-kind="${esc(e.kind)}"
          title="${e.kind === 'heavy' ? 'Dependencies — not listed' : dir ? 'Double-click to open' : 'Click to look, double-click to open'}">
        ${dir ? ICON.dir : ICON.file}<span class="nm">${esc(nameOf(e.path))}</span>
        <span class="r">${dir ? '' : size(e.size)}</span><span class="r">${e.mtime ? when(e.mtime) : ''}</span>
        ${tag ? `<span class="tag ${tag}">${tag === 'gone' ? 'deleted' : tag}</span>` : '<span></span>'}</div>`;
    }).join('') + (ex.clipped ? '<div class="empty">…and more than can be listed.</div>' : '')
    : `<div class="empty">${ex.cwd ? 'This folder is empty.' : `Nothing is on the Agents' PC in <b>${esc(ex.folder)}</b> yet.<br>What the agents make appears here as they make it.`}</div>`);
  list.scrollTop = top;
  if (!flash) for (const r of list.querySelectorAll('.row')) r.style.animation = 'none';
  const files = ex.entries.filter((e) => e.kind === 'file');
  const recent = [...ex.tags.values()].length + ex.ghosts.size;
  win.querySelector('#xCount').textContent = `${files.length} file${files.length === 1 ? '' : 's'}, ${size(files.reduce((n, f) => n + f.size, 0))}${recent ? ` · ${recent} change${recent === 1 ? '' : 's'} just now` : ''}`;
}

// ------------------------------------------------------------------- editors

/**
 * An editor window. Two are made from this: Code, with line numbers and a
 * fixed-width face, and Notes, which wraps and reads like a page. Both hold
 * several files in tabs and both follow the disk.
 */
function makeEditor({ id, name, prose }) {
  const ed = { win: null, docs: [], at: -1, timer: null, untitled: 0 };

  const cur = () => ed.docs[ed.at] ?? null;
  const dirty = (d) => d.text !== d.saved;
  const say = (text, kind = '') => { const el = ed.win.querySelector('.say'); el.className = `say ${kind}`; el.textContent = text ?? ''; };

  function build() {
    if (ed.win) return ed.win;
    const win = makeWin({ id, name, cls: `editor ${prose ? 'prose' : ''}` });
    win.insertAdjacentHTML('beforeend', `
      <div class="bar2">
        <button data-do="new" title="A new file">New</button>
        <button data-do="save" title="Save (Ctrl S)">Save</button>
        <button data-do="saveas" title="Save under another name">Save as…</button>
        ${prose ? '' : '<button data-do="run" title="Run this file on the Agents\' PC">▶ Run</button>'}
        <button data-do="reload" title="Read it from the disk again">Reload</button>
        <label style="margin-left:auto;font-size:13px;color:var(--dim);display:inline-flex;gap:5px;align-items:center" title="Wrap long lines">
          <input type="checkbox" data-wrap style="width:auto;margin:0" ${prose ? 'checked' : ''}> wrap</label>
      </div>
      <div class="tabs"></div>
      <div class="moved"><span></span><button data-do="take">Load theirs</button><button data-do="mine">Keep mine</button></div>
      <div class="pad"><div class="gut"></div><textarea spellcheck="${prose ? 'true' : 'false'}" autocomplete="off" autocapitalize="off"></textarea>
        <div class="none" hidden>Nothing is open.<br>Open a file from the Explorer, or start a new one.<button data-do="new" class="primary">New file</button></div></div>
      <div class="foot"><span class="live" title="An open file follows the disk until you type in it"><i></i>following</span><span class="pos"></span><span class="say"></span></div>`);
    ed.win = win;
    const area = win.querySelector('textarea');
    const gut = win.querySelector('.gut');

    area.addEventListener('input', () => { const d = cur(); if (!d) return; d.text = area.value; paint(); });
    area.addEventListener('scroll', () => { gut.scrollTop = area.scrollTop; });
    for (const ev of ['keyup', 'click', 'input']) area.addEventListener(ev, where);
    win.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    });
    area.addEventListener('keydown', (e) => {
      if (prose || e.ctrlKey || e.metaKey) return;
      const { selectionStart: a, selectionEnd: b, value } = area;
      if (e.key === 'Tab') {
        e.preventDefault();
        area.setRangeText('  ', a, b, 'end');
        area.dispatchEvent(new Event('input'));
      } else if (e.key === 'Enter') {
        // The new line starts where the last one did — one level in after an opening bracket.
        const line = value.slice(value.lastIndexOf('\n', a - 1) + 1, a);
        const indent = line.match(/^[ \t]*/)[0] + (/[{[(:]\s*$/.test(line) ? '  ' : '');
        if (!indent) return;
        e.preventDefault();
        area.setRangeText(`\n${indent}`, a, b, 'end');
        area.dispatchEvent(new Event('input'));
      }
    });
    win.querySelector('[data-wrap]').addEventListener('change', (e) => {
      area.style.whiteSpace = e.target.checked ? 'pre-wrap' : 'pre';
      area.style.overflowWrap = e.target.checked ? 'anywhere' : 'normal';
      gut.style.display = e.target.checked ? 'none' : '';
    });
    win.addEventListener('click', (e) => {
      const shut = e.target.closest('[data-shut]');
      if (shut) { e.stopPropagation(); return shutDoc(Number(shut.dataset.shut)); }
      const tab = e.target.closest('[data-tab]');
      if (tab) { ed.at = Number(tab.dataset.tab); return paint(true); }
      const act = e.target.closest('[data-do]')?.dataset.do;
      if (act === 'new') return fresh();
      if (act === 'save') return save();
      if (act === 'saveas') return save(true);
      if (act === 'reload') return reload(true);
      if (act === 'take') return reload(true);
      if (act === 'mine') { const d = cur(); if (d) { d.mtime = d.theirs ?? d.mtime; d.theirs = null; paint(); area.focus(); } return undefined; }
      if (act === 'run') return runIt();
      return undefined;
    });
    return win;
  }

  function where() {
    const d = cur();
    const area = ed.win.querySelector('textarea');
    const pos = ed.win.querySelector('.pos');
    if (!d) { pos.textContent = ''; return; }
    const before = area.value.slice(0, area.selectionStart);
    const line = before.split('\n').length;
    const col = before.length - before.lastIndexOf('\n');
    pos.textContent = prose
      ? `${(area.value.trim().match(/\S+/g) ?? []).length} words · ${area.value.length} characters`
      : `Ln ${line}, Col ${col} · ${area.value.split('\n').length} lines`;
  }

  function paint(swap = false) {
    const win = ed.win;
    const d = cur();
    const area = win.querySelector('textarea');
    win.querySelector('.tabs').innerHTML = ed.docs.map((x, i) => `<div class="t ${i === ed.at ? 'on' : ''}" data-tab="${i}" title="${esc(x.path ?? 'not saved yet')}">
      <i>${dirty(x) ? '●' : ''}</i>${esc(x.path ? nameOf(x.path) : x.title)}<u data-shut="${i}" title="Close">×</u></div>`).join('');
    win.querySelector('.none').hidden = Boolean(d);
    area.hidden = !d;
    win.querySelector('.gut').hidden = !d;
    win.querySelector('.ttl').textContent = d ? `${d.path ? `${d.folder}/${d.path}` : d.title}${dirty(d) ? ' — not saved' : ''}` : '';
    for (const b of win.querySelectorAll('.bar2 [data-do="save"], .bar2 [data-do="saveas"], .bar2 [data-do="run"], .bar2 [data-do="reload"]')) b.disabled = !d;
    if (d) {
      if (swap || area.value !== d.text) {
        const keep = swap ? [0, 0, 0] : [area.selectionStart, area.selectionEnd, area.scrollTop];
        area.value = d.text;
        if (!swap) { area.setSelectionRange(Math.min(keep[0], d.text.length), Math.min(keep[1], d.text.length)); area.scrollTop = keep[2]; }
      }
      const lines = d.text.split('\n').length;
      const gut = win.querySelector('.gut');
      if (gut.dataset.n !== String(lines)) { gut.dataset.n = lines; gut.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n'); }
      gut.scrollTop = area.scrollTop;
      const moved = win.querySelector('.moved');
      moved.classList.toggle('on', Boolean(d.theirs));
      moved.querySelector('span').textContent = d.gone ? `${d.path} was deleted on the PC. Saving puts it back.` : `${d.path} was changed on the PC while you were editing it.`;
      moved.querySelector('[data-do="take"]').hidden = Boolean(d.gone);
    }
    where();
  }

  function fresh() {
    ed.untitled += 1;
    ed.docs.push({ folder: null, path: null, title: `untitled-${ed.untitled}`, text: '', saved: '', mtime: null });
    ed.at = ed.docs.length - 1;
    paint(true);
    ed.win.querySelector('textarea').focus();
  }

  async function load({ path, folder }) {
    const had = ed.docs.findIndex((d) => d.path === path && d.folder === folder);
    if (had >= 0) { ed.at = had; return paint(true); }
    try {
      const f = await api(`/api/sandbox/file?folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`);
      if (f.binary) { say(`${path} is not text`, 'err'); return paint(); }
      if (f.clipped) { say(`${path} is too large to edit here`, 'err'); return paint(); }
      ed.docs.push({ folder, path, text: f.text, saved: f.text, mtime: f.mtime });
      ed.at = ed.docs.length - 1;
      say('');
    } catch (err) { say(err.message, 'err'); }
    return paint(true);
  }

  function shutDoc(i) {
    const d = ed.docs[i];
    if (!d) return;
    if (dirty(d) && !confirm(`Close ${d.path ?? d.title} without saving?`)) return;
    ed.docs.splice(i, 1);
    ed.at = Math.min(ed.at >= i ? ed.at - (ed.at > i || ed.at === ed.docs.length ? 1 : 0) : ed.at, ed.docs.length - 1);
    if (ed.at < 0 && ed.docs.length) ed.at = 0;
    paint(true);
  }

  async function save(as = false) {
    const d = cur();
    if (!d) return;
    let { path, folder } = d;
    if (!path || as) {
      const sb = await api('/api/sandbox').catch(() => null);
      folder = folder ?? sb?.folder;
      path = prompt(`Save in ${folder} as — a path inside the folder`, path ?? (prose ? 'notes.md' : 'main.js'));
      if (!path) return;
    }
    const send = (expect) => post('/api/sandbox/write', { folder, path, text: d.text, expect, as: me() });
    try {
      let w;
      try { w = await send(path === d.path && !d.theirs && !d.gone ? d.mtime ?? undefined : undefined); }
      catch (err) {
        if (err.code !== 'conflict') throw err;
        if (!confirm(`${path} was changed on the PC since you opened it.\n\nSave yours over it?`)) return;
        w = await send(undefined);
      }
      Object.assign(d, { folder, path, saved: d.text, mtime: w.mtime, theirs: null, gone: false });
      say(`saved ${path}`, 'ok');
    } catch (err) { say(err.message, 'err'); }
    paint();
  }

  /** Read the open file from the disk again. Asked for, it replaces what is there; otherwise it only follows. */
  async function reload(asked = false) {
    const d = cur();
    if (!d?.path) return;
    try {
      const f = await api(`/api/sandbox/file?folder=${encodeURIComponent(d.folder)}&path=${encodeURIComponent(d.path)}`);
      if (cur() !== d) return;
      d.gone = false;
      if (f.mtime === d.mtime && !asked) return;
      if (asked || !dirty(d)) {
        const follows = !asked && f.text !== d.text;
        Object.assign(d, { text: f.text, saved: f.text, mtime: f.mtime, theirs: null });
        if (follows) say(`${nameOf(d.path)} changed on the PC — showing the new text`, 'ok');
      } else if (f.text !== d.saved) d.theirs = f.mtime;
      else d.mtime = f.mtime;
      paint();
    } catch (err) {
      if (cur() !== d) return;
      if (/there is no file/.test(err.message) && !d.gone) { d.gone = true; d.theirs = Date.now(); paint(); }
    }
  }

  async function runIt() {
    const d = cur();
    if (!d) return;
    if (!d.path || dirty(d)) await save();
    if (!d.path || dirty(d)) return;
    const q = `'${d.path.replace(/'/g, `'\\''`)}'`;
    const how = /\.(mjs|cjs|js)$/.test(d.path) ? `node ${q}` : /\.py$/.test(d.path) ? `python3 ${q}` : /\.(sh|bash)$/.test(d.path) ? `sh ${q}`
      : /\.ts$/.test(d.path) ? `npx tsx ${q}` : null;
    if (!how) { say('it does not know how to run this kind of file — use the terminal', 'err'); return; }
    openTools('terminal');
    say(`running ${how}`);
    post('/api/terminal/run', { command: how, as: me() }).then((r) => say(`${how} — exit ${r.exitCode}`, r.exitCode ? 'err' : 'ok')).catch((err) => say(err.message, 'err'));
  }

  return {
    build,
    open(arg) {
      build();
      if (arg?.path) load(arg); else { if (arg?.fresh || !ed.docs.length) { if (arg?.fresh) fresh(); } paint(true); }
      clearInterval(ed.timer);
      ed.timer = setInterval(() => reload(), 1500);
    },
    close() { clearInterval(ed.timer); },
    get win() { return ed.win; },
  };
}

const editors = {
  code: makeEditor({ id: 'code', name: 'Code', prose: false }),
  notes: makeEditor({ id: 'notes', name: 'Notes', prose: true }),
};

// ------------------------------------------------------------------ activity

const act = { win: null, timer: null, sig: '' };

function buildActivity() {
  if (act.win) return act.win;
  const win = makeWin({ id: 'activity', name: 'Activity' });
  win.insertAdjacentHTML('beforeend', `<div class="scroll" id="aBody"></div><div class="foot"><span class="live"><i></i>live</span><span class="say" id="aSay"></span></div>`);
  act.win = win;
  const say = (text, kind = '') => { const el = win.querySelector('#aSay'); el.className = `say ${kind}`; el.textContent = text ?? ''; };
  const run = async (fn, done) => { try { await fn(); say(done, 'ok'); } catch (err) { say(err.message, 'err'); } refreshActivity(true); };
  win.addEventListener('click', (e) => {
    const stop = e.target.closest('[data-stop]');
    if (stop) return run(() => post(`/api/terminal/${stop.dataset.stop}/stop`, {}), 'stopped');
    const b = e.target.closest('[data-do]')?.dataset.do;
    if (b === 'restart') { say('restarting…'); return run(() => post('/api/sandbox/restart', {}), 'restarted'); }
    if (b === 'terminal') return openTools('terminal');
    if (b === 'browser') return openTools('browser');
    if (b === 'explorer') return openApp('explorer');
    return undefined;
  });
  win.addEventListener('change', (e) => {
    if (e.target.id === 'aNet') return run(() => post('/api/sandbox', { network: e.target.checked }), `network ${e.target.checked ? 'on' : 'off'}`);
    if (e.target.id === 'aAgents') return run(() => post('/api/workspace', { agentsAllowed: e.target.checked }), e.target.checked ? 'agents may use the terminal' : 'agents may not use the terminal');
    return undefined;
  });
  win.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-tell]');
    if (!form) return;
    e.preventDefault();
    const box = form.querySelector('input');
    if (!box.value.trim()) return;
    try { const r = await post(`/api/threads/${form.dataset.tell}/note`, { text: box.value.trim(), as: me() }); box.value = ''; say(`it will hear that ${r.heard}`, 'ok'); }
    catch (err) { say(err.message, 'err'); }
  });
  return win;
}

async function refreshActivity(force = false) {
  if (!act.win?.classList.contains('open')) return;
  const p = await api('/api/pc').catch(() => null);
  if (!p) return;
  const sig = JSON.stringify([p.isolated, p.linked, p.unconfined, p.preparing, p.error, p.folder, p.dir, p.network, p.agentsAllowed, p.ready,
    p.commands.map((c) => c.id), p.threads.map((t) => t.id)]);
  // Left alone while somebody is typing to a thread in it.
  const typing = act.win.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox';
  if ((!force && sig === act.sig) || (typing && !force)) return;
  act.sig = sig;
  const state = p.preparing ? 'getting ready' : p.isolated ? `sandboxed — a ${p.engine} container (${p.image})`
    : p.linked ? 'a linked folder — commands run on this computer' : p.unconfined ? 'not sandboxed — commands run on this computer' : `cannot run anything: ${p.why}`;
  act.win.querySelector('#aBody').innerHTML = `
    <h5>The machine</h5>
    <div class="kv"><b>State</b><span>${esc(state)}</span><b>Folder</b><span>${esc(p.folder)}</span>
      <b>Runs in</b><span>${esc(p.dir)}</span><b>On disk</b><span>${esc(p.hostDir)}</span>${p.error ? `<b>Error</b><span style="color:var(--bad)">${esc(p.error)}</span>` : ''}</div>
    <div class="sw">
      <label title="Whether commands can reach the internet"><input type="checkbox" id="aNet" ${p.network ? 'checked' : ''}> network</label>
      <label title="Whether agents may run commands"><input type="checkbox" id="aAgents" ${p.agentsAllowed ? 'checked' : ''}> agents may use the terminal</label>
      <button data-do="restart" ${p.isolated ? '' : 'disabled'} title="Start the container afresh; files are kept" style="margin-left:auto">Restart</button>
    </div>
    <h5>Running commands</h5>
    ${p.commands.length ? p.commands.map((c) => `<div class="it"><div class="l1"><code>${esc(c.command)}</code><span class="by">${esc(c.by)}${c.thread ? ` · thread ${c.thread}` : ''}</span>
        <button data-stop="${c.id}">Stop</button></div></div>`).join('') : '<div class="none">Nothing is running.</div>'}
    <h5>Threads at work</h5>
    ${p.threads.length ? p.threads.map((t) => `<div class="it"><div class="l1"><b>${esc(t.title)}</b><span class="by">${esc(t.seat ?? '')} · <a href="/threads?build=${t.build}" style="color:var(--dim)">${esc(t.buildTitle)}</a></span></div>
        <form class="steer on" data-tell="${t.id}" style="border:0;background:none;padding:6px 0 0"><input placeholder="Tell it something — it hears it at its next step" autocomplete="off"><button class="primary">Steer</button></form></div>`).join('')
      : '<div class="none">No thread is working. Hand an idea over on the Threads page and it appears here.</div>'}
    <h5>From the command line</h5>
    <div class="none">Everything here can be typed in the <a data-do="terminal" style="cursor:pointer;text-decoration:underline">Terminal</a>: <code>pc status</code>, <code>pc ps</code>, <code>pc stop all</code>,
      <code>pc network off</code>, <code>pc tell 3 use sqlite</code> — <code>pc help</code> lists them.</div>`;
}

// --------------------------------------------------------------- the PC window

/**
 * The Agents' PC as one small window: what it is, what is on it, what is
 * running, and the way in to each of its programs. It opens over the lobby or
 * a thread, so the machine the agents are working on is one tab away from the
 * conversation about the work.
 */
const pcw = { win: null, timer: null, sig: '', known: null, fresh: new Map(), steer: null };
const PROGRAMS = [
  ['explorer', 'Explorer', 'The files, changing as the agents work', ICON.dir],
  ['code', 'Code', 'A code editor', '<svg viewBox="0 0 20 20"><path d="M7 6l-4 4 4 4M13 6l4 4-4 4M11.5 4l-3 12"/></svg>'],
  ['notes', 'Notes', 'A text editor', '<svg viewBox="0 0 20 20"><path d="M5 2.5h10A1.5 1.5 0 0 1 16.5 4v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 16V4A1.5 1.5 0 0 1 5 2.5z"/><path d="M6.5 7h7M6.5 10h7M6.5 13h4"/></svg>'],
  ['terminal', 'Terminal', 'The command line you share with the agents', '<svg viewBox="0 0 20 20"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M6 8l2.5 2L6 12M10.5 12.5h3.5"/></svg>'],
  ['browser', 'Browser', 'The browser you share with the agents', '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2.4 2.2 2.4 12.8 0 15M10 2.5c-2.4 2.2-2.4 12.8 0 15"/></svg>'],
  ['activity', 'Activity', 'What is running, and the switches', '<svg viewBox="0 0 20 20"><path d="M2.5 10h3.5l2-5.5 3.5 11 2.2-5.5h3.8"/></svg>'],
  ['files', 'Export', 'Take the work off the PC', '<svg viewBox="0 0 20 20"><path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M3.5 14v1.5A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5V14"/></svg>'],
];

function buildPc() {
  if (pcw.win) return pcw.win;
  const win = makeWin({ id: 'pcwin', name: "Agents' PC" });
  win.insertAdjacentHTML('beforeend', `
    <div class="bar2" style="flex-wrap:nowrap"><span class="st" id="pState">checking</span><code id="pWhere"></code>
      <a href="/pc" title="The same PC, as a whole page" style="margin-left:auto;font-size:13px;color:var(--dim);white-space:nowrap">full screen ↗</a></div>
    <div class="progs" id="pProgs">${PROGRAMS.map(([id, name, hint, g]) => `<button data-prog="${id}" title="${esc(hint)}"><i>${g}</i>${name}</button>`).join('')}</div>
    <div class="split y" id="pSplitA" title="Drag to resize"></div>
    <div class="sec" id="pFilesSec"><h6>On the PC <span id="pCount"></span></h6><div class="pfiles" id="pFiles"></div></div>
    <div class="split y" id="pSplitB" title="Drag to resize"></div>
    <div class="sec" id="pRunSec" style="flex:none;height:120px"><h6>Running now</h6><div id="pRun"></div></div>`);
  pcw.win = win;
  pcw.steer = steerStrip(win);
  const progs = win.querySelector('#pProgs');
  const run = win.querySelector('#pRunSec');
  splitter(win.querySelector('#pSplitA'), { axis: 'y', key: 'esprits.split.pc.progs', min: 44, max: () => win.clientHeight - 200,
    size: () => progs.getBoundingClientRect().height, set: (v) => { progs.style.height = v === null ? '' : `${v}px`; } });
  splitter(win.querySelector('#pSplitB'), { axis: 'y', invert: true, key: 'esprits.split.pc.run', min: 40, max: () => win.clientHeight - 200,
    size: () => run.getBoundingClientRect().height, set: (v) => { run.style.height = `${v ?? 120}px`; } });
  win.addEventListener('click', async (e) => {
    const prog = e.target.closest('[data-prog]')?.dataset.prog;
    if (prog) return APPS[prog] ? openApp(prog, prog === 'code' || prog === 'notes' ? {} : undefined) : openTools(prog);
    const stop = e.target.closest('[data-stop]');
    if (stop) { await post(`/api/terminal/${stop.dataset.stop}/stop`, {}).catch(() => {}); return refreshPc(true); }
    const f = e.target.closest('[data-path]');
    if (!f) return undefined;
    if (f.dataset.dir) return openApp('explorer', { cwd: f.dataset.path });
    return openApp(isProse(f.dataset.path) ? 'notes' : 'code', { path: f.dataset.path, folder: pcw.known?.folder });
  });
  return win;
}

async function refreshPc(force = false) {
  if (!pcw.win?.classList.contains('open')) return;
  const [p, t] = await Promise.all([api('/api/pc').catch(() => null), api('/api/sandbox/tree').catch(() => null)]);
  if (!p || !t) return;
  const top = t.entries.filter((e) => !e.path.includes('/'));
  const now = new Map(top.map((e) => [e.path, e.mtime]));
  if (pcw.known?.folder === t.folder) for (const [path, m] of now) if (pcw.known.map.get(path) !== m) pcw.fresh.set(path, Date.now());
  pcw.known = { folder: t.folder, map: now };
  for (const [path, at] of pcw.fresh) if (Date.now() - at > TAG_MS || !now.has(path)) pcw.fresh.delete(path);
  pcw.steer?.update();
  const sig = JSON.stringify([p.isolated, p.linked, p.unconfined, p.preparing, p.folder, p.hostDir, top.map((e) => e.path), [...pcw.fresh.keys()],
    p.commands.map((c) => c.id), p.threads.map((x) => x.id)]);
  if (!force && sig === pcw.sig) return;
  pcw.sig = sig;
  const win = pcw.win;
  const st = win.querySelector('#pState');
  st.className = `st ${p.preparing ? 'wait' : p.isolated ? '' : p.linked ? 'wait' : 'off'}`;
  st.textContent = p.preparing ? 'getting ready' : p.isolated ? 'sandboxed' : p.linked ? 'linked folder' : p.unconfined ? 'not sandboxed' : 'cannot run yet';
  st.title = p.isolated ? `A ${p.engine} container that can see one folder and nothing else on this computer` : p.linked ? 'Commands run on this computer, in the folder you linked' : p.why || '';
  win.querySelector('#pWhere').textContent = `${p.folder} — ${p.hostDir}`;
  win.querySelector('.ttl').textContent = p.folder;
  win.querySelector('#pCount').textContent = `· ${t.entries.filter((e) => e.kind === 'file').length} files`;
  win.querySelector('#pFiles').innerHTML = top.length ? top.map((e) => {
    const dir = e.kind !== 'file' && e.kind !== 'link';
    return `<button class="${dir ? 'dir' : ''} ${pcw.fresh.has(e.path) ? 'fresh' : ''}" data-path="${esc(e.path)}" data-dir="${dir ? 1 : ''}" title="${esc(e.path)}${e.mtime ? ` — changed ${when(e.mtime)}` : ''}">
      <i>${dir ? ICON.dir : ICON.file}</i><span>${esc(e.path)}</span></button>`;
  }).join('') : `<div class="none">Nothing yet. What the agents make lands here as they make it.</div>`;
  win.querySelector('#pRun').innerHTML = (p.commands.length || p.threads.length)
    ? [...p.commands.map((c) => `<div class="rw"><code>${esc(c.command)}</code><span>${esc(c.by)}</span><button data-stop="${c.id}">Stop</button></div>`),
      ...p.threads.map((x) => `<div class="rw"><b>${esc(x.title)}</b><span>${esc(x.seat ?? '')}</span><a href="/threads?build=${x.build}&thread=${x.id}">open</a></div>`)].join('')
    : '<div class="none">Nothing is running. Agents reach this PC from the lobby and from every thread; what they run shows here.</div>';
}

// ------------------------------------------------------------------ the apps

/** Every window of the PC that this file makes, by name. */
const APPS = {
  pc: {
    name: "Agents' PC",
    open() { buildPc(); clearInterval(pcw.timer); pcw.timer = setInterval(refreshPc, 1500); setTimeout(() => refreshPc(true)); },
    close() { clearInterval(pcw.timer); },
    win: () => pcw.win,
  },
  explorer: {
    name: 'Explorer',
    open(arg) { buildExplorer(); if (arg?.cwd !== undefined) { ex.cwd = arg.cwd; ex.open.add(arg.cwd); ex.sel = null; } clearInterval(ex.timer); ex.timer = setInterval(refreshExplorer, 1200); setTimeout(() => refreshExplorer(true)); },
    close() { clearInterval(ex.timer); },
    win: () => ex.win,
  },
  code: { name: 'Code', open: (arg) => editors.code.open(arg), close: () => editors.code.close(), win: () => editors.code.win },
  notes: { name: 'Notes', open: (arg) => editors.notes.open(arg), close: () => editors.notes.close(), win: () => editors.notes.win },
  activity: {
    name: 'Activity',
    open() { buildActivity(); clearInterval(act.timer); act.timer = setInterval(refreshActivity, 1500); setTimeout(() => refreshActivity(true)); },
    close() { clearInterval(act.timer); },
    win: () => act.win,
  },
};

export const appNames = () => Object.keys(APPS);

export function openApp(name, arg) {
  const app = APPS[name];
  if (!app) return;
  app.open(arg);
  const win = app.win();
  win.classList.add('open');
  front(win);
}

export function closeApp(name) {
  const app = APPS[name];
  const win = app?.win();
  if (!win) return;
  win.classList.remove('open');
  app.close();
}

export const isOpen = (name) => Boolean(APPS[name]?.win()?.classList.contains('open'));

export function toggleApp(name, arg) {
  if (isOpen(name)) closeApp(name); else openApp(name, arg);
}
