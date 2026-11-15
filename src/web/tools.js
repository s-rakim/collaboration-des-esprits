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
#tools{position:fixed;right:52px;bottom:24px;width:760px;height:460px;z-index:60;display:none;flex-direction:column;
  min-width:380px;min-height:230px;
  background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:hidden;resize:both;
  box-shadow:0 24px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03)}
.popout{flex:none;background:none!important;border:0!important;color:var(--faint);font-size:13px!important;line-height:1;padding:3px 7px!important;border-radius:6px;cursor:pointer;margin-left:auto}
.popout:hover{color:var(--text);background:color-mix(in srgb,var(--text) 10%,transparent)!important}
.popout + .x{margin-left:0!important}
#tools .tbar.wt .popout{margin:0 0 4px 0}
/* A window of its own: the tool is the whole page. */
body.solo{margin:0;overflow:hidden}
body.solo #tools,body.solo #dock,body.solo .fwin{inset:0!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;
  min-width:0;min-height:0;border:0!important;border-radius:0!important;resize:none;box-shadow:none!important;animation:none!important}
body.solo .tbar,body.solo #dock .nav{cursor:default!important}
#tools.open{display:flex;animation:tools-in .16s cubic-bezier(.2,.7,.3,1)}
#tools.moving{user-select:none;transition:none;opacity:.96}
@keyframes tools-in{from{opacity:0;transform:translateY(10px) scale(.985)}}
#tools .tbar{display:flex;align-items:center;gap:4px;padding:6px 8px 6px 10px;border-bottom:1px solid var(--line);background:var(--panel);cursor:move;touch-action:none}
#tools .tbar .ttl{font-size:12.5px;color:var(--faint);margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
@media (max-width:700px){#tools{left:8px!important;right:8px!important;top:auto!important;bottom:8px!important;width:auto!important;height:60vh!important;resize:none}}

/* The browser: a second small window, moved and sized like the terminal. */
#dock{position:fixed;right:52px;top:72px;width:520px;height:400px;z-index:60;display:none;flex-direction:column;
  min-width:340px;min-height:260px;
  background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:hidden;resize:both;
  box-shadow:0 24px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.03)}
#dock.open{display:flex;animation:tools-in .16s cubic-bezier(.2,.7,.3,1)}
#dock.moving,#tools.moving{user-select:none;opacity:.96}
#tools.front,#dock.front{z-index:61}
@media (max-width:700px){#dock{left:8px!important;right:8px!important;top:8px!important;bottom:auto!important;width:auto!important;height:55vh!important;resize:none}}

/* The way in to both: tabs on the right-hand edge of every page. */
#edge-tabs{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:59;display:flex;flex-direction:column;gap:6px}
#edge-tabs button{writing-mode:vertical-rl;padding:14px 7px;font-size:13.5px;letter-spacing:.04em;color:var(--dim);
  background:var(--panel);border:1px solid var(--line);border-right:0;border-radius:9px 0 0 9px;cursor:pointer;
  transition:padding .12s ease,color .12s ease,background .12s ease}
#edge-tabs button:hover{padding-right:12px;color:var(--text);background:var(--panel2)}
#edge-tabs button.on{color:var(--bg);background:var(--text);border-color:var(--text)}
@media (max-width:700px){#edge-tabs button{padding:10px 5px;font-size:12.5px}}
#dock .nav{cursor:move;touch-action:none;display:flex;align-items:center;gap:5px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--panel)}
#dock .nav button{padding:4px 9px;font-size:14.5px;line-height:1.2;background:none;border-color:transparent;color:var(--dim)}
#dock .nav button:hover:not(:disabled){background:var(--panel2);border-color:var(--line);color:var(--text)}
#dock .nav form{flex:1;min-width:0;display:flex}
#dock .nav input{flex:1;min-width:0;border-radius:20px;padding:5px 13px;font-size:14px;background:var(--bg)}
#dock .who{display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:13px;color:var(--faint);border-bottom:1px solid var(--line);min-height:26px}
#dock .who b{color:var(--dim);font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dock .who .lamp{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
#dock .who .lamp.on{background:var(--good)}
#dock .err{color:var(--bad);font-size:13.5px;padding:5px 12px}
#dock .err:empty{display:none}
#dock .view{flex:1;min-height:0;overflow:auto;background:var(--panel);display:flex;align-items:flex-start;justify-content:center}
#dock .view img{width:100%;display:block;cursor:pointer;user-select:none;-webkit-user-drag:none}
#dock .view.busy img{opacity:.75}
#dock .hello{align-self:center;text-align:center;padding:30px;max-width:420px;color:var(--dim);font-size:15px;line-height:1.6}
#dock .hello h4{font-family:var(--sans);font-weight:650;letter-spacing:-.02em;font-size:20px;color:var(--text);margin:0 0 8px}
#dock .hello button{margin-top:14px}
#dock .type{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--line);background:var(--panel)}
#dock .type input{flex:1;font-size:14px}
#dock details{border-top:1px solid var(--line);font-size:13.5px;max-height:38vh;overflow:auto}
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
/* The terminal: tabs along the top, then a page that is only the prompt. */
#tools .tbar.wt{gap:2px;padding:6px 6px 0 8px;align-items:flex-end;border-bottom:0;background:color-mix(in srgb,var(--bg) 55%,#000)}
#tools .wtabs{display:flex;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:none;align-items:flex-end}
#tools .wtabs::-webkit-scrollbar{display:none}
#tools .wtab{display:flex;align-items:center;gap:8px;height:32px;padding:0 6px 0 12px;border-radius:8px 8px 0 0;font-size:13px;color:var(--dim);
  cursor:pointer;white-space:nowrap;max-width:190px;min-width:0;flex:0 1 auto;transition:background .1s ease,color .1s ease}
