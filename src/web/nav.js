/**
 * The shell: a rail down the left-hand side, shared by every page.
 *
 * Everything this room can do now lives in one column you can read top to
 * bottom, instead of a row of links competing with the page title for the top
 * of the screen. A horizontal bar has a budget of about six words before it
 * wraps; a rail does not, which is why every app that grows past six features
 * ends up with one.
 *
 * Two modes, because the halves want different things in front of you. Chat is
 * you and the models talking, with what that produces beside it. Work is jobs
 * handed over and run without you watching. Keeping both sets visible at once
 * made the list long and the distinction invisible, which is what the toggle at
 * the top is for.
 *
 * The rail builds itself around whatever the page already is: it wraps the
 * existing body in a column and sits beside it, so a page needs nothing but the
 * script tag. The only contract is an empty <nav id="nav"> somewhere, which is
 * removed — it is where the old bar used to be.
 */

/** Line icons, drawn rather than typed, so they sit on the text baseline. */
const ICON = {
  work: '<rect x="2.5" y="3.5" width="15" height="11" rx="2"/><path d="M7 17.5h6"/>',
  chat: '<path d="M17 11.5a2 2 0 0 1-2 2H8l-3.5 3v-3H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  plus: '<circle cx="10" cy="10" r="7.5"/><path d="M10 6.5v7M6.5 10h7"/>',
  room: '<path d="M7 3.5v13M3.5 7h13"/><rect x="3.5" y="3.5" width="13" height="13" rx="2"/>',
  dashboard: '<rect x="2.5" y="2.5" width="15" height="15" rx="2"/><path d="M8 2.5v15M8 9.5h9.5"/>',
  tasks: '<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h8"/>',
  artifacts: '<path d="M5 2.5h6l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M11 2.5v4h4"/>',
  design: '<path d="M14.5 3.5l2 2-9 9-3 1 1-3z"/><path d="M3.5 16.5h5"/>',
  plugins: '<circle cx="10" cy="10" r="3"/><path d="M10 2.5V7M10 13v4.5M2.5 10H7M13 10h4.5"/>',
  skills: '<path d="M4 4.5h9a2 2 0 0 1 2 2v9H6a2 2 0 0 0-2 2z"/><path d="M4 4.5v11"/><path d="M7.5 8h4"/>',
  scheduled: '<circle cx="10" cy="10.5" r="6.5"/><path d="M10 7v3.5l2.5 1.5"/><path d="M7 2.5h6"/>',
  swarm: '<circle cx="10" cy="5" r="2"/><circle cx="5" cy="14" r="2"/><circle cx="15" cy="14" r="2"/><path d="M10 7v3M8.5 11.5L6.5 13M11.5 11.5l2 1.5"/>',
  search: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/>',
  setup: '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/>',
  prefect: '<path d="M10 2.5l6 2.5v5c0 4-2.6 6.6-6 7.5-3.4-.9-6-3.5-6-7.5v-5z"/><path d="M7.5 10l2 2 3.5-4"/>',
  idea: '<path d="M7.5 15h5M8 17.5h4"/><path d="M10 2.5a5 5 0 0 1 3 9v1.5H7V11.5a5 5 0 0 1 3-9z"/>',
  collapse: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M8 3.5v13"/>',
  panelClose: '<path d="M12.5 5.5L8 10l4.5 4.5"/>',
  panelOpen: '<path d="M7.5 5.5L12 10l-4.5 4.5"/>',
};

const icon = (name) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

/**
 * What each mode puts in the rail, in the order it reads.
 *
 * `action` marks the one at the top that does something rather than going
 * somewhere; on the page that owns it, it opens the thing directly instead of
 * navigating to the page you are already on.
 */
