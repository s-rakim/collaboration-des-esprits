/**
 * The shell: one bar across the top, shared by every page.
 *
 * Six tabs are the whole map — Chat, Threads, the Agents' PC, Work, Artifacts
 * and Setup — and everything that is not one of them sits behind "More", so
 * the bar never has more on it than can be read in a glance. The ideas you
 * are talking about are one menu on the right; the thing to start is one
 * button. Nothing else is permanent chrome: the page gets the whole width.
 *
 * The bar builds itself around whatever the page already is: it wraps the
 * existing body and sits above it, so a page needs nothing but the script
 * tag. The only contract is an empty <nav id="nav"> somewhere, which is
 * removed — it is where an older bar used to be.
 */

/** Line icons, drawn rather than typed, so they sit on the text baseline. */
const ICON = {
  chat: '<path d="M17 11.5a2 2 0 0 1-2 2H8l-3.5 3v-3H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  dashboard: '<rect x="2.5" y="2.5" width="15" height="15" rx="2"/><path d="M8 2.5v15M8 9.5h9.5"/>',
  tasks: '<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h8"/>',
  artifacts: '<path d="M5 2.5h6l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M11 2.5v4h4"/>',
  design: '<path d="M14.5 3.5l2 2-9 9-3 1 1-3z"/><path d="M3.5 16.5h5"/>',
  plugins: '<circle cx="10" cy="10" r="3"/><path d="M10 2.5V7M10 13v4.5M2.5 10H7M13 10h4.5"/>',
  skills: '<path d="M4 4.5h9a2 2 0 0 1 2 2v9H6a2 2 0 0 0-2 2z"/><path d="M4 4.5v11"/><path d="M7.5 8h4"/>',
  scheduled: '<circle cx="10" cy="10.5" r="6.5"/><path d="M10 7v3.5l2.5 1.5"/><path d="M7 2.5h6"/>',
  swarm: '<circle cx="10" cy="5" r="2"/><circle cx="5" cy="14" r="2"/><circle cx="15" cy="14" r="2"/><path d="M10 7v3M8.5 11.5L6.5 13M11.5 11.5l2 1.5"/>',
  setup: '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/>',
  coordinator: '<path d="M10 2.5l6 2.5v5c0 4-2.6 6.6-6 7.5-3.4-.9-6-3.5-6-7.5v-5z"/><path d="M7.5 10l2 2 3.5-4"/>',
  threads: '<path d="M5 3v9a3 3 0 0 0 3 3h7"/><path d="M5 7h10"/><path d="M12.5 4.5L15 7l-2.5 2.5M12.5 12.5L15 15l-2.5 2.5"/>',
  desktop: '<rect x="2.5" y="3.5" width="15" height="10" rx="1.5"/><path d="M7 16.5h6M10 13.5v3"/>',
  more: '<circle cx="4.5" cy="10" r="1.2"/><circle cx="10" cy="10" r="1.2"/><circle cx="15.5" cy="10" r="1.2"/>',
  down: '<path d="M5.5 8l4.5 4.5L14.5 8"/>',
  sun: '<circle cx="10" cy="10" r="3.2"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/>',
  moon: '<path d="M16.5 11.5A6.5 6.5 0 0 1 8.5 3.5a6.5 6.5 0 1 0 8 8z"/>',
  panelClose: '<path d="M12.5 5.5L8 10l4.5 4.5"/>',
  panelOpen: '<path d="M7.5 5.5L12 10l-4.5 4.5"/>',
};

const icon = (name) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

/** The tabs. Six, in the order the work moves: talk, build, look, hand off, keep, configure. */
const TABS = [
  { href: '/', label: 'Chat', icon: 'chat', hint: 'The lobby and every idea — you and the models talking' },
  { href: '/threads', label: 'Threads', icon: 'threads', hint: 'What was approved, being built' },
  { href: '/pc', label: "Agents' PC", icon: 'desktop', hint: 'The machine the agents work on: files, editors, terminal, browser' },
  { href: '/work', label: 'Work', icon: 'tasks', hint: 'Jobs handed over and run without you watching' },
  { href: '/artifacts', label: 'Artifacts', icon: 'artifacts', hint: 'What the room has produced' },
  { href: '/setup', label: 'Setup', icon: 'setup', hint: 'Connections, keys and the models in the room' },
];

