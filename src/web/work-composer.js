/**
 * The box you type a job into.
 *
 * Work had no way in. Every page on that side was a view of something already
 * running, and starting something meant finding a button that opened a dialog —
 * so the half of the app meant for handing work over was the half you could not
 * type in. This is the composer the chat side has, for the thing the work side
 * does.
 *
 * What it starts is a swarm run: the goal is split into independent pieces, the
 * pieces are worked in parallel by whichever model you pick, and the answers are
 * merged into one. That only pays off for jobs that genuinely split — surveying
 * many things, checking many cases, drafting many sections — so the composer
 * says as much rather than letting you discover it after the tokens are spent.
 */

// The shared sheet gives .jobbox its shape; what is left is what only this box
// needs. Kept here rather than in the theme because nothing else has a worker
// count or a model picker sitting inside the thing you type in.
const CSS = `
.jobbox label{font-size:12px;color:var(--faint);display:flex;align-items:center;gap:6px;margin:0}
.jobbox input[type=number]{width:54px;padding:5px 7px;border-radius:7px;font-size:12.5px}
.jobbox select.quiet{background:none;border-color:transparent;color:var(--dim);font-size:12.5px;
  padding:5px 6px;max-width:220px;width:auto}
.jobbox select.quiet:hover{border-color:var(--line)}
.jobbox button.go{background:var(--accent);border-color:var(--accent);color:#fff;
  margin-left:auto;font-weight:550;padding:6px 15px}
.jobbox button.go:hover:not(:disabled){filter:brightness(1.07)}
.jobbox .note{font-size:12px;color:var(--faint);min-height:16px}
.jobbox .note.err{color:var(--bad)} .jobbox .note.ok{color:var(--good)}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function call(path, opts) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `${res.status} ${res.statusText}`);
  return out;
}

/**
 * Put the composer at the bottom of `host`.
 *
 * `onStarted` is how a page that can show the run itself takes over; without
 * one the composer sends you to the page that can.
 */
export async function mountJobBox({ host, onStarted = null, idea = null } = {}) {
  const parent = typeof host === 'string' ? document.querySelector(host) : host;
  if (!parent || parent.querySelector('.jobbox')) return;

  if (!document.getElementById('jobbox-css')) {
    const style = document.createElement('style');
    style.id = 'jobbox-css';
    style.textContent = CSS;
    document.head.append(style);
  }

  let me = null;
  try { me = localStorage.getItem('esprits.me'); } catch { /* private window */ }

  const box = document.createElement('div');
  box.className = 'jobbox';
  box.innerHTML = `
    <div class="wrap">
      <div class="chips">
        <span class="chip">runs in parallel</span>
        <span class="chip" id="jobWhere">saved as an artifact</span>
      </div>
      <div class="box">
        <textarea id="jobGoal" rows="1"
          placeholder="Hand over a job — it gets split into pieces and worked at the same time"></textarea>
        <div class="row">
          <label>pieces <input id="jobN" type="number" min="2" max="16" value="4"></label>
          <select id="jobSeat" class="quiet"><option value="">loading models…</option></select>
          <span class="note" id="jobNote"></span>
          <button class="go" id="jobGo">Run it</button>
        </div>
      </div>
    </div>`;
  parent.append(box);

  const note = (text, kind = '') => {
    const n = box.querySelector('#jobNote');
    n.textContent = text;
    n.className = `note ${kind}`;
  };

  // Which models could actually take the work. A picker offering seats that
  // cannot run is a picker that fails after you press the button.
  let seats = [];
  try {
    ({ seats } = await call('/api/swarms'));
  } catch (err) {
    note(err.message, 'err');
  }

  const picker = box.querySelector('#jobSeat');
  picker.innerHTML = seats.length
    ? seats.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} · ${esc(s.model)}</option>`).join('')
    : '<option value="">no model is ready</option>';

  const ready = seats.length > 0 && Boolean(me);
  box.querySelector('#jobGo').disabled = !ready;
  if (!seats.length) note('add a model with a key on the setup page first', 'err');
  else if (!me) note('open the chat once to set your handle', 'err');

  async function run() {
    const goal = box.querySelector('#jobGoal').value.trim();
    if (!goal) return note('say what the job is', 'err');
    const go = box.querySelector('#jobGo');
    go.disabled = true;
    note('planning…');
    try {
      const started = await call('/api/swarms', {
        method: 'POST',
        body: JSON.stringify({
          goal,
          workers: Number(box.querySelector('#jobN').value) || 4,
          seat: picker.value || undefined,
          idea: typeof idea === 'function' ? idea() : idea,
          as: me,
        }),
      });
      box.querySelector('#jobGoal').value = '';
      box.querySelector('#jobGoal').style.height = 'auto';
      note('running', 'ok');
      if (onStarted) await onStarted(started);
      else location.href = '/work';
    } catch (err) {
      note(err.message, 'err');
    } finally {
      go.disabled = !ready;
    }
  }

  const goal = box.querySelector('#jobGoal');
  const grow = () => { goal.style.height = 'auto'; goal.style.height = `${Math.min(goal.scrollHeight, 200)}px`; };
  goal.addEventListener('input', grow);

  box.querySelector('#jobGo').addEventListener('click', run);
  box.querySelector('#jobGoal').addEventListener('keydown', (e) => {
    // Enter makes a new line in a box this size; the shortcut sends.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  return { run, focus: () => box.querySelector('#jobGoal').focus() };
}