const MODES = {
  work: {
    label: 'Work',
    icon: 'work',
    home: '/dashboard',
    action: { label: 'New task', icon: 'plus', key: 'new-task', href: '/work', owner: '/work' },
    links: [
      { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
      { href: '/work', label: 'Tasks', icon: 'tasks' },
      { href: '/work#swarm', label: 'Swarm', icon: 'swarm' },
      { href: '/plugins', label: 'Plugins', icon: 'plugins' },
      { href: '/plugins#skills', label: 'Skills', icon: 'skills' },
      { href: '/setup#scheduled', label: 'Scheduled', icon: 'scheduled' },
      { href: '/dashboard#prefect', label: 'Prefect', icon: 'prefect' },
      { href: '/setup', label: 'Connections', icon: 'setup' },
    ],
  },
  chat: {
    label: 'Chat',
    icon: 'chat',
    home: '/',
    action: { label: 'New idea', icon: 'plus', key: 'new-idea', href: '/', owner: '/' },
    links: [
      { href: '/', label: 'The room', icon: 'room' },
      { href: '/artifacts', label: 'Artifacts', icon: 'artifacts' },
      { href: '/design', label: 'Design', icon: 'design' },
      { href: '/plugins', label: 'Plugins', icon: 'plugins' },
      { href: '/plugins#skills', label: 'Skills', icon: 'skills' },
      { href: '/setup#scheduled', label: 'Scheduled', icon: 'scheduled' },
      { href: '/setup#customize', label: 'Customize', icon: 'setup' },
    ],
  },
};

/** Which mode a page belongs to, so arriving by link selects the right one. */
const PAGE_MODE = {
  '/': 'chat', '/index.html': 'chat',
  '/artifacts': 'chat', '/artifacts.html': 'chat',
  '/design': 'chat', '/design.html': 'chat',
  '/dashboard': 'work', '/dashboard.html': 'work',
  '/work': 'work', '/work.html': 'work',
  '/plugins': 'work', '/plugins.html': 'work',
};

const RAIL_WIDE = 232;
const RAIL_NARROW = 56;

const CSS = `
:root{--rail-w:${RAIL_WIDE}px}
body{display:flex;min-height:100vh}
#shell-page{flex:1;min-width:0;height:100vh;overflow:auto;display:flex;flex-direction:column}
#shell-page>main{flex:1}

#shell-rail{
  width:var(--rail-w);flex:none;height:100vh;position:sticky;top:0;z-index:40;
  background:var(--panel);border-right:1px solid var(--line);
  display:flex;flex-direction:column;gap:2px;padding:10px 9px 12px;overflow:hidden auto;
  transition:width .16s ease;
}
#shell-rail svg{width:17px;height:17px;flex:none}

#shell-rail .top{display:flex;align-items:center;gap:6px;padding:1px 3px 9px}
#shell-rail .fold{background:none;border:0;color:var(--faint);padding:5px;border-radius:7px;cursor:pointer;display:flex}
#shell-rail .fold:hover{color:var(--text);background:var(--panel2)}
#shell-rail .brand{font-size:12.5px;font-weight:600;color:var(--dim);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;letter-spacing:-.01em}

#shell-rail .seg{display:flex;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:2px;gap:2px;margin-bottom:9px}
#shell-rail .seg button{flex:1;background:none;border:0;color:var(--dim);font:inherit;font-size:12.5px;
  padding:6px 4px;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;min-width:0}
#shell-rail .seg button:hover{color:var(--text)}
#shell-rail .seg button.on{background:var(--panel);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.25)}

#shell-rail a.item,#shell-rail button.item{
  display:flex;align-items:center;gap:10px;width:100%;text-align:left;
  color:var(--dim);text-decoration:none;font-size:13px;font:inherit;font-size:13px;
  background:none;border:1px solid transparent;border-radius:8px;padding:7px 9px;cursor:pointer;
  white-space:nowrap;overflow:hidden;
}
#shell-rail a.item:hover,#shell-rail button.item:hover{background:var(--panel2);color:var(--text);border-color:transparent}
#shell-rail a.item.on{background:var(--panel2);border-color:var(--line);color:var(--text);font-weight:550}
#shell-rail .item .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
#shell-rail .item .kbd{font-size:10px;color:var(--faint);border:1px solid var(--line);border-radius:4px;
  padding:1px 4px;font-family:var(--mono,monospace)}
#shell-rail .action{margin-bottom:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text)}
#shell-rail .action:hover{border-color:var(--accent)}

#shell-rail .head.row{display:flex;align-items:center;justify-content:space-between;
  text-transform:none;letter-spacing:0;font-size:11.5px}
#shell-rail .head{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);
  padding:14px 10px 5px;white-space:nowrap;overflow:hidden}
#shell-rail .ideas{display:flex;flex-direction:column;gap:1px}
#shell-rail .ideas a{font-size:12.5px;padding:6px 9px 6px 10px;color:var(--dim)}
/* Filled when the thread wants you, a ring when it does not. Both are the same
   size, so the list stays a column rather than shifting as threads change. */
#shell-rail .thread .dot{width:7px;height:7px;border-radius:50%;flex:none;margin:0 5px;
  border:1.4px solid var(--faint);background:none;transition:background .15s,border-color .15s}
#shell-rail .thread .dot.live{background:var(--accent);border-color:var(--accent)}
#shell-rail .thread:hover .dot{border-color:var(--dim)}
#shell-rail .thread.on .dot{border-color:var(--text)}
#shell-rail .head.sub{padding:9px 10px 3px;letter-spacing:.06em;text-transform:none;font-size:11px;color:var(--faint)}
#shell-rail .none{font-size:12px;color:var(--faint);padding:4px 10px 2px;white-space:nowrap;overflow:hidden}
#shell-rail .foot{margin-top:auto;padding-top:10px;border-top:1px solid var(--line)}
#shell-rail .who{display:flex;align-items:center;gap:9px;padding:7px 9px;font-size:12.5px;color:var(--dim);
  white-space:nowrap;overflow:hidden}
#shell-rail .who .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#shell-rail .who .chip{color:var(--faint);padding:4px;border-radius:6px;display:flex;flex:none}
#shell-rail .who .chip:hover{color:var(--text);background:var(--panel2)}
#shell-rail .who i{width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;flex:none;
  display:flex;align-items:center;justify-content:center;font-size:11px;font-style:normal;font-weight:600}

/* Folded: icons only, with the label as a tooltip. */
body.rail-folded{--rail-w:${RAIL_NARROW}px}
body.rail-folded #shell-rail{padding:10px 7px 12px;align-items:center}
body.rail-folded #shell-rail .brand,
body.rail-folded #shell-rail .t,
body.rail-folded #shell-rail .kbd,
body.rail-folded #shell-rail .head,
body.rail-folded #shell-rail .none,
body.rail-folded #shell-rail .who span,
body.rail-folded #shell-rail .who .chip{display:none}
body.rail-folded #shell-rail .seg{flex-direction:column;width:100%}
body.rail-folded #shell-rail a.item,body.rail-folded #shell-rail button.item{justify-content:center;padding:8px 0}
body.rail-folded #shell-rail .ideas a{padding:6px 0}
body.rail-folded #shell-rail .who{justify-content:center;padding:7px 0}

/* A phone has no room for a permanent rail, so it slides over instead. */
/* The menu button lives outside the rail, so it needs its own sizing — and a
   tap target a thumb can actually hit. */
/* The button that puts a side panel away, pinned to its inner edge. */
.panel-toggle{position:absolute;top:10px;left:6px;z-index:3;display:flex;align-items:center;justify-content:center;
  width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:7px;cursor:pointer;
  background:none;color:var(--faint,#6b7488)}
.panel-toggle:hover{background:var(--panel2,#1e222b);border-color:var(--line,#2a2f3a);color:var(--text,#e6e8ee)}
.panel-toggle svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;
  stroke-linecap:round;stroke-linejoin:round}

/* A message shown inside a modal, where a page toast cannot reach. */
dialog .shell-msg{margin:0;flex:1;min-width:0;font-size:12.5px;color:var(--bad,#f7768e);text-align:left}
dialog .shell-msg[data-kind="ok"]{color:var(--good,#9ece6a)}
dialog .shell-msg[data-kind="info"]{color:var(--dim,#98a0b3)}
dialog .shell-msg:empty{display:none}

#rail-open{display:none;align-items:center;justify-content:center;background:none;border:0;
  color:var(--dim);width:38px;height:38px;padding:0;border-radius:9px;cursor:pointer;flex:none}
#rail-open svg{width:20px;height:20px}
#rail-open:hover{background:var(--panel2);color:var(--text)}
#rail-scrim{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:39}
@media (max-width:860px){
  #shell-rail{position:fixed;left:0;top:0;transform:translateX(-100%);transition:transform .18s ease;--rail-w:${RAIL_WIDE}px;width:${RAIL_WIDE}px}
  body.rail-folded #shell-rail{width:${RAIL_WIDE}px}
  body.rail-out #shell-rail{transform:none;box-shadow:0 0 40px rgba(0,0,0,.4)}
  body.rail-out #rail-scrim{display:block}
  #shell-page{height:auto;min-height:100vh}
  #rail-open{display:flex}
  #shell-rail .fold{display:none}
}
`;

const path = () => location.pathname;

function readMode() {
  const here = PAGE_MODE[path()] ?? PAGE_MODE[path().replace(/\.html$/, '')] ?? null;
  if (here) {
    try { localStorage.setItem('esprits.mode', here); } catch { /* private window */ }
    return here;
  }
  let saved = null;
  try { saved = localStorage.getItem('esprits.mode'); } catch { /* ignore */ }
  return MODES[saved] ? saved : 'chat';
}

const here = (href) => {
  const p = path();
  const base = href.split('#')[0];
  return p === base || p === `${base}.html` || (base === '/' && p === '/index.html');
};

/**
 * Build the shell once: wrap what the page already has, and put the rail
 * beside it. Done in script rather than in seven copies of the same markup,
 * so a page added later gets it for nothing.
 */
function mount() {
  if (document.getElementById('shell-rail')) return document.getElementById('shell-rail');

  const style = document.createElement('style');
  style.id = 'rail-css';
  style.textContent = CSS;
  document.head.append(style);

  const page = document.createElement('div');
  page.id = 'shell-page';
  // Everything already in the body becomes the page column, in order.
  while (document.body.firstChild) page.append(document.body.firstChild);

  const rail = document.createElement('aside');
  rail.id = 'shell-rail';
  const scrim = document.createElement('div');
  scrim.id = 'rail-scrim';

  document.body.append(rail, page, scrim);
  scrim.addEventListener('click', () => document.body.classList.remove('rail-out'));
  // On a phone the rail is an overlay, so following a link from it should also
  // put it away rather than leaving it covering what you just asked for.
  rail.addEventListener('click', (e) => {
    if (e.target.closest('a')) document.body.classList.remove('rail-out');
  });

  // The old horizontal bar's placeholder is where the button that opens the
  // rail on a phone goes; on a wide screen it is not shown at all.
  const slot = document.getElementById('nav');
  if (slot) {
    slot.replaceWith(Object.assign(document.createElement('button'), {
      id: 'rail-open',
      title: 'Menu',
      innerHTML: icon('collapse'),
      onclick: () => document.body.classList.toggle('rail-out'),
    }));
  }

  try {
    if (localStorage.getItem('esprits.rail') === 'folded') document.body.classList.add('rail-folded');
  } catch { /* ignore */ }

  return rail;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The threads, grouped the way the room files them: the lobby, then each
 * project with its ideas under it, then anything unfiled. A flat list of
 * fourteen titles is a list you stop reading.
 */
function threads(ideas) {
  // A dot rather than the same icon fourteen times. Repeating one glyph down a
  // list tells you nothing; a dot that is filled when a thread wants you and
  // hollow when it does not tells you where to look, in the space of a glyph.
  const line = (i) => `
    <a class="item thread" href="/?idea=${encodeURIComponent(i.slug)}" data-idea="${esc(i.slug)}"
       title="${esc(i.title)}${i.stage ? ` — ${esc(i.stage)}` : ''}${i.needsYou ? ' — waiting on you' : ''}">
      <span class="dot ${i.needsYou ? 'live' : ''}"></span><span class="t">${esc(i.title)}</span>
    </a>`;

  const byProject = new Map();
  const loose = [];
  for (const i of ideas) {
    if (!i.project) { loose.push(i); continue; }
    if (!byProject.has(i.project)) byProject.set(i.project, []);
    byProject.get(i.project).push(i);
  }

  let out = `<div class="head row">Recents</div><div class="ideas">
    <a class="item thread" href="/" data-idea="" title="The lobby — cross-cutting chat">
      <span class="dot"></span><span class="t">Lobby</span>
    </a>`;
  for (const [project, list] of byProject) {
    out += `<div class="head sub" title="${esc(project)}">${esc(project)}</div>${list.map(line).join('')}`;
  }
  if (loose.length) {
    if (byProject.size) out += '<div class="head sub">Unfiled</div>';
    out += loose.map(line).join('');
  }
  if (!ideas.length) out += '<div class="none">No ideas yet</div>';
  return `${out}</div>`;
}

function render(rail, mode, ideas, me) {
  const m = MODES[mode];
  const folded = document.body.classList.contains('rail-folded');

  const item = (l) => `
    <a class="item ${here(l.href) && !l.href.includes('#') ? 'on' : ''}" href="${l.href}" title="${esc(l.label)}">
      ${icon(l.icon)}<span class="t">${esc(l.label)}</span>
    </a>`;

  rail.innerHTML = `
    <div class="top">
      <button class="fold" title="${folded ? 'Widen the rail' : 'Narrow the rail'}">${icon('collapse')}</button>
      <span class="brand">Collaboration des Esprits</span>
    </div>

    <div class="seg">
      ${Object.entries(MODES).map(([id, x]) =>
        `<button data-mode="${id}" class="${mode === id ? 'on' : ''}" title="${esc(x.label)}">
           ${icon(x.icon)}<span class="t">${esc(x.label)}</span>
         </button>`).join('')}
    </div>

    <button class="item action" data-action="${m.action.key}" title="${esc(m.action.label)}">
      ${icon(m.action.icon)}<span class="t">${esc(m.action.label)}</span><span class="kbd">Ctrl K</span>
    </button>

    ${m.links.map(item).join('')}

    ${threads(ideas)}

    <div class="foot">
      <div class="who" title="${me ? esc(me) : 'not identified'}">
        <i>${me ? esc(me.slice(0, 1).toUpperCase()) : '—'}</i>
        <span class="t">${me ? esc(me) : 'not identified'}</span>
        <a class="chip" href="/dashboard" title="What the room has been doing">${icon('dashboard')}</a>
        <a class="chip" href="/setup" title="Setup">${icon('setup')}</a>
      </div>
    </div>`;

  for (const b of rail.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', () => {
      const next = b.dataset.mode;
      try { localStorage.setItem('esprits.mode', next); } catch { /* ignore */ }
      // Switching moves you to that half's home, rather than leaving you on a
      // page the new mode does not list.
      if (next !== mode) location.href = MODES[next].home;
    });
  }

  rail.querySelector('.fold').addEventListener('click', () => {
    const nowFolded = document.body.classList.toggle('rail-folded');
    try { localStorage.setItem('esprits.rail', nowFolded ? 'folded' : 'wide'); } catch { /* ignore */ }
    render(rail, mode, ideas, me);
  });

  rail.querySelector('[data-action]').addEventListener('click', (e) => {
    const { action } = e.currentTarget.dataset;
    // On the page that owns the action, do it. Anywhere else, go there first.
    if (here(m.action.owner)) {
      window.dispatchEvent(new CustomEvent('esprits:action', { detail: { action } }));
    } else {
      location.href = `${m.action.href}?do=${action}`;
    }
  });

  // An idea click on the chat page switches the thread rather than reloading.
  for (const a of rail.querySelectorAll('[data-idea]')) {
    a.addEventListener('click', (e) => {
      if (!here('/')) return;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('esprits:idea', { detail: { idea: a.dataset.idea } }));
      markIdea(a.dataset.idea);
      document.body.classList.remove('rail-out');
    });
  }
}