/** Everything else, one click further away. */
const MORE = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard', hint: 'What the room has been doing' },
  { href: '/design', label: 'Design', icon: 'design', hint: 'Colours and fonts' },
  { href: '/plugins', label: 'Plugins', icon: 'plugins', hint: 'Tools the models can use' },
  { href: '/plugins#skills', label: 'Skills', icon: 'skills', hint: 'Instructions the models can load' },
  { href: '/work#swarm', label: 'Swarm', icon: 'swarm', hint: 'Many models on one job' },
  { href: '/setup#scheduled', label: 'Scheduled', icon: 'scheduled', hint: 'Jobs that run on a clock' },
  { href: '/dashboard#coordinator', label: 'Coordinator', icon: 'coordinator', hint: 'Who oversees the builds' },
  { href: '/setup#customize', label: 'Customize', icon: 'setup', hint: 'House style and what the models know about you' },
];

/**
 * The two halves of the room, kept for the one thing that differs between
 * them: what the button at the top starts.
 */
const MODES = {
  work: { label: 'Work', home: '/dashboard', action: { label: 'New task', key: 'new-task', href: '/work', owner: '/work' } },
  chat: { label: 'Chat', home: '/', action: { label: 'New idea', key: 'new-idea', href: '/', owner: '/' } },
};

const WORK_PAGES = new Set(['/work', '/dashboard']);

const TOP = 52;

