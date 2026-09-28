/**
 * The shell's navigation, shared by every page.
 *
 * Two modes, because the two halves of this app want different things in front
 * of you. Chat is where you and the models talk, with what that produces beside
 * it. Work is where jobs get handed over and run without you watching. Keeping
 * both sets of links visible at once made the bar long and the distinction
 * invisible, which is the problem the toggle solves.
 *
 * The chosen mode is remembered per browser; it is a view preference, not state
 * the room needs to know about.
 */

const MODES = {
  chat: {
    label: 'Chat',
    icon: '💬',
    home: '/',
    links: [
      { href: '/', label: 'Chat' },
      { href: '/artifacts', label: 'Artifacts' },
      { href: '/design', label: 'Design' },
    ],
  },
  work: {
    label: 'Work',
    icon: '🖥',
    home: '/dashboard',
    links: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/work', label: 'Tasks' },
      { href: '/plugins', label: 'Plugins' },
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

const CSS = `
#nav{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#nav .seg{display:flex;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:2px;gap:2px}
#nav .seg button{background:none;border:0;color:var(--dim);font:inherit;font-size:12.5px;padding:4px 12px;border-radius:7px;cursor:pointer;display:flex;align-items:center;gap:5px}
#nav .seg button:hover{color:var(--text)}
#nav .seg button.on{background:var(--panel);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.2)}
#nav .links{display:flex;gap:4px;flex-wrap:wrap}
#nav .links a{color:var(--dim);text-decoration:none;font-size:12.5px;border:1px solid transparent;padding:4px 10px;border-radius:7px}
#nav .links a:hover{border-color:var(--line);color:var(--text)}
#nav .links a.on{background:var(--panel2);border-color:var(--line);color:var(--text)}
#nav .setup{margin-left:4px;color:var(--faint);text-decoration:none;font-size:12.5px;padding:4px 10px;border-radius:7px;border:1px solid transparent}
#nav .setup:hover{border-color:var(--line);color:var(--text)}
`;

function currentPath() {
  const p = location.pathname;
  return p.endsWith('/') ? p : p;
}

export function renderNav(host = document.getElementById('nav')) {
  if (!host) return;

  const path = currentPath();
  // The page decides the mode; the stored preference only matters on pages
  // that belong to neither (setup), and for which home a toggle click goes to.
  let mode = PAGE_MODE[path] ?? PAGE_MODE[path.replace(/\.html$/, '')] ?? null;
  if (!mode) {
    try { mode = localStorage.getItem('esprits.mode'); } catch { /* private window */ }
    mode = MODES[mode] ? mode : 'chat';
  } else {
    try { localStorage.setItem('esprits.mode', mode); } catch { /* ignore */ }
  }

  if (!document.getElementById('nav-css')) {
    const style = document.createElement('style');
    style.id = 'nav-css';
    style.textContent = CSS;
    document.head.append(style);
  }

  const here = (href) => path === href || path === `${href}.html` || (href === '/' && path === '/index.html');

  host.innerHTML = `
    <div class="seg">
      ${Object.entries(MODES).map(([id, m]) =>
        `<button data-mode="${id}" class="${mode === id ? 'on' : ''}">${m.icon} ${m.label}</button>`).join('')}
    </div>
    <div class="links">
      ${MODES[mode].links.map((l) => `<a href="${l.href}" class="${here(l.href) ? 'on' : ''}">${l.label}</a>`).join('')}
    </div>
    <a class="setup" href="/setup">Setup</a>`;

  for (const b of host.querySelectorAll('[data-mode]')) {
    b.addEventListener('click', () => {
      const next = b.dataset.mode;
      try { localStorage.setItem('esprits.mode', next); } catch { /* ignore */ }
      // Switching mode moves you to that half's home, rather than leaving you
      // on a page the new mode does not list.
      if (next !== mode) location.href = MODES[next].home;
    });
  }
}

renderNav();