/**
 * Making the dialogs behave like dialogs.
 *
 * Two things were wrong with every modal in this app, and together they read as
 * "the app is broken" rather than as two small bugs.
 *
 * Enter did nothing. You type your handle, press Enter the way you do in every
 * other box you have ever typed a name into, and nothing happens — no error, no
 * join, no hint that the button is the only thing that works.
 *
 * And an error raised inside a modal was invisible. A <dialog> opened with
 * showModal() is painted in the browser's top layer, above everything on the
 * page including a toast — so the toast telling you what was wrong with what you
 * typed rendered *behind* the dialog you were looking at. You were told; you
 * just could not see it.
 *
 * Both are fixed here rather than in each page, because every page has dialogs
 * and every one of them had both bugs.
 */

/** The button a dialog means by "go": the primary one, else the last. */
function primaryButton(dialog) {
  return dialog.querySelector('button.primary')
    ?? [...dialog.querySelectorAll('button')].at(-1)
    ?? null;
}

/**
 * Put a message where the person is actually looking. Inside an open modal that
 * is the modal; with nothing open, the caller's own toast is right.
 * Returns whether it was handled here.
 */
export function dialogMessage(text, kind = 'err') {
  const dialog = document.querySelector('dialog[open]');
  if (!dialog) return false;

  let line = dialog.querySelector('.shell-msg');
  if (!line) {
    line = document.createElement('p');
    line.className = 'shell-msg';
    // Next to the buttons, where the eye already is when you press one.
    const row = primaryButton(dialog)?.parentElement;
    if (row) row.prepend(line); else dialog.append(line);
  }
  line.textContent = text ?? '';
  line.dataset.kind = kind;
  return true;
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.defaultPrevented) return;
  const dialog = e.target?.closest?.('dialog[open]');
  if (!dialog) return;
  // A textarea is somewhere you press Enter to get a new line, so it is left
  // alone; a one-line field is somewhere Enter means "done".
  const field = e.target;
  if (field.tagName === 'TEXTAREA' || field.isContentEditable) return;
  if (!['INPUT', 'SELECT'].includes(field.tagName)) return;
  if (field.type === 'checkbox' || field.type === 'radio') return;

  const go = primaryButton(dialog);
  if (!go || go.disabled) return;
  e.preventDefault();
  go.click();
});