const CSS = `
:root{--top:${TOP}px}
body{display:flex;flex-direction:column;height:100vh;overflow:hidden}
#shell-page{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column}
#shell-page>main{flex:1}
/* A gutter down the right for the tabs that open the PC's windows, so they never sit on top of the page. */
@media (min-width:701px){#shell-page{margin-right:38px}}

#topbar{flex:none;height:var(--top);position:relative;z-index:45;display:flex;align-items:center;gap:6px;padding:0 14px;
  background:var(--bar-bg);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  border-bottom:1px solid var(--bar-line);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 14%,transparent),0 8px 30px rgba(0,0,0,.18)}
#topbar svg{width:17px;height:17px;flex:none}
#topbar .brand{display:flex;align-items:center;gap:9px;font-size:15.5px;font-weight:650;letter-spacing:-.02em;color:var(--bar-on);
  text-decoration:none;margin-right:10px;white-space:nowrap}
#topbar .brand i{width:22px;height:22px;border-radius:7px;flex:none;
  background:linear-gradient(135deg,var(--bar-on),color-mix(in srgb,var(--bar-on) 45%,transparent));box-shadow:0 0 16px color-mix(in srgb,var(--bar-on) 25%,transparent)}

#topbar .tabs{display:flex;align-items:stretch;gap:2px;height:100%;min-width:0;overflow-x:auto;scrollbar-width:none}
#topbar .tabs::-webkit-scrollbar{display:none}
#topbar a.tab,#topbar button.tab{position:relative;display:flex;align-items:center;gap:8px;padding:0 14px;margin:8px 0;border-radius:999px;
  font:inherit;font-size:14px;font-weight:500;color:var(--bar-fg);text-decoration:none;background:none;border:0;cursor:pointer;white-space:nowrap;
  transition:color .12s ease,background .12s ease}
#topbar a.tab:hover,#topbar button.tab:hover{color:var(--bar-on);background:color-mix(in srgb,var(--bar-on) 10%,transparent)}
#topbar .tab.on{color:var(--bar-on);background:color-mix(in srgb,var(--bar-on) 14%,transparent);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 22%,transparent),inset 0 0 0 1px color-mix(in srgb,var(--bar-on) 10%,transparent)}
#topbar .tab.on::after{content:none}

#topbar .grow{flex:1;min-width:8px}
#topbar .pill{display:flex;align-items:center;gap:7px;height:34px;padding:0 13px;border-radius:999px;box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 12%,transparent);font:inherit;font-size:13.5px;cursor:pointer;
  color:var(--bar-fg);background:color-mix(in srgb,var(--bar-on) 8%,transparent);border:1px solid color-mix(in srgb,var(--bar-on) 16%,transparent);white-space:nowrap;max-width:260px}
#topbar .pill:hover{color:var(--bar-on);border-color:color-mix(in srgb,var(--bar-on) 35%,transparent)}
#topbar .pill.icon{padding:0;width:34px;justify-content:center}
#topbar .pill .t{overflow:hidden;text-overflow:ellipsis}
#topbar .pill .dot{width:7px;height:7px;border-radius:50%;background:var(--warn);flex:none}
#topbar .go{display:flex;align-items:center;gap:7px;height:34px;padding:0 15px;border-radius:999px;box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 50%,transparent),0 6px 18px rgba(0,0,0,.25);font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;
  color:var(--bar-go-fg);background:var(--bar-go-bg);border:1px solid var(--bar-go-bg);white-space:nowrap}
#topbar .go:hover{filter:brightness(1.08)}
#topbar .go kbd{font:500 10.5px var(--mono);opacity:.7;border:1px solid currentColor;border-radius:4px;padding:0 4px}
#topbar .me{width:32px;height:32px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:13px;font-weight:650;
  color:var(--bar-on);background:color-mix(in srgb,var(--bar-on) 14%,transparent);border:1px solid color-mix(in srgb,var(--bar-on) 22%,transparent);cursor:default}

/* The menus that drop from the bar. */
#topbar .drop{position:relative;display:flex;align-items:center;height:100%}
.topmenu{position:absolute;top:calc(100% - 4px);right:0;z-index:50;min-width:270px;max-height:min(70vh,560px);overflow:auto;padding:6px;
  background:var(--glass-strong);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  border:1px solid var(--hair);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.5);animation:menu-in .13s ease-out}
.topmenu.left{left:0;right:auto}
.topmenu[hidden]{display:none}
@keyframes menu-in{from{opacity:0;transform:translateY(-6px)}}
.topmenu a,.topmenu button{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border-radius:9px;font:inherit;font-size:14px;
  color:var(--dim);text-decoration:none;background:none;border:0;cursor:pointer;text-align:left}
.topmenu a:hover,.topmenu button:hover{background:color-mix(in srgb,var(--text) 8%,transparent);color:var(--text)}
.topmenu a.on{color:var(--text);background:color-mix(in srgb,var(--text) 8%,transparent)}
.topmenu a small{display:block;font-size:12px;color:var(--faint);margin-top:1px}
.topmenu a>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topmenu .head{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);padding:10px 10px 4px}
.topmenu .none{font-size:13px;color:var(--faint);padding:6px 10px 8px}
.topmenu .dot{width:7px;height:7px;border-radius:50%;flex:none;border:1.5px solid var(--faint)}
.topmenu .dot.live{background:var(--accent);border-color:var(--accent)}
.topmenu svg{width:17px;height:17px;flex:none}

/* The button that puts a side panel away, pinned to its inner edge. */
.panel-toggle{position:absolute;top:10px;left:6px;z-index:3;display:flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;cursor:pointer;background:none;color:var(--faint)}
.panel-toggle:hover{background:var(--panel2);border-color:var(--line);color:var(--text)}
.panel-toggle svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}

/* A message shown inside a modal, where a page toast cannot reach. */
dialog .shell-msg{margin:0;flex:1;min-width:0;font-size:13.5px;color:var(--bad);text-align:left}
dialog .shell-msg[data-kind="ok"]{color:var(--good)}
dialog .shell-msg[data-kind="info"]{color:var(--dim)}
dialog .shell-msg:empty{display:none}

@media (max-width:1180px){#topbar .go kbd{display:none} #topbar .pill{max-width:170px}}
@media (max-width:980px){#topbar a.tab .t,#topbar button.tab .t{display:none} #topbar a.tab,#topbar button.tab{padding:0 11px}
  #topbar .brand b{display:none} #topbar .go .t{display:none}}
`;

const path = () => location.pathname.replace(/\.html$/, '').replace(/^\/index$/, '/') || '/';

function readMode() {
  return WORK_PAGES.has(path()) ? 'work' : 'chat';
}

const here = (href) => path() === href.split('#')[0];

/**
 * Build the shell once: wrap what the page already has, and put the bar above
 * it. Done in script rather than in nine copies of the same markup, so a page
 * added later gets it for nothing.
 */
