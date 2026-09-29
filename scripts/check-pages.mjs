#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drive the room in a real browser.
 *
 * `npm test` covers the rules; this covers the parts only a browser has an
 * opinion about — whether a page throws, whether an error is somewhere you can
 * actually see it, whether pressing Enter does what pressing Enter does
 * everywhere else. Both of the bugs that made this app feel broken on a first
 * run were of exactly that kind, and neither was reachable from a unit test:
 *
 *   - Enter in a dialog did nothing at all, so typing your handle and pressing
 *     Enter silently failed to join you.
 *   - A modal is painted above the page, so the toast explaining what was wrong
 *     with what you typed rendered behind the dialog you were looking at.
 *   - A seat with no connection displayed the first one anyway, so the setup
 *     page looked correctly configured while nothing was.
 *
 * Runs its own server on a scratch database, so it leaves nothing behind.
 *
 *   npm run check:pages
 */

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CHECK_PORT ?? 4455);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || undefined;

const dataDir = mkdtempSync(join(tmpdir(), 'esprits-check-'));
const failures = [];
const note = (where, what) => failures.push(`${where}: ${what}`);

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, '..', 'src', 'bin', 'serve.js')], {
  env: { ...process.env, ESPRITS_DB: join(dataDir, 'room.db'), PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

/**
 * A provider that answers like OpenAI, so a seat can really be exercised — and
 * like the ones people actually paste: nothing at the root, the API under /v1,
 * and model ids that look nothing like the names on the marketing page.
 */
const { createServer } = await import('node:http');
const OFFERED = ['vendor/model-a-instruct', 'vendor/model-b-instruct'];
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const path = new URL(req.url, 'http://x').pathname;

  if (path === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: OFFERED.map((id) => ({ id })) }));
  }
  if (path !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end('<html><body>404 Not Found</body></html>');
  }

  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'reply', arguments: JSON.stringify({ body: 'Understood.' }) } }] } }],
    model: body.model,
  }));
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
// Deliberately without the /v1 the endpoint needs: the check is that the page
// works that out rather than leaving somebody to read a 404 and guess.
const PROVIDER = `http://127.0.0.1:${provider.address().port}`;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the server did not start:\n${serverLog.join('')}`);
}

function watch(page, where) {
  page.on('pageerror', (e) => note(where, `threw: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') note(where, `console error: ${m.text()}`); });
  page.on('requestfailed', (r) => {
    // A live stream is cut off by navigation or reload; that is the browser
    // doing its job, not the page failing. The chat page appends ?since=, so
    // the path is what is matched rather than the whole URL.
    if (new URL(r.url()).pathname === '/api/events' && r.failure()?.errorText === 'net::ERR_ABORTED') return;
    note(where, `request failed: ${r.url()} ${r.failure()?.errorText}`);
  });
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

  // ---------------------------------------------------------- joining the room

  {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    watch(page, 'join');
    await page.goto(BASE, { waitUntil: 'networkidle' });

    // Enter is how people submit a one-line field. It has to work.
    await page.click('#setMe');
    await page.fill('#meName', 'rakim');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    if ((await page.textContent('#meLabel')).trim() !== 'rakim') note('join', 'pressing Enter did not join');
    if (await page.evaluate(() => document.getElementById('dlgMe').open)) note('join', 'the dialog stayed open after joining');

    // A refused handle must say why, somewhere visible above the modal.
    await page.click('#setMe');
    await page.fill('#meName', 'Two Words');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const said = await page.evaluate(() => {
      const line = document.querySelector('#dlgMe .shell-msg');
      if (!line?.textContent.trim()) return null;
      const r = line.getBoundingClientRect();
      const onTop = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { text: line.textContent.trim(), visible: Boolean(onTop?.closest('#dlgMe')) };
    });
    if (!said) note('join', 'a refused handle produced no message in the dialog');
    else if (!said.visible) note('join', 'the message is painted behind the dialog');

    // Reopening must not show the last error.
    await page.keyboard.press('Escape');
    await page.click('#setMe');
    await page.waitForTimeout(200);
    if (await page.evaluate(() => document.querySelector('#dlgMe .shell-msg')?.textContent.trim())) {
      note('join', 'a stale message survived reopening the dialog');
    }
    await page.keyboard.press('Escape');

    // Enter inside a textarea is a new line, not a submit.
    await page.click('#newIdea');
    await page.click('#ideaRaw');
    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    if (!(await page.inputValue('#ideaRaw')).includes('\n')) note('join', 'Enter in a textarea did not make a new line');
    if (await page.evaluate(() => !document.getElementById('dlgIdea').open)) note('join', 'Enter in a textarea submitted the dialog');
    await page.keyboard.press('Escape');
    await page.close();
  }

  // ------------------------------- a handle this browser remembers but the room does not

  {
    // localStorage belongs to the address, not to the database behind it, so a
    // rebuilt room meets a browser still insisting on the old handle. The page
    // used to believe it and every message failed with "call join first", with
    // no way back because a page that thinks you are identified never asks.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('esprits.me', '@ghost-of-a-dead-room'); } catch {} });
    const page = await ctx.newPage();
    watch(page, 'stale handle');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);

    const known = await page.evaluate(async () => (await (await fetch('/api/roster')).json()).map((a) => a.name));
    if (!known.includes('ghost-of-a-dead-room')) note('stale handle', 'the page did not rejoin a room that had forgotten it');
    if (known.some((n) => n.startsWith('@'))) note('stale handle', 'the @ somebody typed was stored as part of the name');

    await page.fill('#body', 'anybody there');
    await page.click('#send');
    await page.waitForTimeout(1200);
    const feed = await page.evaluate(async () => (await (await fetch('/api/feed?since=0')).json()).messages.map((m) => m.body));
    if (!feed.includes('anybody there')) note('stale handle', 'sending still failed after the page repaired itself');
    await ctx.close();
  }

  // ------------------------------------------------- a key, a seat, and a reply

  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(page, 'setup');
    await page.goto(`${BASE}/setup`, { waitUntil: 'networkidle' });

    // A seat with no connection must not look like it has one, or the page
    // reads as configured while nothing is.
    const showsPlaceholder = await page.$$eval('.seat .sc', (sel) =>
      sel.every((s) => s.selectedOptions[0]?.value === ''));
    if (!showsPlaceholder) note('setup', 'a seat with no connection displays one anyway');

    await page.click('#addConn');
    await page.waitForSelector('.conn[data-new="1"]');
    const row = await page.$('.conn[data-new="1"]');
    await row.$eval('.cn', (el) => { el.value = 'test provider'; });
    await row.$eval('.cu', (el, url) => { el.value = url; }, PROVIDER);
    // The name off the documentation page rather than the id, which is the
    // mistake everybody makes and nothing used to catch.
    await row.$eval('.cm', (el) => { el.value = 'Vendor Model A'; });
    await row.$eval('.cs', (el) => { el.value = 'sk-not-a-real-key'; });
    await row.$eval('.cn', (el) => el.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(1200);

    // Ask the endpoint what it wants, instead of making somebody guess twice.
    await page.click('.conn[data-conn="test provider"] .find');
    await page.waitForFunction(
      () => /models —|error|could not|none of these/i.test(document.querySelector('#msg')?.textContent ?? ''),
      null, { timeout: 20000 },
    );
    await page.waitForTimeout(600);

    const fixed = await page.inputValue('.conn[data-conn="test provider"] .cu');
    if (!fixed.endsWith('/v1')) note('setup', `"find" did not repair the base URL (left it at ${fixed})`);
    const list = await page.$$eval('.conn[data-conn="test provider"] datalist option', (o) => o.map((x) => x.value));
    if (!list.length) note('setup', '"find" did not offer the models the endpoint listed');
    const left = await page.inputValue('.conn[data-conn="test provider"] .cm');
    if (left) note('setup', `a model the endpoint does not have was kept: ${left}`);

    // Picking one from the list must actually work.
    await page.fill('.conn[data-conn="test provider"] .cm', list[0] ?? 'nothing');
    await page.dispatchEvent('.conn[data-conn="test provider"] .cm', 'change');
    await page.waitForTimeout(1000);

    const saved = await page.evaluate(async () => (await (await fetch('/api/connections')).json()).connections);
    const mine = saved.find((c) => c.name === 'test provider');
    if (!mine) note('setup', 'the connection was not saved');
    else if (!mine.keySet) note('setup', 'the key was not stored');
    if (JSON.stringify(saved).includes('sk-not-a-real-key')) note('setup', 'the raw key was sent back to the page');

    // The note under the seats has to say what is stopping them.
    const seatNote = (await page.textContent('#seatNote')).trim();
    if (!/no connection yet/.test(seatNote)) note('setup', `the seat note explains nothing: "${seatNote}"`);

    // Choosing a connection puts that seat in the chat, in one action.
    await page.selectOption('.seat:first-child .sc', 'test provider');
    await page.waitForTimeout(1500);
    const seats = await page.evaluate(async () => (await (await fetch('/api/seats')).json()).seats);
    const first = seats[0];
    if (!first.connection) note('setup', 'picking a connection did not stick');
    if (!first.enabled) note('setup', 'picking a connection did not put the seat in the chat');
    if (!first.running) note('setup', 'the seat did not start');

    // And the switch can take it back out again.
    await page.uncheck('.seat:first-child .sx');
    await page.waitForTimeout(1200);
    const after = await page.evaluate(async () => (await (await fetch('/api/seats')).json()).seats[0]);
    if (after.enabled) note('setup', 'the in-chat switch does not switch it off');
    await page.check('.seat:first-child .sx');
    await page.waitForTimeout(1200);
    await page.close();
  }

  // The seat that is now in the chat must actually answer.
  {
    await fetch(`${BASE}/api/post`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ as: 'rakim', body: '@architect are you there?' }),
    });
    let replied = false;
    for (let i = 0; i < 40 && !replied; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const feed = await (await fetch(`${BASE}/api/feed?since=0`)).json();
      replied = feed.messages.some((m) => m.author === 'architect');
    }
    if (!replied) note('room', 'a configured model never answered a message addressed to it');
  }

  // ---------------------------------------------------------- every page loads

  for (const path of ['/', '/dashboard', '/plugins', '/work', '/design', '/artifacts', '/setup']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(page, path);
    await page.goto(BASE + path, { waitUntil: 'networkidle' });

    const box = await (await page.$('#shell-rail'))?.boundingBox();
    if (!box) note(path, 'no rail');
    else if (box.x !== 0) note(path, `the rail is not against the left edge (x=${box.x})`);

    const modes = await page.$$eval('#shell-rail [data-mode]', (b) => b.map((x) => x.dataset.mode));
    if (modes.join() !== 'work,chat') note(path, `the rail offers ${modes.join() || 'no modes'}`);

    const tops = await page.$$eval('#shell-rail a.item', (a) => a.map((x) => Math.round(x.getBoundingClientRect().top)));
    if (tops.length < 6) note(path, `only ${tops.length} links in the rail`);
    if (new Set(tops).size !== tops.length) note(path, 'rail links share a row — they should stack');
    await page.close();
  }

  // ------------------------------------- somewhere to type on the work side

  for (const path of ['/dashboard', '/work']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { try { localStorage.setItem('esprits.me', 'rakim'); } catch {} });
    watch(page, `${path} composer`);
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    // Work used to be all views and no way in: every page showed something
    // already running, and starting one meant finding a button behind a dialog.
    if (!(await page.$('.jobbox textarea'))) note(path, 'no composer — there is nowhere to type');
    const models = await page.$$eval('.jobbox select option', (o) => o.map((x) => x.value).filter(Boolean));
    if (!models.length) note(path, 'the composer offers no model to run with');
    if (await page.isDisabled('.jobbox button.go')) {
      note(path, `the run button is disabled: ${(await page.textContent('.jobbox .note')).trim()}`);
    }

    // On the page that owns the composer, "New task" belongs in the composer —
    // covering it with a dialog that asks the same question is a step for
    // nothing.
    if (path === '/work') {
      await page.click('#shell-rail [data-action]');
      await page.waitForTimeout(300);
      const focused = await page.evaluate(() => document.activeElement?.id);
      if (focused !== 'jobGoal') note(path, `New task left the focus on ${focused || 'nothing'}`);
    }
    await page.close();
  }

  // ------------------------------------------------- the side panel folds away

  for (const [path, panel, name] of [['/', '#ctx', 'context'], ['/work', '#rail', 'run detail']]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(page, `${path} panel`);
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    const toggle = `${panel} .panel-toggle`;
    if (!(await page.$(toggle))) { note(path, `the ${name} panel cannot be put away`); await page.close(); continue; }

    const wide = (await (await page.$(panel)).boundingBox()).width;
    await page.click(toggle);
    await page.waitForTimeout(400);
    const narrow = (await (await page.$(panel)).boundingBox()).width;
    if (narrow >= wide) note(path, `folding the ${name} panel changed nothing`);
    // A panel with no way back is one people close once and never find again.
    if (!(await page.isVisible(toggle))) note(path, `the way back went with the ${name} panel`);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    if (Math.abs((await (await page.$(panel)).boundingBox()).width - narrow) > 2) {
      note(path, `it forgot the ${name} panel was folded`);
    }
    await page.click(toggle);
    await page.waitForTimeout(400);
    if (Math.abs((await (await page.$(panel)).boundingBox()).width - wide) > 2) {
      note(path, `the ${name} panel did not come back`);
    }
    await page.close();
  }

  // ------------------------------------------------------------------- a phone

  {
    const page = await browser.newPage({ viewport: { width: 420, height: 820 } });
    watch(page, 'phone');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if ((await (await page.$('#shell-rail')).boundingBox()).x >= 0) note('phone', 'the rail is taking the screen instead of hiding');
    await page.click('#rail-open');
    await page.waitForTimeout(350);
    if (Math.round((await (await page.$('#shell-rail')).boundingBox()).x) !== 0) note('phone', 'the menu button did not open the rail');
    await page.mouse.click(390, 500);
    await page.waitForTimeout(350);
    if ((await (await page.$('#shell-rail')).boundingBox()).x >= 0) note('phone', 'tapping away did not close the rail');
    await page.close();
  }
} catch (err) {
  note('run', err.message);
} finally {
  await browser?.close();
  provider.close();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  process.stdout.write(`${failures.length} problem${failures.length === 1 ? '' : 's'}:\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write('pages: every check passed\n');