#tools .wtab:hover{background:color-mix(in srgb,var(--text) 7%,transparent);color:var(--text)}
#tools .wtab.on{background:var(--term-bg);color:var(--text)}
#tools .wtab i{font-style:normal;font-size:12px;width:14px;text-align:center;flex:none;opacity:.85}
#tools .wtab span{overflow:hidden;text-overflow:ellipsis}
#tools .wtab u{text-decoration:none;width:20px;height:20px;border-radius:5px;display:grid;place-items:center;color:var(--faint);font-size:15px;flex:none}
#tools .wtab u:hover{background:color-mix(in srgb,var(--text) 14%,transparent);color:var(--text)}
#tools .wadd{flex:none;width:30px;height:28px;margin-bottom:3px;padding:0;background:none;border:0;border-radius:6px;color:var(--dim);font-size:16px;line-height:1;cursor:pointer}
#tools .wadd:hover{background:color-mix(in srgb,var(--text) 10%,transparent);color:var(--text)}
#tools .tbar.wt .ttl{flex:1;align-self:stretch}
#tools .tbar.wt button.tab{margin-bottom:4px;font-size:12.5px;padding:3px 10px}
#tools .tbar.wt .x{margin:0 0 4px 2px}
#tools{--term-bg:color-mix(in srgb,var(--bg) 88%,#000)}
#tools .wmenu{position:absolute;top:40px;left:8px;z-index:6;width:300px;max-height:calc(100% - 52px);overflow:auto;padding:6px;border-radius:11px;
  background:var(--glass-strong);backdrop-filter:blur(24px) saturate(1.5);-webkit-backdrop-filter:blur(24px) saturate(1.5);border:1px solid var(--line);box-shadow:0 20px 50px rgba(0,0,0,.5)}
#tools .wmenu[hidden]{display:none}
#tools .wmenu button{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;background:none;border:0;border-radius:7px;color:var(--dim);font-size:13.5px;text-align:left}
#tools .wmenu button:hover:not(:disabled){background:color-mix(in srgb,var(--text) 9%,transparent);color:var(--text)}
#tools .wmenu button i{font-style:normal;width:16px;text-align:center}
#tools .wmenu button small{margin-left:auto;color:var(--faint);font-size:11.5px}
#tools .wmenu .sep{height:1px;background:var(--line);margin:5px 2px}
#tools .wmenu .where{border:0;padding:6px 10px;flex-direction:column;align-items:flex-start}
#tools .pane[data-pane="terminal"]{background:var(--term-bg)}
#tools .term{flex:1;min-height:0;overflow:auto;padding:10px 14px 14px;font-family:var(--mono);font-size:13.5px;line-height:1.5;color:var(--text);cursor:text}
#tools .term .run{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
#tools .term .ps{white-space:pre-wrap;color:var(--text)}
#tools .term .ps .u{color:var(--good);font-weight:600} #tools .term .ps .d{color:var(--warn);font-weight:500}
#tools .term .ps .k{color:var(--good)} #tools .term .ps .m{color:var(--human);font-weight:500}
#tools .term .o{color:var(--dim)}
#tools .term .who{margin-left:10px;font-size:11.5px;color:var(--warn);font-family:var(--sans)}
#tools .term .st{color:var(--faint);font-size:12px} #tools .term .st.bad{color:var(--bad)}
#tools .term .st button{padding:0 8px;font-size:11.5px;font-family:var(--sans);margin-left:6px}
#tools .term .line{display:flex;align-items:flex-end;gap:0;margin:0}
#tools .term .line[hidden]{display:none}
#tools .term .line .ps{flex:none}
#tools .term .line input{flex:1;min-width:40px;border:0;outline:0;box-shadow:none;background:none;padding:0;border-radius:0;color:var(--text);
  font-family:var(--mono);font-size:13.5px;line-height:1.5;caret-color:var(--text)}
#tools .term .err{padding:0;font-family:var(--sans)}
#tools #tPick{max-width:520px;margin:8px auto;font-family:var(--sans);cursor:default}
#tools #tPick[hidden]{display:none}
#tools #tPick h4{margin:10px 0 4px;font-size:18px;font-weight:650;letter-spacing:-.01em}
#tools #tPick p{margin:0 0 12px;color:var(--dim);font-size:13.5px}
#tools #tPick button{display:flex;align-items:center;gap:13px;width:100%;margin-bottom:6px;padding:10px 13px;text-align:left;border-radius:10px;
  background:color-mix(in srgb,var(--text) 4%,transparent);border:1px solid var(--hair)}
