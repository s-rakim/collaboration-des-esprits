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
// The stub checks the key, because a stub that accepts anything cannot tell the
// difference between the key somebody typed and the empty string — which is
// exactly the bug this file exists to catch.
const GOOD_KEY = 'sk-not-a-real-key';
const keysSeen = [];
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

  const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  keysSeen.push(key);
  if (key !== GOOD_KEY) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end('{"error":{"message":"Incorrect API key provided"}}');
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
    await page.click('#topbar [data-action]');
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
    await row.$eval('.cs', (el, k) => { el.value = k; }, GOOD_KEY);
    await row.$eval('.cn', (el) => el.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(1200);

    // Ask the endpoint what it wants, instead of making somebody guess twice.
    await page.click('.conn[data-conn="test provider"] .find');
    // Wait for the call to finish, whatever it concluded, rather than for one
    // particular wording — the wording is allowed to change.
    await page.waitForFunction(
      () => !/…$/.test((document.querySelector('#msg')?.textContent ?? '').trim()),
      null, { timeout: 25000 },
    );
    await page.waitForTimeout(600);

    const fixed = await page.inputValue('.conn[data-conn="test provider"] .cu');
    if (!fixed.endsWith('/v1')) note('setup', `"find" did not repair the base URL (left it at ${fixed})`);
    const list = await page.$$eval('.conn[data-conn="test provider"] datalist option', (o) => o.map((x) => x.value));
    if (!list.length) note('setup', '"find" did not offer the models the endpoint listed');
    // "Vendor Model A" is not something this endpoint has. It must not survive,
    // and an empty box is only the floor: a model the key was just proven on is
    // a better thing to leave behind than nothing to pick from.
    const left = await page.inputValue('.conn[data-conn="test provider"] .cm');
    if (left && !OFFERED.includes(left)) {
      note('setup', `a model the endpoint does not have was kept: ${left}`);
    }

    // Listing models often needs no key, so finding the endpoint must not be
    // reported as being able to use it.
    const verdict = (await page.textContent('#msg')).trim();
    if (!/the key works/i.test(verdict)) note('setup', `"find" did not check the key: ${verdict}`);

    // Picking one from the list must actually work.
    await page.fill('.conn[data-conn="test provider"] .cm', list[0] ?? 'nothing');
    await page.dispatchEvent('.conn[data-conn="test provider"] .cm', 'change');
    await page.waitForTimeout(1000);

    const saved = await page.evaluate(async () => (await (await fetch('/api/connections')).json()).connections);
    const mine = saved.find((c) => c.name === 'test provider');
    if (!mine) note('setup', 'the connection was not saved');
    else if (!mine.keySet) note('setup', 'the key was not stored');
    if (JSON.stringify(saved).includes(GOOD_KEY)) note('setup', 'the raw key was sent back to the page');

    // ------------------------------------------ pasting a provider's example
    //
    // The way in. Four boxes typed one at a time is four chances to get
    // something subtly wrong — a truncated key, a model id off a different
    // vendor's page, a base URL missing its /v1 — and not one of them
    // announces itself. So the box has to actually build a working row.
    {
      await page.fill('#snipName', 'from the docs');
      await page.fill('#snipText', [
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        `  base_url = "${PROVIDER}/v1",`,
        `  api_key = "${GOOD_KEY}"`,
        ')',
        '',
        'completion = client.chat.completions.create(',
        '  model="vendor/model-b-instruct",',
        '  max_tokens=4096,',
        ')',
      ].join('\n'));
      await page.click('#fromSnippet');
      await page.waitForFunction(
        () => !/…$/.test((document.querySelector('#msg')?.textContent ?? '').trim()),
        null, { timeout: 25000 },
      ).catch(() => {});
      await page.waitForTimeout(800);

      const made = await page.evaluate(async () =>
        (await (await fetch('/api/connections')).json()).connections.find((c) => c.name === 'from the docs'));
      if (!made) note('setup', 'pasting an example built no connection');
      else {
        if (!made.baseURL.endsWith('/v1')) note('setup', `the address did not come across: ${made.baseURL}`);
        if (made.model !== 'vendor/model-b-instruct') note('setup', `the model did not come across: ${made.model}`);
        if (!made.keySet) note('setup', 'the key did not come across');
        // The one thing no amount of looking at the URL can settle, and the one
        // that silently uncaps the request when it is wrong.
        if (made.extra?.tokenParam !== 'max_tokens') note('setup', 'it missed which length parameter that endpoint takes');
      }
      // Emptied once read, so the next paste starts clean.
      if (await page.inputValue('#snipText')) note('setup', 'the paste box was not cleared after a successful read');
    }

    // ------------------------------------- typing a key and pressing a button
    //
    // One gesture, two events. The key box saves on blur and that save is a
    // round trip, so pressing the button beside it used to send the call out
    // with whatever the server still had — nothing, on a new row. The key was
    // in the box, visibly accepted, and every provider said it was wrong. This
    // is what "no API key works" was, so it is checked with no pause anywhere:
    // the delays elsewhere in this file are what hid it.
    {
      keysSeen.length = 0;
      await page.click('#addConn');
      // Only the name is allowed to settle — naming a row redraws it, and the
      // race under test is the one between the key box and the button, not
      // between the name box and anything.
      await page.fill('.conn[data-new] .cn', 'in a hurry');
      await page.dispatchEvent('.conn[data-new] .cn', 'blur');
      await page.waitForSelector('.conn[data-conn="in a hurry"]', { timeout: 15000 });
      const fresh = '.conn[data-conn="in a hurry"]';
      await page.fill(`${fresh} .cu`, PROVIDER);
      // Typed and pressed with nothing in between, which is the whole point:
      // the save behind the key box starts, and the button fires before it can
      // possibly have finished. Any wait here hides the bug, which is how it
      // survived a suite that waited everywhere.
      await page.$eval(`${fresh}`, (row, k) => {
        const box = row.querySelector('.cs');
        box.value = k;
        box.dispatchEvent(new Event('change'));
        row.querySelector('.test').click();
      }, GOOD_KEY);
      await page.waitForFunction(
        () => !/…$/.test((document.querySelector('#msg')?.textContent ?? '').trim()),
        null, { timeout: 25000 },
      ).catch(() => {});
      await page.waitForTimeout(1200);

      const wrong = keysSeen.filter((k) => k !== GOOD_KEY);
      if (wrong.length) {
        note('setup', `a key was typed but ${JSON.stringify(wrong[0])} was sent to the provider`);
      }
      const said = (await page.textContent('#msg')).trim();
      if (/refused|rejected|no API key/i.test(said)) {
        note('setup', `typing a key then pressing "test" reported: ${said}`);
      }
      // No model was set, so the test had to go and find one rather than refuse.
      const hurried = await page.evaluate(async () =>
        (await (await fetch('/api/connections')).json()).connections.find((c) => c.name === 'in a hurry'));
      if (!hurried?.model) {
        // The likeliest cause by far is the race above: with the key still
        // unsaved the test is refused before it can ask the endpoint anything,
        // and nothing is found because nothing was looked for.
        note('setup', '"test" on a freshly typed row found no model — the key probably'
          + ' had not saved before the button fired');
      }
    }

    // The keys typed above were only ever saved as connections. Each one has
    // to have put an agent in the chat by itself: finding the second half of
    // this page and attaching a seat by hand was the step people never took,
    // and a room with working keys and nobody in it is what they got.
    await page.reload({ waitUntil: 'networkidle' });
    const seats = await page.evaluate(async () => (await (await fetch('/api/seats')).json()).seats);
    const keyed = await page.evaluate(async () =>
      (await (await fetch('/api/connections')).json()).connections.filter((c) => c.kind === 'chat' && c.keySet).map((c) => c.name));
    for (const name of keyed) {
      const on = seats.find((x) => x.connection === name);
      if (!on) note('setup', `the key "${name}" was saved but nothing in the chat is using it`);
      else if (!on.running) note('setup', `${on.name} has a seat on "${name}" but is not in the chat`);
    }
    if (seats.some((x) => !x.connection)) note('setup', 'a seat with no connection is still listed after keys were added');
    const first = seats[0];
    if (!first?.running) note('setup', 'the first seat did not start');

    // And the note under the seats says so in words.
    const seatNote = (await page.textContent('#seatNote')).trim();
    if (!/^[1-9]\d* in the chat/.test(seatNote)) note('setup', `the seat note does not say who is in the chat: "${seatNote}"`);

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
    const roster = await (await fetch(`${BASE}/api/seats`)).json();
    const addressed = roster.seats.find((x) => x.running)?.name ?? 'nobody';
    await fetch(`${BASE}/api/post`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // Typed in capitals, as people do: the name still has to reach its agent.
      body: JSON.stringify({ as: 'rakim', body: `@${addressed.toUpperCase()} are you there?` }),
    });
    let replied = false;
    for (let i = 0; i < 40 && !replied; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const feed = await (await fetch(`${BASE}/api/feed?since=0`)).json();
      replied = feed.messages.some((m) => m.author === addressed);
    }
    if (!replied) note('room', 'a configured model never answered a message addressed to it');
  }

  // ---------------------------------------------------------- every page loads

  for (const path of ['/', '/dashboard', '/plugins', '/work', '/threads', '/design', '/artifacts', '/setup', '/pc']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(page, path);
    await page.goto(BASE + path, { waitUntil: 'networkidle' });

    // One bar across the top, on every page: the six tabs, and nothing down the side.
    const box = await (await page.$('#topbar'))?.boundingBox();
    if (!box) note(path, 'no top bar');
    else {
      if (box.y !== 0 || box.x !== 0) note(path, `the bar is not at the top of the page (${box.x}, ${box.y})`);
      if (box.height > 64) note(path, `the bar is ${box.height}px tall — the tabs have wrapped`);
    }
    if (await page.$('#shell-rail')) note(path, 'there is still a rail down the side');
    const tabs = await page.$$eval('#topbar .tabs a.tab', (a) => a.map((x) => ({ label: x.textContent.trim(), top: Math.round(x.getBoundingClientRect().top), on: x.classList.contains('on') })));
    if (tabs.map((t) => t.label).join() !== "Chat,Threads,Agents' PC,Work,Artifacts,Setup") note(path, `the tabs are ${tabs.map((t) => t.label).join() || 'missing'}`);
    if (new Set(tabs.map((t) => t.top)).size > 1) note(path, 'the tabs are not on one row');
    const lit = tabs.filter((t) => t.on).length + (await page.$$eval('#topbar [data-menu="more"].on', (b) => b.length));
    if (lit !== 1) note(path, `${lit} tabs are marked as the page you are on`);
    // Everything that is not a tab is one click away, under More.
    await page.click('#topbar [data-menu="more"]');
    const more = await page.$$eval('#menu-more a', (a) => a.filter((x) => x.offsetParent).length);
    if (more < 6) note(path, `More lists only ${more} places`);
    await page.keyboard.press('Escape');
    if (await page.isVisible('#menu-more')) note(path, 'Escape did not put the More menu away');
    // The page is not wider than the window: nothing scrolls sideways.
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (wide > 1) note(path, `the page is ${wide}px wider than the window`);


    // The terminal and the browser belong to the project, not to one tab: both
    // have to open from the rail wherever you are, the chat included.
    // The window remembers where it was left, and these pages share that memory;
    // each is checked from where a window starts, not from where the last one was dragged to.
    // The desktop arrives with its explorer open; put it away so each window is checked on its own.
    if (path === '/pc') {
      if (!(await page.waitForSelector('#explorer.open', { state: 'visible', timeout: 4000 }).catch(() => null))) note(path, 'the desktop did not arrive with the explorer open');
      else await page.click('#explorer .tbar .x');
      if ((await page.$$('#apps [data-app]')).length < 6) note(path, 'the desktop is missing its programs');
      if ((await page.$$('#tasks [data-task]')).length < 6) note(path, 'the desktop has no taskbar');
    }
    await page.evaluate(() => { localStorage.removeItem('esprits.terminal'); localStorage.removeItem('esprits.term'); });
    await page.click('#edge-tabs [data-tool="terminal"]');
    // A terminal with no tabs asks which command line you want, and offers the PC's own among the others.
    const asked = await page.waitForSelector('#tools.open #tPick [data-pick="pc"]', { state: 'visible', timeout: 4000 }).catch(() => null);
    if (!asked) note(path, 'opening the terminal did not ask which shell');
    else {
      const offered = await page.$$eval('#tPick [data-pick]', (b) => b.map((x) => x.dataset.pick));
      for (const want of ['pc', 'ubuntu', 'kali', 'mac', 'gitbash', 'powershell', 'cmd']) if (!offered.includes(want)) note(path, `the terminal does not offer ${want}`);
      if (await page.isVisible('#tCmd')) note(path, 'there is a prompt before a shell has been chosen');
      await page.click('#tPick [data-pick="pc"]');
    }
    const opened = await page.waitForSelector('#tools.open #tCmd', { state: 'visible', timeout: 4000 }).catch(() => null);
    if (!opened) note(path, 'the terminal did not open from the rail');
    else {
      // A new tab is a blank page: the prompt, with where it is standing, and nothing else.
      if ((await page.textContent('#tOut')).trim()) note(path, 'a new terminal tab is not blank');
      if (!/[$>%]\s*$/.test(await page.textContent('#tPs'))) note(path, `the prompt does not look like one ("${await page.textContent('#tPs')}")`);
      // More tabs, of any kind, as many as wanted — and each can be closed.
      await page.click('#wAdd');
      await page.click('#wAdd');
      if ((await page.$$('#wTabs .wtab')).length !== 3) note(path, 'adding tabs did not add tabs');
      await page.click('#wTabs .wtab:last-child [data-shut]');
      await page.click('#wTabs .wtab:last-child [data-shut]');
      if ((await page.$$('#wTabs .wtab')).length !== 1) note(path, 'closing tabs did not close them');
      await page.click('#wTabs .wtab');
      if (!(await page.isVisible('#tCmd'))) note(path, 'going back to the first tab did not bring its prompt back');
      if (!(await page.$('#tools .popout'))) note(path, 'the terminal has no way to pop out into its own window');
      // The terminal is a window: it floats over the page rather than taking a column of it, and it moves.
      await page.waitForTimeout(260);       // it arrives with a short animation; measure it once it has landed
      const before = await (await page.$('#tools')).boundingBox();
      if (before.width > 1000 || before.height > 700) note(path, `the terminal is not a window (${Math.round(before.width)}×${Math.round(before.height)})`);
      await page.mouse.move(before.x + before.width / 2, before.y + 14);
      await page.mouse.down();
      await page.mouse.move(before.x + before.width / 2 - 180, before.y + 14 - 120, { steps: 6 });
      await page.mouse.up();
      const after = await (await page.$('#tools')).boundingBox();
      if (Math.abs(after.x - (before.x - 180)) > 4 || Math.abs(after.y - (before.y - 120)) > 4) {
        note(path, `the terminal window did not follow a drag (moved ${Math.round(after.x - before.x)}, ${Math.round(after.y - before.y)})`);
      }
      // And it is found again where it was left.
      const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('esprits.terminal') ?? 'null'));
      if (!kept || Math.abs(kept.x - after.x) > 2) note(path, 'the terminal window does not remember where it was put');
    }
    // What was made, and the way out of the sandbox, are a tab of the same window.
    await page.click('#tools [data-tab="files"]');
    await page.waitForTimeout(400);
    if (!(await page.isVisible('#tools #fCopy'))) note(path, 'the files and export tab did not open from the rail');
    const state = (await page.textContent('#tools #fWhere .state').catch(() => '')) ?? '';
    if (!/sandboxed|no sandbox|getting ready|linked folder/.test(state)) note(path, `the window does not say whether work is sandboxed (it says "${state}")`);

    // The browser is a window too: small, over the page, and it moves.
    await page.evaluate(() => localStorage.removeItem('esprits.browser'));
    const tab = await page.$('#edge-tabs [data-tool="browser"]');
    if (!tab) note(path, 'there are no tabs on the right-hand edge');
    else {
      const tabBox = await tab.boundingBox();
      const wide = await page.evaluate(() => innerWidth);
      if (Math.abs(tabBox.x + tabBox.width - wide) > 1) note(path, 'the tabs are not on the right-hand edge');
      if (tabBox.height < tabBox.width) note(path, 'the edge tabs are not vertical');
      const pageBefore = await (await page.$('#shell-page')).boundingBox();
      await tab.click();
      await page.waitForTimeout(320);
      if (!(await page.isVisible('#dock #bGo'))) note(path, 'the browser did not open from its edge tab');
      else {
        const win = await (await page.$('#dock')).boundingBox();
        if (win.width > 800 || win.height > 650) note(path, `the browser is not a small window (${Math.round(win.width)}×${Math.round(win.height)})`);
        const pageAfter = await (await page.$('#shell-page')).boundingBox();
        if (Math.abs(pageAfter.width - pageBefore.width) > 1) note(path, 'opening the browser changed the width of the page');
        await page.mouse.move(win.x + win.width - 60, win.y + 6);
        await page.mouse.down();
        await page.mouse.move(win.x + win.width - 60 - 150, win.y + 6 + 90, { steps: 6 });
        await page.mouse.up();
        const moved = await (await page.$('#dock')).boundingBox();
        if (Math.abs(moved.x - (win.x - 150)) > 4 || Math.abs(moved.y - (win.y + 90)) > 4) {
          note(path, `the browser window did not follow a drag (moved ${Math.round(moved.x - win.x)}, ${Math.round(moved.y - win.y)})`);
        }
        if (!(await page.$eval('#edge-tabs [data-tool="browser"]', (b) => b.classList.contains('on')))) note(path, 'the browser tab does not show that it is open');
        await page.click('#edge-tabs [data-tool="browser"]');
        await page.waitForTimeout(150);
        if (await page.isVisible('#dock')) note(path, 'pressing the browser tab again did not put the window away');
      }
    }

    // The Agents' PC is a window of its own on every page, and so is its file explorer.
    for (const [tool, win] of [['pc', '#pcwin'], ['explorer', '#explorer']]) {
      await page.evaluate((w) => localStorage.removeItem(`esprits.win.${w.slice(1)}`), win);
      if (await page.isVisible(win)) await page.click(`#edge-tabs [data-tool="${tool}"]`);
      await page.click(`#edge-tabs [data-tool="${tool}"]`);
      const up = await page.waitForSelector(`${win}.open`, { state: 'visible', timeout: 4000 }).catch(() => null);
      if (!up) { note(path, `the ${tool} window did not open from its edge tab`); continue; }
      await page.waitForTimeout(260);
      await page.evaluate((w) => document.querySelector(w).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), win);
      const was = await (await page.$(win)).boundingBox();
      await page.mouse.move(was.x + 60, was.y + 14);
      await page.mouse.down();
      await page.mouse.move(was.x + 60 - 90, was.y + 14 + 70, { steps: 6 });
      await page.mouse.up();
      const now = await (await page.$(win)).boundingBox();
      if (Math.abs(now.x - (was.x - 90)) > 4 || Math.abs(now.y - (was.y + 70)) > 4) note(path, `the ${tool} window did not follow a drag`);
      await page.click(`${win} .tbar .x`);
      if (await page.isVisible(win)) note(path, `the ${tool} window did not close`);
    }
    if ((await page.textContent('#topbar .brand')).trim() !== 'Esprits') note(path, 'the bar does not carry the name Esprits');
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
      await page.click('#topbar [data-action]');
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
    // On a phone the bar keeps its tabs as icons, on one row, and the page still fits.
    const bar = await (await page.$('#topbar')).boundingBox();
    if (bar.height > 64) note('phone', `the bar is ${bar.height}px tall on a phone`);
    if ((await page.$$eval('#topbar .tabs a.tab', (a) => a.length)) !== 6) note('phone', 'the tabs are not all there on a phone');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (over > 1) note('phone', `the page is ${over}px wider than the phone`);
    await page.click('#topbar [data-menu="ideas"]');
    if (!(await page.isVisible('#menu-ideas'))) note('phone', 'the ideas menu did not open');
    const menu = await (await page.$('#menu-ideas')).boundingBox();
    if (menu.x < 0 || menu.x + menu.width > 421) note('phone', 'the ideas menu runs off the screen');
    await page.mouse.click(60, 600);
    if (await page.isVisible('#menu-ideas')) note('phone', 'tapping away did not close the menu');
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