/**
 * A side panel you can put away.
 *
 * The right-hand column is context — what needs you, what a run is doing — and
 * context is exactly the thing you want out of the way while you are reading or
 * typing, and back when you are not. Closed it becomes a strip holding its own
 * reopen button, rather than vanishing: a panel with no way back is a panel
 * people close once and never find again.
 *
 * The page owns the grid, because only the page knows what its columns are; the
 * class on <body> is the contract between them.
 */
export function collapsiblePanel({ el, name, title = 'panel' }) {
  const panel = typeof el === 'string' ? document.querySelector(el) : el;
  if (!panel || panel.querySelector('.panel-toggle')) return;

  const key = `esprits.panel.${name}`;
  const cls = `panel-${name}-closed`;

  let closed = false;
  try { closed = localStorage.getItem(key) === 'closed'; } catch { /* private window */ }
  document.body.classList.toggle(cls, closed);

  const button = document.createElement('button');
  button.className = 'panel-toggle';
  button.type = 'button';
  panel.prepend(button);

  // A page that redraws its panel with innerHTML throws this away with the rest
  // of it, and the panel loses the only way to open it again. Rather than
  // requiring every page to render into an inner element and remember why, the
  // button puts itself back.
  new MutationObserver(() => {
    if (!button.isConnected) panel.prepend(button);
  }).observe(panel, { childList: true });

  const draw = () => {
    const shut = document.body.classList.contains(cls);
    button.setAttribute('aria-expanded', String(!shut));
    button.title = shut ? `Show the ${title}` : `Hide the ${title}`;
    button.innerHTML = icon(shut ? 'panelOpen' : 'panelClose');
  };

  button.addEventListener('click', () => {
    const shut = document.body.classList.toggle(cls);
    try { localStorage.setItem(key, shut ? 'closed' : 'open'); } catch { /* ignore */ }
    draw();
  });
  draw();
}