#tools #tPick button:hover:not(:disabled){background:color-mix(in srgb,var(--text) 9%,transparent);border-color:var(--line)}
#tools #tPick button i{font-style:normal;font-size:17px;width:22px;text-align:center;flex:none}
#tools #tPick button b{display:block;font-size:14.5px;font-weight:600}
#tools #tPick button small{display:block;color:var(--faint);font-size:12.5px;line-height:1.4;margin-top:1px}
#tools #tPick button:disabled{opacity:.6}
#tools #tPick .re{margin-top:10px;font-size:12.5px;color:var(--faint)} #tools #tPick .re a{cursor:pointer;text-decoration:underline;color:var(--dim)}
#tools .tbar button.tab{background:none;border:1px solid transparent;color:var(--dim);padding:5px 12px;border-radius:7px;font:inherit;font-size:14.5px;cursor:pointer}
#tools .tbar button.tab.on{background:var(--panel2);border-color:var(--line);color:var(--text);font-weight:550}
#tools .tbar .x{margin-left:auto;background:none;border:0;color:var(--faint);font-size:18px;cursor:pointer;padding:2px 8px}
#tools .pane{flex:1;min-height:0;display:none;flex-direction:column}
#tools .pane.on{display:flex}
#tools .where{padding:8px 12px;font-size:13.5px;color:var(--dim);border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#tools .where code{color:var(--text);overflow-wrap:anywhere}
#tools .where button,#tools .where label{font-size:13px;white-space:nowrap}
#tools .scroll{flex:1;min-height:0;overflow:auto;padding:10px 12px}
#tools .trun{margin-bottom:12px}
#tools .trun .cmd{font-family:var(--mono);font-size:14px;color:var(--text);overflow-wrap:anywhere}
#tools .trun .cmd b{color:var(--faint);font-weight:400}
#tools .trun .who{font-size:12.5px;color:var(--faint);margin-left:6px}
#tools .trun .who.agent{color:var(--warn)}
#tools .trun pre{margin:4px 0 0;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
  font-family:var(--mono);font-size:13.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;color:var(--dim)}
#tools .trun .code{font-size:12.5px;color:var(--faint)}
#tools .trun .code.bad{color:var(--bad)}
#tools .in{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line);background:var(--panel)}
#tools .in input{flex:1;font-family:var(--mono);font-size:14.5px}
#tools .empty{color:var(--faint);font-size:14px;padding:14px 2px;line-height:1.55}
#tools .err{color:var(--bad);font-size:13.5px;padding:6px 12px}
#tools .page h4{margin:0 0 2px;font-size:15px}
#tools .page a{color:var(--dim);font-size:13px;overflow-wrap:anywhere}
#tools .page img{width:100%;border:1px solid var(--line);border-radius:8px;margin:10px 0;display:block}
#tools .page .text{font-size:14px;color:var(--dim);white-space:pre-wrap;line-height:1.5;max-height:240px;overflow:auto;
  border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--panel)}
#tools .visits{margin-top:14px;font-size:13.5px}
#tools .visits div{padding:4px 0;border-top:1px solid var(--line);color:var(--dim);overflow-wrap:anywhere}
#tools .visits b{color:var(--text);font-weight:550}
#tools .where select{width:auto;font-size:13.5px;padding:2px 6px}
#tools input[type=checkbox]{width:auto;margin:0 4px 0 0;vertical-align:-2px}
#tools .where label{display:inline-flex;align-items:center}
#tools .where .state{font-size:12px;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--line);border-radius:20px;padding:1px 8px;color:var(--good);border-color:var(--good)}
#tools .where .state.off{color:var(--bad);border-color:var(--bad)}
#tools .where .state.wait{color:var(--warn);border-color:var(--warn)}
#tools .warn{padding:10px 12px;font-size:14px;line-height:1.55;color:var(--dim);border-bottom:1px solid var(--line)}
#tools .warn b{color:var(--text)}
#tools .warn .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
#tools .warn a{color:var(--faint);font-size:13px;cursor:pointer;text-decoration:underline}
#tools .file{display:flex;gap:8px;align-items:baseline;padding:4px 2px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:13.5px;cursor:pointer;color:var(--dim)}
#tools .file:hover{color:var(--text)}
#tools .file.heavy,#tools .file.link{cursor:default;color:var(--faint)}
#tools .file span{margin-left:auto;color:var(--faint);font-size:12.5px;white-space:nowrap}
#tools .view{margin:8px 0 12px;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
  font-family:var(--mono);font-size:13.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;color:var(--text)}
#tools .out{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 12px;border-top:1px solid var(--line);background:var(--panel)}
#tools .out .say{font-size:13.5px;color:var(--dim);flex-basis:100%;overflow-wrap:anywhere}
#tools .out .say.err{color:var(--bad)} #tools .out .say.ok{color:var(--good)}
`;

let root = null;
let timer = null;
let shown = 'terminal';
const steer = { terminal: null, browser: null };

let styled = false;
export const style = () => { if (!styled) { styled = true; document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`); } };