function mount() {
  if (document.getElementById('topbar')) return document.getElementById('topbar');

  const style = document.createElement('style');
  style.id = 'shell-css';
  style.textContent = CSS;
  document.head.append(style);

  const page = document.createElement('div');
  page.id = 'shell-page';
  // Everything already in the body becomes the page, in order.
  while (document.body.firstChild) page.append(document.body.firstChild);

  // A div, not a nav: several pages style every <nav> they contain, and this one is not theirs.
  const bar = document.createElement('div');
  bar.id = 'topbar';
  bar.setAttribute('role', 'navigation');
  document.body.append(bar, page);
  // The placeholder an older bar left in each page's own header.
  document.getElementById('nav')?.remove();

  // A menu is put away by pressing anywhere else, or Escape.
  document.addEventListener('click', (e) => {
    for (const m of bar.querySelectorAll('.topmenu')) if (!m.parentElement.contains(e.target)) m.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const m of bar.querySelectorAll('.topmenu')) m.hidden = true;
  });
  return bar;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The ideas, grouped the way the room files them: the lobby, then each
 * project with its ideas under it, then anything unfiled.
 */
function ideaMenu(ideas, current) {
  const line = (i) => `
    <a href="/?idea=${encodeURIComponent(i.slug)}" data-idea="${esc(i.slug)}" class="${current === i.slug ? 'on' : ''}"
       title="${esc(i.title)}${i.stage ? ` — ${esc(i.stage)}` : ''}${i.needsYou ? ' — waiting on you' : ''}">
      <span class="dot ${i.needsYou ? 'live' : ''}"></span><span>${esc(i.title)}</span>
    </a>`;
  const byProject = new Map();
  const loose = [];
  for (const i of ideas) {
    if (!i.project) { loose.push(i); continue; }
    if (!byProject.has(i.project)) byProject.set(i.project, []);
    byProject.get(i.project).push(i);
  }
  let out = `<a href="/" data-idea="" class="${current === '' ? 'on' : ''}" title="The lobby — cross-cutting chat"><span class="dot"></span><span>Lobby</span></a>`;
  for (const [project, list] of byProject) out += `<div class="head" title="${esc(project)}">${esc(project)}</div>${list.map(line).join('')}`;
  if (loose.length) out += `<div class="head">${byProject.size ? 'Unfiled' : 'Ideas'}</div>${loose.map(line).join('')}`;
  if (!ideas.length) out += '<div class="none">No ideas yet — drop one in the chat.</div>';
  return out;
}

let shown = { ideas: [], me: null, current: null };

/** Is the page light right now — whichever way it came to be. */
const isLight = () => getComputedStyle(document.documentElement).getPropertyValue('--on-accent').trim() === '#ffffff';

/**
 * Light to dark and back. The page changes at once; the choice is saved in
 * the room, so every page and every device opens the same way next time.
 */
async function flipLook(bar) {
  const next = isLight() ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  render(bar, readMode(), shown.ideas, shown.me);
  try {
    const now = await (await fetch('/api/theme')).json();
    await fetch('/api/theme', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(now.saved ?? {}), appearance: next }),
    });
  } catch { /* the page has changed; it will simply not be remembered */ }
}

