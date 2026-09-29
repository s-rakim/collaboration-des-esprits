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

/** A provider that answers like OpenAI, so a seat can really be exercised. */
const { createServer } = await import('node:http');
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'reply', arguments: JSON.stringify({ body: 'Understood.' }) } }] } }],
    model: body.model,
  }));
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const PROVIDER = `http://127.0.0.1:${provider.address().port}/v1`;

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
    // A live stream is cut off by navigation; that is the browser, not a fault.
    if (r.url().endsWith('/api/events') && r.failure()?.errorText === 'net::ERR_ABORTED') return;
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
    await row.$eval('.cm', (el) => { el.value = 'test-model'; });
    await row.$eval('.cs', (el) => { el.value = 'sk-not-a-real-key'; });
    await row.$eval('.cn', (el) => el.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(1200);

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