function build() {
  if (root) return root;
  style();
  root = document.createElement('div');
  root.id = 'tools';
  root.innerHTML = `
    <div class="tbar wt">
      <div class="wtabs" id="wTabs" data-tab="terminal"></div>
      <button class="wadd" id="wAdd" title="New tab">+</button>
      <button class="wadd" id="wMore" title="Open a shell, and the PC's settings">⌄</button>
      <span class="ttl" id="tTitle"></span>
      <button class="tab" data-tab="files" title="Take the work off the PC">Export</button>
      <button class="x" title="Close (Ctrl \`)">×</button>
    </div>
    <div class="wmenu" id="wMenu" hidden>
      <div id="wShells"></div>
      <div class="sep"></div>
      <div class="where" id="tWhere"></div>
      <div class="sep"></div>
      <button data-menu="permissions">Permissions — websites, GitHub, programs…</button>
      <button data-menu="clear">Clear this tab</button>
    </div>
    <div class="pane" data-pane="files">
      <div class="where" id="fWhere"></div>
      <div class="scroll" id="fList"></div>
      <div class="out">
        <a class="primary" id="fZip" style="text-decoration:none;padding:6px 12px;border-radius:7px;border:1px solid var(--line);font-size:14.5px" download>Save the project as a zip</a>
        <button id="fCopy">Copy to a folder on this computer…</button>
        <button id="fEmpty" title="Delete everything in this folder of the PC">Empty the PC…</button>
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
          <button id="fOpen" title="Open this folder in your code editor">Open in editor</button>
          <select id="fEditor" style="width:auto;font-size:13.5px;padding:5px 6px" title="Which editor"></select>
        </span>
        <div class="say" id="fSay"></div>
      </div>
    </div>
    <div class="pane" data-pane="terminal">
      <div class="warn" id="tWarn" hidden></div>
      <div class="term" id="tTerm">
        <div id="tPick" hidden></div>
        <div id="tOut"></div>
        <form class="line" id="tForm"><span class="ps" id="tPs"></span><input id="tCmd" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="command"></form>
        <div class="err" id="tErr"></div>
      </div>
      <div id="tSteer"></div>
    </div>`;
  document.body.append(root);

  root.querySelector('.x').addEventListener('click', close);
  for (const b of root.querySelectorAll('button[data-tab]')) b.addEventListener('click', () => show(shown === b.dataset.tab ? 'terminal' : b.dataset.tab));
  floating(root);

  // ---------------------------------------------------------------- terminal
  const term = root.querySelector('#tTerm');
  // Anywhere in the pane is the prompt: clicking the blank page puts the cursor on the line.
  term.addEventListener('click', (e) => {
    if (getSelection().toString() || e.target.closest('button, a, input, select')) return;
    root.querySelector('#tCmd').focus();
  });

  root.querySelector('#tForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const tab = active();
    const box = root.querySelector('#tCmd');
    const command = box.value.trim();
    if (!tab?.shell) return;
    box.value = '';
    root.querySelector('#tErr').textContent = '';
    if (!command) return;
    tab.typed = [...(tab.typed ?? []).filter((c) => c !== command), command].slice(-100);
    tab.at = tab.typed.length;
    if (/^(clear|cls|Clear-Host)$/i.test(command)) return clearTab(tab);
    // Shown at once, before the server has anything to say about it.
    tab.pending = [...(tab.pending ?? []), { command, cwd: tab.cwd ?? '', at: Date.now() }];
    saveTabs();
    paintTab(true);
    // Not waited for: a long command is watched as it runs, and can be stopped.
    api('/api/terminal/run', { method: 'POST', body: JSON.stringify({ command, as: me(), shell: tab.shell, cwd: tab.cwd ?? '' }) })
      .then((r) => {
        if (r?.id) claim(tab, r.id, command);
        if (r?.movedTo !== undefined) tab.cwd = r.movedTo;
      })
      .catch((ex) => {
        tab.pending = (tab.pending ?? []).filter((x) => x.command !== command);
        tab.failed = [...(tab.failed ?? []), { command, cwd: tab.cwd ?? '', why: ex.message }].slice(-20);
      })
      .finally(() => { saveTabs(); refreshTerminal(true); });
    setTimeout(() => refreshTerminal(true), 250);
  });

  // Up and down bring back what was typed in this tab, as a terminal does.
  root.querySelector('#tCmd').addEventListener('keydown', (e) => {
    const tab = active();
    if (!tab) return;
    if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); clearTab(tab); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const list = tab.typed ?? [];
    if (!list.length) return;
    e.preventDefault();
    tab.at = Math.max(0, Math.min(list.length, (tab.at ?? list.length) + (e.key === 'ArrowUp' ? -1 : 1)));
    e.target.value = list[tab.at] ?? '';
  });

  root.querySelector('#tOut').addEventListener('click', async (e) => {
    const stop = e.target.closest('[data-stop]');
    if (!stop) return;
    await post(`/api/terminal/${stop.dataset.stop}/stop`, {}).catch(() => {});
    refreshTerminal(true);
  });

  // The tabs: choose one, close one, add one.
  root.querySelector('#wTabs').addEventListener('click', (e) => {
    const shut = e.target.closest('[data-shut]');
    if (shut) { e.stopPropagation(); return closeTab(shut.dataset.shut); }
    const t = e.target.closest('[data-wtab]');
    if (t) { term$.active = t.dataset.wtab; saveTabs(); show('terminal'); }
    return undefined;
  });
  root.querySelector('#wAdd').addEventListener('click', () => { addTab(null); show('terminal'); });
  root.querySelector('#wMore').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = root.querySelector('#wMenu');
    menu.hidden = !menu.hidden;
    if (!menu.hidden) refreshTerminal(true);
  });
  document.addEventListener('click', (e) => {
    const menu = root.querySelector('#wMenu');
    if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
  });
  root.querySelector('#wMenu').addEventListener('click', (e) => {
    const shell = e.target.closest('[data-open-shell]');
    if (shell && !shell.disabled) { addTab(shell.dataset.openShell); root.querySelector('#wMenu').hidden = true; return show('terminal'); }
    const m = e.target.closest('[data-menu]')?.dataset.menu;
    if (m === 'permissions') { root.querySelector('#wMenu').hidden = true; return openTools('permissions'); }
    if (m === 'clear') { root.querySelector('#wMenu').hidden = true; const t = active(); if (t) clearTab(t); }
    return undefined;
  });
  // Choosing a shell for a new tab.
  root.querySelector('#tPick').addEventListener('click', async (e) => {
    if (e.target.closest('[data-recheck]')) { term$.shells = null; await loadShells(true); return paintTab(true); }
    const b = e.target.closest('[data-pick]');
    if (!b || b.disabled) return undefined;
    const tab = active();
    if (!tab) return undefined;
    await setShell(tab, b.dataset.pick);
    return show('terminal');
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

  root.querySelector('#fEmpty').addEventListener('click', async () => {
    const say = root.querySelector('#fSay');
    const sb = await api('/api/sandbox').catch(() => null);
    if (!sb) return;
    if (!confirm(`Empty ${sb.folder}?\n\nEverything in this folder of the Agents' PC is deleted. This cannot be undone — save it as a zip first if you might want it.`)) return;
    try {
      const r = await post('/api/sandbox/empty', { folder: sb.folder, as: me() });
      say.className = 'say ok'; say.textContent = `Emptied ${r.folder} — ${r.removed} thing${r.removed === 1 ? '' : 's'} removed`;
    } catch (ex) { say.className = 'say err'; say.textContent = ex.message; }
    refreshFiles();
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

// ------------------------------------------------------------ terminal tabs

/**
 * The terminal's tabs. Each is its own command line: a shell, the folder it
 * is standing in, and the commands typed into it. Any number, of any kind.
 * They are remembered, so the window reopens the way it was left.
 */
const term$ = { tabs: [], active: null, shells: null, sb: null, runs: new Map(), sig: '' };

const GLYPH = { pc: '▣', ubuntu: '◉', kali: '◈', mac: '⌘', gitbash: '◆', powershell: '≥', cmd: '▸' };
const SHELL_NAME = { pc: "Agents' PC", ubuntu: 'Ubuntu', kali: 'Kali Linux', mac: 'zsh', gitbash: 'Git Bash', powershell: 'PowerShell', cmd: 'Command Prompt' };

function saveTabs() {
  keep('esprits.term', {
    active: term$.active,
    tabs: term$.tabs.map((t) => ({ id: t.id, shell: t.shell, cwd: t.cwd ?? '', since: t.since ?? 0, ids: (t.ids ?? []).slice(-300), typed: (t.typed ?? []).slice(-50) })),
  });
}

function loadTabs() {
  if (term$.tabs.length) return;
  const was = kept('esprits.term');
  if (was?.tabs?.length) { term$.tabs = was.tabs; term$.active = was.active; }
  // Opening the terminal with nothing in it asks which shell you want.
  if (!term$.tabs.length) addTab(null);
  if (!term$.tabs.some((t) => t.id === term$.active)) term$.active = term$.tabs[0].id;
}

const active = () => term$.tabs.find((t) => t.id === term$.active) ?? null;

function addTab(shell) {
  const tab = { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, shell: null, cwd: '', since: 0, ids: [], typed: [] };
  term$.tabs.push(tab);
  term$.active = tab.id;
  if (shell) setShell(tab, shell);
  saveTabs();
  return tab;
}

/** Give a tab its shell. It starts as a blank page: nothing that ran before it opened is on it. */
async function setShell(tab, shell) {
  tab.shell = shell;
  tab.cwd = '';
  tab.ids = [];
  const t = await api('/api/terminal?limit=1').catch(() => null);
  tab.since = t?.runs?.at(-1)?.id ?? 0;
  saveTabs();
  refreshTerminal(true);
}

function closeTab(id) {
  const i = term$.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  term$.tabs.splice(i, 1);
  if (!term$.tabs.length) addTab(null);
  if (term$.active === id) term$.active = term$.tabs[Math.min(i, term$.tabs.length - 1)].id;
  saveTabs();
  show('terminal');
}

async function clearTab(tab) {
  const t = await api('/api/terminal?limit=1').catch(() => null);
  tab.since = t?.runs?.at(-1)?.id ?? tab.since;
  tab.ids = []; tab.pending = []; tab.failed = [];
  saveTabs();
  refreshTerminal(true);
}

/** This run was typed in that tab. */
function claim(tab, id, command) {
  if (!tab.ids.includes(id)) tab.ids.push(id);
  const i = (tab.pending ?? []).findIndex((x) => x.command === command);
  if (i >= 0) tab.pending.splice(i, 1);
}

async function loadShells(recheck = false) {
  if (term$.shells && !recheck) return term$.shells;
  const r = await api(`/api/terminal/shells${recheck ? '?recheck' : ''}`).catch(() => null);
  if (r) term$.shells = r.shells;
  return term$.shells ?? [];
}

const winPath = (p) => /^[a-z]:[\\/]/i.test(p) || p.includes('\\');
const last = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '/';

/**
 * The line a shell shows before the cursor — each in its own manner, since
 * that is how you know at a glance which one you are typing into.
 */
function prompt(shell, path) {
  const who = (me() || 'you').toLowerCase();
  const u = (t) => `<b class="u">${esc(t)}</b>`;
  const d = (t) => `<b class="d">${esc(t)}</b>`;
  switch (shell) {
    case 'ubuntu': return `${u(`${who}@ubuntu`)}:${d(path)}$ `;
    case 'kali': return `<span class="k">┌──(</span>${u(`${who}㉿kali`)}<span class="k">)-[</span>${d(path)}<span class="k">]</span>\n<span class="k">└─</span>${u('$')} `;
    case 'mac': return `${u(`${who}@Mac`)} ${d(last(path))} % `;
    case 'gitbash': return `${u(`${who}@PC`)} <b class="m">MINGW64</b> ${d(winPath(path) ? `/${path[0].toLowerCase()}${path.slice(2).replace(/\\/g, '/')}` : path)}\n$ `;
    case 'powershell': return `PS ${esc(winPath(path) ? path.replace(/\//g, '\\') : path)}&gt; `;
    case 'cmd': return `${esc(path.replace(/\//g, '\\'))}&gt;`;
    default: return `${u(`${who}@agents-pc`)}:${d(path)}$ `;
  }
}

/** Where a tab is standing, as its shell would name it. */
function standing(tab) {
  const sb = term$.sb;
  if (!sb) return '';
  const info = (term$.shells ?? []).find((x) => x.id === tab.shell);
  const base = info?.isolated ? `/sandbox/${sb.folder}` : sb.hostDir;
  if (!tab.cwd) return base;
  return winPath(base) ? `${base}\\${tab.cwd.replace(/\//g, '\\')}` : `${base}/${tab.cwd}`;
}

function paintTabs() {
  const strip = root.querySelector('#wTabs');
  strip.innerHTML = term$.tabs.map((t) => `<div class="wtab ${t.id === term$.active && shown === 'terminal' ? 'on' : ''}" data-wtab="${t.id}" title="${esc(t.shell ? SHELL_NAME[t.shell] ?? t.shell : 'Choose a shell')}">
      <i>${t.shell ? GLYPH[t.shell] ?? '▣' : '＋'}</i><span>${esc(t.shell ? SHELL_NAME[t.shell] ?? t.shell : 'New tab')}</span><u data-shut="${t.id}" title="Close tab">×</u></div>`).join('');
}

/** Draw the tab that is showing: the picker if it has no shell yet, otherwise its page. */
function paintTab(jump = false) {
  if (!root) return;
  paintTabs();
  const tab = active();
  const pick = root.querySelector('#tPick');
  const out = root.querySelector('#tOut');
  const form = root.querySelector('#tForm');
  if (!tab) return;

  if (!tab.shell) {
    out.innerHTML = ''; form.hidden = true; pick.hidden = false;
    root.querySelector('#tTitle').textContent = '';
    const shells = term$.shells;
    pick.innerHTML = `<h4>Which command line?</h4>
      <p>Each opens in its own tab, in the Agents' PC's folder. Open as many as you like — <b>+</b> adds another.</p>
      ${shells ? shells.map((sh) => `<button data-pick="${sh.id}" ${sh.available ? '' : 'disabled'}>
          <i>${GLYPH[sh.id] ?? '▣'}</i><span><b>${esc(sh.label)}</b><small>${esc(sh.available ? `${sh.hint} — runs in ${sh.how}${sh.isolated ? '' : ' (not sandboxed)'}` : sh.why)}</small></span></button>`).join('')
        : '<p>Looking at what this computer can run…</p>'}
      <p class="re"><a data-recheck>Check again</a> after installing something.</p>`;
    return;
  }
  pick.hidden = true; form.hidden = false;

  const mine = new Set(tab.ids ?? []);
  // The PC's own tab also shows what the agents run, since it is their machine; the others show only what was typed in them.
  const runs = [...term$.runs.values()].filter((r) => r.id > (tab.since ?? 0) && r.shell === tab.shell && (mine.has(r.id) || (tab.shell === 'pc' && r.kind !== 'human')))
    .sort((a, b) => a.id - b.id);
  const here = standing(tab);
  const sig = JSON.stringify([tab.id, here, runs.map((r) => [r.id, r.running, r.output?.length]), tab.pending, tab.failed]);
  const term = root.querySelector('#tTerm');
  const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 80;
  if (sig !== term$.sig) {
    term$.sig = sig;
    out.innerHTML = runs.map((r) => `<div class="run"><span class="ps">${prompt(tab.shell, r.cwd)}</span><span class="cmd">${esc(r.command)}</span>${r.kind !== 'human' ? `<span class="who">${esc(r.by)}${r.thread ? ` · thread ${r.thread}` : ''}</span>` : ''}${r.output ? `\n<span class="o">${esc(r.output.replace(/\s+$/, ''))}</span>` : ''}${r.running ? `\n<span class="st">running… <button data-stop="${r.id}">Stop</button></span>` : (r.exitCode ? `\n<span class="st bad">exit ${r.exitCode}${r.timedOut ? ' — stopped, it ran too long' : ''}</span>` : '')}</div>`).join('')
      + (tab.failed ?? []).map((f) => `<div class="run"><span class="ps">${prompt(tab.shell, here)}</span><span class="cmd">${esc(f.command)}</span>\n<span class="st bad">${esc(f.why)}</span></div>`).join('')
      + (tab.pending ?? []).map((x) => `<div class="run"><span class="ps">${prompt(tab.shell, here)}</span><span class="cmd">${esc(x.command)}</span></div>`).join('');
  }
  root.querySelector('#tPs').innerHTML = prompt(tab.shell, here);
  root.querySelector('#tTitle').textContent = '';
  if (jump || atBottom) term.scrollTop = term.scrollHeight;
}

async function refreshTerminal(all = false) {
  if (!root) return;
  loadTabs();
  const tab = active();
  const sinces = term$.tabs.filter((t) => t.shell).map((t) => t.since ?? 0);
  const since = sinces.length ? Math.min(...sinces) : 0;
  let t; let sb;
  try {
    [t, sb] = await Promise.all([
      api(`/api/terminal?limit=200&since=${since}`),
      api('/api/sandbox'), loadShells(),
    ]);
  } catch { return; }
  term$.sb = sb;
  term$.runs = new Map(t.runs.map((r) => [r.id, r]));
  // A command this tab sent that the server has started, but has not yet answered for: it is this tab's.
  for (const tb of term$.tabs) {
    for (const p of [...(tb.pending ?? [])]) {
      const hit = t.runs.find((r) => r.shell === tb.shell && r.command === p.command && r.kind === 'human' && r.id > (tb.since ?? 0)
        && !term$.tabs.some((x) => (x.ids ?? []).includes(r.id)));
      if (hit) claim(tb, hit.id, p.command);
      else if (Date.now() - p.at > 15_000) tb.pending = tb.pending.filter((x) => x !== p);
    }
  }

  const where = root.querySelector('#tWhere');
  // Rebuilding the line under somebody choosing from its menu closes the menu.
  if (!root.querySelector('#wMenu').hidden && !(where.contains(document.activeElement) && document.activeElement.tagName === 'SELECT')) {
    where.innerHTML = `${badge(sb)} ${folderPick(sb)}
      <label><input type="checkbox" id="tAgents" ${sb.agentsAllowed ? 'checked' : ''}> agents may use the terminal</label>`;
    root.querySelector('#wShells').innerHTML = (term$.shells ?? []).map((sh) => `<button data-open-shell="${sh.id}" ${sh.available ? '' : 'disabled'} title="${esc(sh.available ? `Runs in ${sh.how}` : sh.why)}">
      <i>${GLYPH[sh.id] ?? '▣'}</i>${esc(sh.label)}${sh.available ? '' : '<small>not available</small>'}</button>`).join('');
  }

  const warn = root.querySelector('#tWarn');
  const onPc = tab?.shell === 'pc';
  // The page is the prompt and nothing else. A banner is only for when a command cannot run at all;
  // how it runs is under the ⌄ menu.
  warn.hidden = !onPc || (sb.ready && !sb.preparing && !sb.error);
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
         <div style="margin-top:8px;color:var(--faint);font-size:13px">No Docker? Link the project folder you have open in your editor and the room works in it directly. <code>pc help</code> still works.</div>`;
  steer.terminal?.update();
  saveTabs();
  paintTab(all);
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
  root.querySelector('#fEmpty').disabled = !list.files.length || Boolean(sb.linked);
  root.querySelector('#fEmpty').title = sb.linked ? 'This is a folder of yours that you linked — it is not emptied from here' : 'Delete everything in this folder of the PC';
}

function show(tab) {
  shown = tab === 'files' ? 'files' : 'terminal';
  loadTabs();
  for (const b of root.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === shown);
  for (const p of root.querySelectorAll('[data-pane]')) p.classList.toggle('on', p.dataset.pane === shown);
  term$.sig = '';
  if (shown === 'terminal') { paintTab(true); refreshTerminal(true); if (active()?.shell) root.querySelector('#tCmd').focus(); }
  else { paintTabs(); refreshFiles(); }
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
    const w = g.w;
    const h = g.h;
    // Free to hang over any edge. Only enough of the bar is kept in reach to
    // get hold of it again; past that, it becomes a window of its own.
    const x = Math.max(120 - w, Math.min(g.x, innerWidth - 120));
    const y = Math.max(0, Math.min(g.y, innerHeight - 36));
    Object.assign(win.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto', width: `${w}px`, height: `${h}px` });
  };
  const was = kept(key);
  if (was && Number.isFinite(was.x)) place(was);

  const bar = win.querySelector(handle);
  if (SOLO) return;
  // The way out of the page: a real window, to put anywhere on the screen.
  if (!SOLO && !bar.querySelector('.popout')) {
    const pop = document.createElement('button');
    pop.className = 'popout';
    pop.type = 'button';
    pop.title = 'Pop out into its own window — to put anywhere on your screen, or another monitor';
    pop.textContent = '↗';
    const shut = bar.querySelector('.x, #bClose');
    if (shut) shut.before(pop); else bar.append(pop);
    pop.addEventListener('click', () => popOut(win));
  }
  // Whichever window was touched last is the one on top.
  win.addEventListener('pointerdown', () => {
    for (const w of document.querySelectorAll('#tools, #dock, .fwin')) w.classList.toggle('front', w === win);
  }, true);
  let from = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, select, a, label, [data-wtab]') || e.button !== 0) return;
    const box = win.getBoundingClientRect();
    from = { dx: e.clientX - box.left, dy: e.clientY - box.top, w: box.width, h: box.height };
    bar.setPointerCapture(e.pointerId);
    win.classList.add('moving');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!from) return;
    place({ x: e.clientX - from.dx, y: e.clientY - from.dy, w: from.w, h: from.h });
  });
  const drop = (e) => {
    if (!from) return;
    from = null;
    win.classList.remove('moving');
    // Let go of outside the page, it leaves the page: it opens as a window of its own, where it was dropped.
    if (!SOLO && e?.type === 'pointerup' && (e.clientX < 0 || e.clientY < 0 || e.clientX > innerWidth || e.clientY > innerHeight)) {
      const box = win.getBoundingClientRect();
      try { localStorage.removeItem(key); } catch { /* nothing kept */ }
      Object.assign(win.style, { left: '', top: '', right: '', bottom: '', width: '', height: '' });
      popOut(win, { x: e.screenX - 80, y: e.screenY - 14, w: box.width, h: box.height });
      return;
    }
    const box = win.getBoundingClientRect();
    keep(key, { x: box.left, y: box.top, w: box.width, h: box.height });
  };
  bar.addEventListener('pointerup', drop);
  bar.addEventListener('pointercancel', drop);
  // Double-click the bar to send it back to its corner.
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, select, a, label, [data-wtab]')) return;
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
/** A page that is one window and nothing else — what a popped-out window is. */
export const SOLO = new URLSearchParams(location.search).has('app') && /\/win(\.html)?$/.test(location.pathname);

/** Which of the PC's windows an element is. */
function appOf(win) {
  if (win.id === 'tools') return shown;
  if (win.id === 'dock') return 'browser';
  return win.id === 'pcwin' ? 'pc' : win.id;
}

/**
 * Open a window of the PC as a real window of its own.
 *
 * A page cannot draw outside the browser window it is in, so anything meant
 * to sit beside the browser, or on another screen, has to be a window of the
 * operating system's. This opens one showing just that tool, and puts the
 * in-page copy away.
 */
export function popOut(win, at = null, extra = {}) {
  const app = typeof win === 'string' ? win : appOf(win);
  const box = typeof win === 'string' ? null : win.getBoundingClientRect();
  const w = Math.round(at?.w ?? box?.width ?? 820);
  const h = Math.round(at?.h ?? box?.height ?? 540);
  const x = Math.round(at?.x ?? (window.screenX + (box?.left ?? 80) + 40));
  const y = Math.round(at?.y ?? (window.screenY + (box?.top ?? 80) + 60));
  const q = new URLSearchParams({ app, ...extra });
  const made = window.open(`/win?${q}`, `esprits-${app}-${Date.now()}`, `popup=yes,width=${w},height=${h},left=${x},top=${y}`);
  if (!made) { alert('The browser blocked the new window. Allow pop-ups for this page, then try again.'); return null; }
  if (typeof win !== 'string') {
    if (win.id === 'tools') close();
    else if (win.id === 'dock') closeBrowser();
    else win.querySelector('.x')?.click();
  }
  return made;
}

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

const SOLO_APP = SOLO ? new URLSearchParams(location.search).get('app') : null;

/** The windows that live in desk.js: the PC itself, the explorer, the editors, the activity monitor. */
const DESK = ['pc', 'explorer', 'code', 'notes', 'activity', 'permissions'];

export function openTools(tab = 'terminal') {
  // In a window of its own, another tool is another window.
  if (SOLO && tab !== SOLO_APP && !(SOLO_APP === 'terminal' && tab === 'files') && !(SOLO_APP === 'files' && tab === 'terminal')) return popOut(tab);
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
  if (SOLO) { window.close(); return; }
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
  if (SOLO) { window.close(); return; }
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