function render(bar, mode, ideas, me) {
  const m = MODES[mode];
  const onChat = here('/');
  const current = shown.current ?? (onChat ? (new URLSearchParams(location.search).get('idea') ?? '') : null);
  shown = { ideas, me, current };
  const inMore = MORE.some((l) => !l.href.includes('#') && here(l.href));
  const title = current === null ? 'Ideas' : current === '' ? 'Lobby' : (ideas.find((i) => i.slug === current)?.title ?? 'Ideas');
  const waiting = ideas.filter((i) => i.needsYou).length;

  bar.innerHTML = `
    <a class="brand" href="/" title="Esprits"><i></i><b>Esprits</b></a>
    <div class="tabs">
      ${TABS.map((t) => `<a class="tab ${here(t.href) ? 'on' : ''}" href="${t.href}" title="${esc(t.hint)}">${icon(t.icon)}<span class="t">${esc(t.label)}</span></a>`).join('')}
      <div class="drop">
        <button class="tab ${inMore ? 'on' : ''}" data-menu="more" title="Everything else">${icon('more')}<span class="t">More</span></button>
        <div class="topmenu left" id="menu-more" hidden>
          ${MORE.map((l) => `<a href="${l.href}" class="${!l.href.includes('#') && here(l.href) ? 'on' : ''}">${icon(l.icon)}<span>${esc(l.label)}<small>${esc(l.hint)}</small></span></a>`).join('')}
        </div>
      </div>
    </div>
    <span class="grow"></span>
    <div class="drop">
      <button class="pill" data-menu="ideas" title="The lobby and your ideas${waiting ? ` — ${waiting} waiting on you` : ''}">
        ${waiting ? '<span class="dot"></span>' : ''}<span class="t">${esc(title)}</span>${icon('down')}</button>
      <div class="topmenu" id="menu-ideas" hidden>${ideaMenu(ideas, current)}</div>
    </div>
    <button class="pill icon" id="lookToggle" title="Switch between light and dark">${icon(isLight() ? 'moon' : 'sun')}</button>
    <button class="go" data-action="${m.action.key}" title="${esc(m.action.label)} (Ctrl K)">${icon('plus')}<span class="t">${esc(m.action.label)}</span><kbd>Ctrl K</kbd></button>
    <span class="me" title="${me ? esc(me) : 'not identified — open the chat to say who you are'}">${me ? esc(me.slice(0, 1).toUpperCase()) : '?'}</span>`;

  for (const b of bar.querySelectorAll('[data-menu]')) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = bar.querySelector(`#menu-${b.dataset.menu}`);
      const open = menu.hidden;
      for (const x of bar.querySelectorAll('.topmenu')) x.hidden = true;
      menu.hidden = !open;
    });
  }

  bar.querySelector('#lookToggle').addEventListener('click', () => flipLook(bar));

  bar.querySelector('[data-action]').addEventListener('click', (e) => {
    const { action } = e.currentTarget.dataset;
    if (here(m.action.owner)) {
      window.dispatchEvent(new CustomEvent('esprits:action', { detail: { action } }));
    } else {
      location.href = `${m.action.href}?do=${action}`;
    }
  });

  for (const a of bar.querySelectorAll('[data-idea]')) {
    a.addEventListener('click', (e) => {
      // In the chat, choosing an idea switches the conversation in place.
      if (!here('/')) return;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('esprits:idea', { detail: { idea: a.dataset.idea } }));
      markIdea(a.dataset.idea);
    });
  }
}

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
export function collapsiblePanel({ el, name, title = 'panel', startClosed = false }) {
  const panel = typeof el === 'string' ? document.querySelector(el) : el;
  if (!panel || panel.querySelector('.panel-toggle')) return;

  const key = `esprits.panel.${name}`;
  const cls = `panel-${name}-closed`;

  let closed = startClosed;
  try { const was = localStorage.getItem(key); if (was) closed = was === 'closed'; } catch { /* private window */ }
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

/**
 * The terminal and the browser, from wherever you are.
 *
 * Loaded when first asked for rather than with every page: most visits to most
 * pages never open either, and the drawer is the same one whichever page asks.
 */
export async function openTool(tab = 'terminal') {
  const tools = await import('/tools.js');
  tools.toggleTools(tab);
}

/** Show which thread is open, when the page changes it without navigating. */
export function markIdea(slug) {
  shown.current = slug ?? '';
  const bar = document.getElementById('topbar');
  if (bar) render(bar, readMode(), shown.ideas, shown.me);
}

/** Re-read the ideas, for a page that has just created one. */
export async function refreshNav() {
  const bar = document.getElementById('topbar');
  if (bar) await fill(bar);
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
// The tabs on the right-hand edge are on every page, so they are put there with the rail.
import('/tools.js').then((tools) => tools.edgeTabs()).catch(() => {});
render(rail, readMode(), [], (() => { try { return localStorage.getItem('esprits.me'); } catch { return null; } })());
fill(rail);

// Ctrl/Cmd-K is the shortcut the rail advertises, so it has to work.
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '`') {
    e.preventDefault();
    openTool('terminal');
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.querySelector('#topbar [data-action]')?.click();
  }
});

export { MODES };