/** Show which thread is open, when the page changes it without navigating. */
export function markIdea(slug) {
  for (const a of document.querySelectorAll('#shell-rail [data-idea]')) {
    a.classList.toggle('on', a.dataset.idea === slug);
  }
}

/** Re-read the ideas, for a page that has just created one. */
export async function refreshNav() {
  const rail = document.getElementById('shell-rail');
  if (rail) await fill(rail);
}

async function fill(rail) {
  const mode = readMode();
  let me = null;
  try { me = localStorage.getItem('esprits.me'); } catch { /* ignore */ }

  let ideas = [];
  try {
    // An idea carries its project as a slug, and a slug is not what anybody
    // called it, so the names come along too.
    const [overview, projects] = await Promise.all([
      fetch('/api/overview', { headers: { 'content-type': 'application/json' } }),
      fetch('/api/projects', { headers: { 'content-type': 'application/json' } }),
    ]);
    const named = new Map();
    if (projects.ok) {
      for (const p of (await projects.json()).projects ?? []) named.set(p.slug, p.name);
    }
    if (overview.ok) {
      const o = await overview.json();
      const waiting = new Set((o.needsAttention ?? []).map((a) => a.idea));
      ideas = (o.ideas ?? []).map((i) => ({
        slug: i.slug, title: i.title, stage: i.stage,
        project: i.project ? (named.get(i.project) ?? i.project) : null,
        needsYou: waiting.has(i.slug),
      }));
    }
  } catch {
    // A rail that cannot reach the server is still a rail; it just has no
    // threads on it, and every link still works.
  }

  render(rail, mode, ideas, me);
  const open = new URLSearchParams(location.search).get('idea');
  if (open) markIdea(open);
}

const rail = mount();
render(rail, readMode(), [], (() => { try { return localStorage.getItem('esprits.me'); } catch { return null; } })());
fill(rail);

// Ctrl/Cmd-K is the shortcut the rail advertises, so it has to work.
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.querySelector('#shell-rail [data-action]')?.click();
  }
});

export { MODES };
