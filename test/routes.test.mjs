import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

/**
 * The tidy page URLs.
 *
 * Built the same way the server builds them, because the bug worth pinning is
 * a one-word one: a redirect written as res.redirect('/work.html') drops the
 * query string, so every link that carries one arrives stripped and whatever it
 * asked for silently does not happen.
 */
const PAGES = ['setup', 'design', 'work', 'dashboard', 'plugins', 'artifacts'];

function app() {
  const a = express();
  for (const page of PAGES) {
    a.get(`/${page}`, (req, res) => {
      const query = req.originalUrl.slice(req.path.length);
      res.redirect(`/${page}.html${query}`);
    });
  }
  return a;
}

async function head(path) {
  const server = http.createServer(app());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: 'manual' });
  server.close();
  return { status: res.status, location: res.headers.get('location') };
}

test('a tidy page URL redirects to the file', async () => {
  for (const page of PAGES) {
    const { status, location } = await head(`/${page}`);
    assert.equal(status, 302);
    assert.equal(location, `/${page}.html`);
  }
});

test('the query string survives the redirect', async () => {
  // The rail sends /work?do=new-task from another page; losing the marker meant
  // arriving at a page that had forgotten what you clicked.
  assert.equal((await head('/work?do=new-task')).location, '/work.html?do=new-task');
  assert.equal((await head('/setup?tab=voice&x=1')).location, '/setup.html?tab=voice&x=1');
  assert.equal((await head('/plugins?q=a%20b')).location, '/plugins.html?q=a%20b');
});

test('a page with no query redirects without a stray question mark', async () => {
  assert.equal((await head('/dashboard')).location, '/dashboard.html');
});
